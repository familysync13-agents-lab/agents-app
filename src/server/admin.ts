import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { activity, adminActions, decisions, executorJobs, runs, tasks, transitions, type TaskState } from "@/db/schema";
import { BLOCKED, canTransition, TERMINAL } from "@/domain/lifecycle";

/*
 * Audited administrative operations - the replacement for raw database repair (V0 needed app_sql three times: stopping a wrongly
 * started worker, re-opening a decision that had been wrongly applied, resetting a correction budget charged for oracle defects).
 * Each operation is narrow and typed, validates the task's state, records actor / reason / time / before / after in admin_actions and
 * the task timeline, and REFUSES (also recorded) anything outside its preconditions. There is no generic "set state" operation.
 */
export const AdminOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pause"), taskId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("resume"), taskId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("stop_run"), taskId: z.number().int(), runId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("retry_blocked"), taskId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("recheck_gate"), taskId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("retry_step"), taskId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("reset_budget"), taskId: z.number().int(), reason: z.string().min(8).max(2000) }),
  z.object({ op: z.literal("reopen_decision"), taskId: z.number().int(), decisionId: z.number().int(), reason: z.string().min(8).max(2000) }),
]);
export type AdminOp = z.infer<typeof AdminOp>;

export const ADMIN_OPS: Record<AdminOp["op"], { label: string; help: string }> = {
  pause: { label: "Pause the task", help: "The control loop stops advancing this task (running worker sessions finish on their own)." },
  resume: { label: "Resume the task", help: "The control loop continues from the step where the task was paused." },
  stop_run: { label: "Stop a worker session", help: "Kills a running Builder/Verifier session by name and records the run as aborted." },
  retry_blocked: { label: "Retry an infrastructure block", help: "Answers an open 'evidence unavailable' block with Retry (only infrastructure blocks; never product or security decisions)." },
  recheck_gate: { label: "Re-evaluate the latest gate result", help: "Returns a task with an open PR to reading the gate's latest verdict for its current head (failure routing runs again). No state is invented." },
  retry_step: { label: "Retry the current step", help: "Forgets the current step's cached executor results so the step runs again (harness recovery)." },
  reset_budget: { label: "Reset the correction budget", help: "Sets the task's correction count to 0 (e.g. when corrections were caused by check defects)." },
  reopen_decision: { label: "Re-open a decision", help: "A decision that was applied or superseded wrongly is re-opened as a fresh open decision; the task waits for it." },
};

export class AdminRefused extends Error {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function runAdmin(db: Db, actor: string, input: unknown): Promise<{ ok: true; id: number; after: Record<string, unknown> } | { ok: false; id: number; refusal: string }> {
  const parsed = AdminOp.safeParse(input);
  if (!parsed.success) {
    const [r] = await db
      .insert(adminActions)
      .values({ actor, op: String((input as { op?: unknown })?.op ?? "?"), taskId: null, target: {}, reason: String((input as { reason?: unknown })?.reason ?? ""), outcome: "refused", refusal: `invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` })
      .returning({ id: adminActions.id });
    return { ok: false, id: r!.id, refusal: "invalid request" };
  }
  const a = parsed.data;
  try {
    return await db.transaction(async (tx) => {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, a.taskId)).for("update");
      if (!t) throw new AdminRefused("no such task");
      const before = { state: t.state, step: t.step, corrections: t.corrections, pausedAt: t.pausedAt, stepKeys: Object.keys(t.stepData ?? {}) };
      const after = await apply(tx, a, t);
      const [r] = await tx
        .insert(adminActions)
        .values({ actor, op: a.op, taskId: a.taskId, target: target(a), reason: a.reason, before, after, outcome: "applied" })
        .returning({ id: adminActions.id });
      await tx.insert(activity).values({ taskId: a.taskId, actor: "system", message: `Admin (${actor}): ${ADMIN_OPS[a.op].label} - ${a.reason}`.slice(0, 1000), ref: { admin_action: r!.id, ...after } });
      return { ok: true as const, id: r!.id, after };
    });
  } catch (e) {
    if (!(e instanceof AdminRefused)) throw e;
    const [r] = await db
      .insert(adminActions)
      .values({ actor, op: a.op, taskId: a.taskId, target: target(a), reason: a.reason, outcome: "refused", refusal: e.message })
      .returning({ id: adminActions.id });
    return { ok: false, id: r!.id, refusal: e.message };
  }
}

