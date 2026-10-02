import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  activity,
  artifacts,
  decisions,
  evidence,
  executorJobs,
  projects,
  runs,
  tasks,
  transitions,
  type TaskState,
} from "@/db/schema";
import { sha256 } from "@/domain/contract";
import { canTransition } from "@/domain/lifecycle";

export type Task = typeof tasks.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Job = typeof executorJobs.$inferSelect;
export type Run = typeof runs.$inferSelect;

/** Everything a step may touch. All writes go through here so that every state change is recorded with its fact. */
export class TaskCtx {
  constructor(
    readonly db: Db,
    public task: Task,
    readonly project: Project,
    readonly now: () => Date = () => new Date(),
  ) {}

  get data(): Record<string, unknown> {
    return this.task.stepData ?? {};
  }

  async save(patch: Partial<typeof tasks.$inferInsert>): Promise<void> {
    const [t] = await this.db
      .update(tasks)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(tasks.id, this.task.id))
      .returning();
    if (t) this.task = t;
  }

  /** Move to another step; step data is replaced (each step starts clean unless data is carried explicitly). */
  /** id of the decision most recently opened in this tick: await_decision is bound to exactly that decision */
  private opened: number | undefined;

  async goto(step: string, data: Record<string, unknown> = {}): Promise<void> {
    if (step === "await_decision") {
      const awaiting = (data.awaiting as number | undefined) ?? this.opened;
      if (awaiting === undefined) throw new Error("await_decision needs the decision it waits for");
      data = { ...data, awaiting };
    }
    await this.save({ step, stepData: data });
  }

  async setData(patch: Record<string, unknown>): Promise<void> {
    await this.save({ stepData: { ...this.data, ...patch } });
  }

  async transition(to: TaskState, reason: string, fact: Record<string, unknown>, extra: Partial<typeof tasks.$inferInsert> = {}) {
    const from = this.task.state;
    if (!canTransition(from, to)) throw new Error(`illegal transition ${from} -> ${to}`);
    if (!fact || Object.keys(fact).length === 0) throw new Error("a transition needs a mechanical fact");
    await this.db.insert(transitions).values({ taskId: this.task.id, fromState: from, toState: to, reason, fact });
    // decisions belong to the state that raised them: a state change supersedes every open one (the new state opens its own)
    if (from !== to)
      await this.db
        .update(decisions)
        .set({ status: "superseded" })
        .where(and(eq(decisions.taskId, this.task.id), eq(decisions.status, "open")));
    await this.save({ state: to, stateReason: reason, ...extra });
    await this.log("system", `${from === to ? "" : `${from} → ${to}: `}${reason}`, fact);
  }

  async log(actor: (typeof activity.$inferInsert)["actor"], message: string, ref?: Record<string, unknown>) {
    await this.db.insert(activity).values({ taskId: this.task.id, actor, message, ref: ref ?? null });
  }

  async submit(op: string, params: Record<string, unknown>): Promise<number> {
    const [j] = await this.db.insert(executorJobs).values({ taskId: this.task.id, op, params }).returning({ id: executorJobs.id });
    return j!.id;
  }

  async job(id: number): Promise<Job | undefined> {
    const [j] = await this.db.select().from(executorJobs).where(eq(executorJobs.id, id));
    return j;
  }

  /**
   * Submit a job once per step-data key and return it when finished. Returns null while queued/running.
   * An executor-side error is returned as-is (status "error") for the step to classify.
   */
  async once(key: string, op: string, params: () => Record<string, unknown>): Promise<Job | null> {
    let id = this.data[key] as number | undefined;
    if (id === undefined) {
      id = await this.submit(op, params());
      await this.setData({ [key]: id });
      return null;
    }
    const j = await this.job(id);
    if (!j || j.status === "queued" || j.status === "running") return null;
    return j;
  }

  async forget(...keys: string[]) {
    const d = { ...this.data };
    for (const k of keys) delete d[k];
    await this.save({ stepData: d });
  }

  async artifact(kind: string, name: string, content: string, workerAuthored = true): Promise<number> {
    const [a] = await this.db
      .insert(artifacts)
      .values({ taskId: this.task.id, kind, name, content, sha256: sha256(content), workerAuthored })
      .returning({ id: artifacts.id });
    return a!.id;
  }

  async evidence(e: Omit<typeof evidence.$inferInsert, "taskId">) {
    await this.db.insert(evidence).values({ ...e, taskId: this.task.id });
  }

  async openDecision(d: Omit<typeof decisions.$inferInsert, "taskId" | "status">): Promise<number> {
    await this.db
      .update(decisions)
      .set({ status: "superseded" })
      .where(and(eq(decisions.taskId, this.task.id), eq(decisions.status, "open"), eq(decisions.kind, d.kind)));
    const [r] = await this.db.insert(decisions).values({ ...d, taskId: this.task.id, status: "open" }).returning({ id: decisions.id });
    this.opened = r!.id;
    return r!.id;
  }

  async openDecisions() {
    return this.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.taskId, this.task.id), eq(decisions.status, "open")))
      .orderBy(desc(decisions.id));
  }

  async closeDecisions(kind: (typeof decisions.$inferInsert)["kind"], choice: string, via: "app" | "github", note?: string) {
    await this.db
      .update(decisions)
      .set({ status: "decided", choice, decidedVia: via, note: note ?? null, decidedAt: this.now() })
      .where(and(eq(decisions.taskId, this.task.id), eq(decisions.status, "open"), eq(decisions.kind, kind)));
  }

  async startRun(r: Omit<typeof runs.$inferInsert, "taskId">): Promise<number> {
    const [x] = await this.db.insert(runs).values({ ...r, taskId: this.task.id }).returning({ id: runs.id });
    return x!.id;
  }

  async updateRun(id: number, patch: Partial<typeof runs.$inferInsert>) {
    await this.db.update(runs).set(patch).where(eq(runs.id, id));
  }

  async run(id: number): Promise<Run | undefined> {
    const [r] = await this.db.select().from(runs).where(eq(runs.id, id));
    return r;
  }

  /** Is any Builder session of this project running (one Builder home per project: sessions are serialized)? */
  async builderBusy(): Promise<boolean> {
    const rows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(
        and(
          eq(tasks.projectId, this.project.id),
          eq(runs.role, "builder"),
          inArray(runs.status, ["starting", "running"]),
          ne(runs.taskId, this.task.id),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Deliberate serialization: another task of this project has unmerged work (building, verifying or awaiting acceptance). */
  async projectHasOpenWork(): Promise<boolean> {
    const rows = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, this.project.id),
          ne(tasks.id, this.task.id),
          or(
            inArray(tasks.state, ["IN_PROGRESS", "VERIFYING", "DONE"]),
            // a task that has claimed the build slot but whose session is still starting counts as open work
            and(eq(tasks.step, "build_start"), sql`(${tasks.stepData} ->> 'claimed') = 'true'`),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
