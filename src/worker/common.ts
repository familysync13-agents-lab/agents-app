import type { TaskState } from "@/db/schema";
import type { Job, TaskCtx } from "./context";

export const PROTECTED = ["oracle/**", "baselines/**", "tasks/**", ".github/**", "CODEOWNERS", "gate/**", "policy.json"];
export const MAX_INFRA_RETRIES = 3;

/** Names of the executor-side volumes of a task (all prefixed "agents-" so the executor can scope what the app may touch). */
export const vols = (taskId: number) => ({
  worktree: `agents-wt-${taskId}`,
  export: `agents-ex-${taskId}`,
  final: `agents-fin-${taskId}`,
  verifier: (tag: string) => `agents-vw-${taskId}-${tag}`,
});

export const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
export const unb64 = (s: unknown) => (typeof s === "string" ? Buffer.from(s, "base64").toString("utf8") : null);

/** Throttle polling: true when the step may submit its next poll job. */
export async function pollDue(ctx: TaskCtx, seconds: number): Promise<boolean> {
  const at = ctx.data.pollAt as number | undefined;
  const now = ctx.now().getTime();
  if (at !== undefined && now < at) return false;
  await ctx.setData({ pollAt: now + seconds * 1000 });
  return true;
}

/**
 * Executor-side failure (harness, not the application): retried automatically; after MAX_INFRA_RETRIES the task blocks on
 * evidence with the harness reason, and the failure is never counted against the worker (bake-off lesson 12).
 * Returns true when the caller should just wait (a retry was scheduled or the task was blocked).
 */
export async function harnessFailure(ctx: TaskCtx, job: Job, key: string, what: string): Promise<void> {
  const n = ctx.task.infraRetries + 1;
  await ctx.log("executor", `${what} failed in the executor (harness): ${String(job.error ?? "").slice(0, 300)}`, { job: job.id });
  if (n <= MAX_INFRA_RETRIES) {
    await ctx.save({ infraRetries: n });
    await ctx.forget(key);
    return;
  }
  await blockEvidence(ctx, `${what} failed ${n} times in the executor (infrastructure, not the work): ${String(job.error ?? "").slice(0, 200)}`, {
    job: job.id,
  });
}

export async function blockEvidence(ctx: TaskCtx, reason: string, fact: Record<string, unknown>) {
  const resumeState = ctx.task.state;
  const resumeStep = ctx.task.step;
  // state first: a decision is only ever opened for a task that is actually blocked
  await ctx.transition("BLOCKED_EVIDENCE", reason, fact, { resumeState: resumeState as TaskState, infraRetries: 0 });
  await ctx.openDecision({
    kind: "block",
    title: "Blocked: evidence unavailable",
    why: reason,
    options: [
      { id: "retry", label: "Retry", consequence: "The control system repeats the failed step." },
      { id: "abandon", label: "Abandon the task", consequence: "The task ends; nothing is merged." },
    ],
    recommendation: "retry",
    context: { stage: "evidence", resumeStep, resumeState },
  });
  await ctx.goto("await_decision", {});
}

/** Result of a transport job: the named sub-operation's result. */
export function sub(job: Job, id: string): Record<string, unknown> | undefined {
  return (job.result?.[id] as Record<string, unknown> | undefined) ?? undefined;
}

export function mainSha(job: Job, repo: string): string | undefined {
  const refs = job.result?.[`ls:${repo}`] as Record<string, string> | undefined;
  return refs?.["refs/heads/main"];
}

/** Does the latest decisive review of the owner approve exactly this head? */
export function ownerApproved(pr: Record<string, unknown> | undefined, owner: string, head: string): { ok: boolean; at?: string } {
  const reviews = (pr?.reviews as { user?: string; state?: string; commit?: string; at?: string }[] | null) ?? [];
  const mine = reviews
    .filter((r) => (r.user ?? "").toLowerCase() === owner.toLowerCase() && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state ?? ""))
    .sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? -1 : 1));
  const last = mine.at(-1);
  return last && last.state === "APPROVED" && last.commit === head ? { ok: true, at: last.at } : { ok: false };
}

export function ownerRequestedChanges(pr: Record<string, unknown> | undefined, owner: string, head: string): boolean {
  const reviews = (pr?.reviews as { user?: string; state?: string; commit?: string; at?: string }[] | null) ?? [];
  const mine = reviews
    .filter((r) => (r.user ?? "").toLowerCase() === owner.toLowerCase() && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state ?? ""))
    .sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? -1 : 1));
  const last = mine.at(-1);
  return !!last && last.state === "CHANGES_REQUESTED" && last.commit === head;
}

/** The latest completed gate run for a head (from the executor's pr_state facts). */
export function latestGate(pr: Record<string, unknown> | undefined): { id: number; verdict: string | null; status: string } | undefined {
  const runs = (pr?.gate_runs as { id: number; status: string; verdict?: string | null }[] | null) ?? [];
  if (runs.length === 0) return undefined;
  const latest = runs.reduce((a, b) => (a.id > b.id ? a : b));
  return { id: latest.id, status: latest.status, verdict: latest.verdict ?? null };
}