function target(a: AdminOp): Record<string, unknown> {
  if (a.op === "stop_run") return { run: a.runId };
  if (a.op === "reopen_decision") return { decision: a.decisionId };
  return {};
}

async function apply(tx: Tx, a: AdminOp, t: typeof tasks.$inferSelect): Promise<Record<string, unknown>> {
  const terminal = (TERMINAL as readonly string[]).includes(t.state);
  switch (a.op) {
    case "pause": {
      if (terminal) throw new AdminRefused(`task is ${t.state}`);
      if (t.pausedAt) throw new AdminRefused("task is already paused");
      await tx.update(tasks).set({ pausedAt: new Date(), pausedReason: a.reason }).where(eq(tasks.id, t.id));
      return { paused: true };
    }
    case "resume": {
      if (!t.pausedAt) throw new AdminRefused("task is not paused");
      await tx.update(tasks).set({ pausedAt: null, pausedReason: null }).where(eq(tasks.id, t.id));
      return { paused: false };
    }
    case "stop_run": {
      const [r] = await tx.select().from(runs).where(and(eq(runs.id, a.runId), eq(runs.taskId, t.id)));
      if (!r) throw new AdminRefused("run does not belong to this task");
      if (r.status !== "running") throw new AdminRefused(`run is ${r.status}, not running`);
      if (!r.container) throw new AdminRefused("run has no session to stop");
      await tx.insert(executorJobs).values({ taskId: t.id, op: "session", params: { name: r.container, kill: true } });
      await tx.update(runs).set({ status: "finished", outcome: "aborted", finishedAt: new Date() }).where(eq(runs.id, r.id));
      return { run: r.id, container: r.container, stopped: true };
    }
    case "retry_blocked": {
      if (t.state !== "BLOCKED_EVIDENCE" || t.step !== "await_decision") throw new AdminRefused("task is not waiting on an evidence block");
      const [d] = await tx.select().from(decisions).where(and(eq(decisions.id, Number((t.stepData as { awaiting?: number }).awaiting)), eq(decisions.taskId, t.id)));
      if (!d || d.status !== "open" || d.kind !== "block") throw new AdminRefused("no open block decision is awaited");
      if (String((d.context as { stage?: string }).stage) !== "evidence" || !d.options.some((o) => o.id === "retry")) throw new AdminRefused("only infrastructure (evidence) blocks can be retried by an operator");
      await tx.update(decisions).set({ status: "decided", choice: "retry", decidedVia: "app", decidedAt: new Date(), note: `operator retry (admin): ${a.reason}`.slice(0, 2000) }).where(eq(decisions.id, d.id));
      return { decision: d.id, choice: "retry" };
    }
    case "recheck_gate": {
      if (terminal) throw new AdminRefused(`task is ${t.state}`);
      if (!t.prNumber || !t.headSha) throw new AdminRefused("task has no open PR head to re-evaluate");
      if (t.state === "BLOCKED_DECISION") {
        // only a Builder block raised while correcting a gate failure may be set aside this way (never an owner product question
        // from contract drafting, a budget or a security stop)
        const [od] = await tx.select().from(decisions).where(and(eq(decisions.taskId, t.id), eq(decisions.status, "open")));
        if (!od || od.kind !== "block" || String((od.context as { stage?: string }).stage) !== "build") throw new AdminRefused("the open decision is not a Builder block from a gate correction");
      } else if (t.state !== "VERIFYING" && t.state !== "BLOCKED_EVIDENCE") throw new AdminRefused(`task is ${t.state}, not VERIFYING or blocked`);
      const running = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, t.id), eq(runs.status, "running")));
      if (running.length) throw new AdminRefused(`worker run(s) ${running.map((r) => r.id).join(", ")} still running - stop them first`);
      if (t.state !== "VERIFYING") {
        await tx.update(decisions).set({ status: "superseded" }).where(and(eq(decisions.taskId, t.id), eq(decisions.status, "open")));
        await tx.insert(transitions).values({ taskId: t.id, fromState: t.state, toState: "VERIFYING", reason: `Gate result re-evaluated by an audited admin operation: ${a.reason}`.slice(0, 500), fact: { admin: "recheck_gate", head: t.headSha } });
      }
      await tx.update(tasks).set({ state: "VERIFYING", step: "await_gate", stepData: { head: t.headSha, since: Date.now() } }).where(eq(tasks.id, t.id));
      return { step: "await_gate", head: t.headSha };
    }
    case "retry_step": {
      if (terminal) throw new AdminRefused(`task is ${t.state}`);
      if (t.step === "await_decision") throw new AdminRefused("the task waits for an owner decision; decide it (or re-open it) instead");
      await tx.update(tasks).set({ stepData: {}, infraRetries: 0 }).where(eq(tasks.id, t.id));
      return { step: t.step, retried: true };
    }
    case "reset_budget": {
      if (terminal) throw new AdminRefused(`task is ${t.state}`);
      if (t.corrections === 0) throw new AdminRefused("the correction count is already 0");
      await tx.update(tasks).set({ corrections: 0, extraCorrections: 0 }).where(eq(tasks.id, t.id));
      return { corrections: 0, previous: t.corrections };
    }
    case "reopen_decision": {
      const [d] = await tx.select().from(decisions).where(and(eq(decisions.id, a.decisionId), eq(decisions.taskId, t.id)));
      if (!d) throw new AdminRefused("decision does not belong to this task");
      if (!["block", "budget"].includes(d.kind)) throw new AdminRefused(`only block/budget decisions can be re-opened (this is ${d.kind})`);
      if (d.status === "open") throw new AdminRefused("decision is already open");
      if (terminal) throw new AdminRefused(`task is ${t.state}`);
      const running = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, t.id), eq(runs.status, "running")));
      if (running.length) throw new AdminRefused(`worker run(s) ${running.map((r) => r.id).join(", ")} still running - stop them first`);
      const [newest] = await tx.select().from(decisions).where(eq(decisions.taskId, t.id)).orderBy(desc(decisions.id)).limit(1);
      if (newest && newest.id !== d.id && newest.status === "open") throw new AdminRefused("another decision is open for this task");
      const to: TaskState = d.kind === "budget" ? "BLOCKED_DECISION" : String((d.context as { stage?: string }).stage) === "evidence" ? "BLOCKED_EVIDENCE" : "BLOCKED_DECISION";
      if (!canTransition(t.state, to) && !(BLOCKED as readonly string[]).includes(t.state)) throw new AdminRefused(`cannot block a task in ${t.state}`);
      const [n] = await tx
        .insert(decisions)
        .values({ taskId: t.id, kind: d.kind, title: d.title, why: d.why, options: d.options, recommendation: d.recommendation, context: { ...d.context, reopenedFrom: d.id }, status: "open" })
        .returning({ id: decisions.id });
      await tx.insert(transitions).values({ taskId: t.id, fromState: t.state, toState: to, reason: `Decision ${d.id} re-opened by an audited admin operation: ${a.reason}`.slice(0, 500), fact: { admin: "reopen_decision", decision: d.id, reopened_as: n!.id } });
      await tx.update(tasks).set({ state: to, step: "await_decision", stepData: { awaiting: n!.id }, stateReason: d.title }).where(eq(tasks.id, t.id));
      return { decision: n!.id, state: to };
    }
  }
}
