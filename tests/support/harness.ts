import { eq } from "drizzle-orm";
import { createDb, type Db } from "@/db/client";
import { migrate } from "@/db/migrate";
import { seedProjects } from "@/db/seed";
import { contracts, decisions, executorJobs, projects, tasks } from "@/db/schema";
import { tick } from "@/worker/orchestrator";

export const PROJECT = {
  slug: "reading-lists",
  name: "Shared Reading Lists",
  description: "A web app where users keep reading lists and share them read-only.",
  org: "acme",
  repo: "bakeoff-c1",
  ownerLogin: "Owner1",
  builderKey: "v0",
  stack: "Next.js 16 + TypeScript + Drizzle + PostgreSQL.",
  interfaceTasks: ["T2"],
  workerDocs: { "BOOK-API.md": "Book API test double at http://books:9100" },
  maxCorrections: 2,
};

export type Handler = (params: Record<string, unknown>, job: typeof executorJobs.$inferSelect) => Record<string, unknown> | Error;

/** In-process stand-in for the host executor: serves queued jobs with scripted results. */
export class FakeExecutor {
  log: { op: string; params: Record<string, unknown> }[] = [];
  constructor(
    readonly db: Db,
    public handlers: Record<string, Handler>,
  ) {}
  async drain() {
    const queued = await this.db.select().from(executorJobs).where(eq(executorJobs.status, "queued")).orderBy(executorJobs.id);
    for (const j of queued) {
      this.log.push({ op: j.op, params: j.params });
      const h = this.handlers[j.op];
      const r = h ? h(j.params, j) : new Error(`no handler for ${j.op}`);
      if (r instanceof Error) await this.db.update(executorJobs).set({ status: "error", error: r.message, finishedAt: new Date() }).where(eq(executorJobs.id, j.id));
      else await this.db.update(executorJobs).set({ status: "done", result: r, finishedAt: new Date() }).where(eq(executorJobs.id, j.id));
    }
    return queued.length;
  }
}

export async function setup() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify([PROJECT]));
  const [p] = await db.select().from(projects);
  return { db, project: p! };
}

export function clock(start = Date.parse("2026-10-01T10:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (s: number) => (t += s * 1000) };
}

/** Run the control loop and the fake executor until `until` holds or the step budget is exhausted. */
export async function runUntil(db: Db, ex: FakeExecutor, clk: ReturnType<typeof clock>, until: () => Promise<boolean>, max = 400) {
  for (let i = 0; i < max; i++) {
    if (await until()) return i;
    await tick(db, clk.now);
    await ex.drain();
    clk.advance(35);
  }
  const all = await db.select().from(tasks);
  throw new Error(`condition not reached: ${all.map((t) => `${t.id}:${t.key}:${t.state}:${t.step}:${JSON.stringify(t.stepData).slice(0, 160)}`).join(" | ")}`);
}

export async function taskRow(db: Db, id: number) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
  return t!;
}
export async function contractRows(db: Db, taskId: number) {
  return db.select().from(contracts).where(eq(contracts.taskId, taskId)).orderBy(contracts.version);
}
export async function openDecisions(db: Db, taskId: number) {
  const rows = await db.select().from(decisions).where(eq(decisions.taskId, taskId));
  return rows.filter((d) => d.status === "open");
}

/** The contract has been approved (by policy or by the owner) and is on its way into the repository. */
export async function contractApproved(db: Db, taskId: number) {
  return (await contractRows(db, taskId)).some((c) => ["approved_app", "pr_open", "merged"].includes(c.status));
}
export async function policyDecisions(db: Db, taskId: number) {
  const rows = await db.select().from(decisions).where(eq(decisions.taskId, taskId));
  return rows.filter((d) => d.decidedVia === "policy");
}
