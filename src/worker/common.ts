import { and, eq } from "drizzle-orm";
import { decisions, type TaskState } from "@/db/schema";
import { recoveryDelay } from "@/domain/policy";
import { BLOCKED } from "@/domain/lifecycle";
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
  if (String(job.error ?? "").includes("ACCESS:")) return accessBlock(ctx, key, what);
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

/**
 * A permission problem, not a transient failure: GitHub refuses the agent App a token for this repository. Retrying cannot help and is
 * never offered (V1 finding: the owner was asked to "Retry" the same failure eight times). The task waits in `await_access`, which
 * probes access by itself and resumes the moment access exists - no owner click in the app is needed.
 */
export async function accessBlock(ctx: TaskCtx, key: string, what: string) {
  const resumeState = ctx.task.state;
  const resumeStep = ctx.task.step;
  const data = { ...ctx.data };
  delete data[key];
  const url = `https://github.com/organizations/${ctx.project.org}/settings/installations`;
  if (!(BLOCKED as readonly string[]).includes(resumeState))
    await ctx.transition("BLOCKED_EVIDENCE", `GitHub permission missing: the agent App has no access to ${ctx.project.org}/${ctx.project.repo} (${what})`, { permission: "agent-app-repository-access", repo: ctx.project.repo });
  await ctx.openDecision({
    kind: "block",
    title: `GitHub permission needed: give the agent App access to ${ctx.project.repo}`,
    why: `GitHub refuses the agent App a token for ${ctx.project.org}/${ctx.project.repo}: its installation does not include this repository. Only you can grant it: open ${url} , choose Configure next to the agent App, add "${ctx.project.repo}" under Repository access and Save. Nothing needs to be clicked here afterwards - the control system checks every minute and continues by itself.`,
    options: [{ id: "abandon", label: "Abandon the task", consequence: "The task ends; nothing is merged." }],
    context: { stage: "access", url },
  });
  await ctx.log("system", `Waiting for GitHub access to ${ctx.project.repo} (checked every minute; resumes automatically).`, {});
  await ctx.save({ infraRetries: 0, step: "await_access", stepData: { resumeStep, resumeState: (BLOCKED as readonly string[]).includes(resumeState) ? (ctx.task.resumeState ?? "PROPOSED") : resumeState, resumeData: data, decision: ctx.lastOpened() } });
}

export async function awaitAccess(ctx: TaskCtx): Promise<void> {
  const [d] = await ctx.db.select().from(decisions).where(eq(decisions.id, Number(ctx.data.decision)));
  if (d?.status === "decided" && d.choice === "abandon") {
    await ctx.transition("ABANDONED", "Abandoned by the owner while waiting for GitHub access", { decision: d.id });
    return ctx.goto("done", {});
  }
  if (!("probe" in ctx.data) && !(await pollDue(ctx, 60))) return;
  const job = await ctx.once("probe", "access_check", () => ({ repo: ctx.project.repo }));
  if (!job) return;
  await ctx.forget("probe");
  if (job.status !== "done" || !job.result?.ok) return;
  await ctx.closeDecisions("block", "granted", "github", "access detected automatically");
  await ctx.transition(ctx.data.resumeState as TaskState, `GitHub access to ${ctx.project.repo} detected; continuing automatically`, { access_check: job.id });
  await ctx.goto(String(ctx.data.resumeStep), (ctx.data.resumeData as Record<string, unknown>) ?? {});
}

/**
 * A step cannot continue. Self-recovery first: the step is repeated automatically after a delay (twice per step, recorded as policy
 * decisions) - the owner is not a Retry button. Only when that is exhausted, or when repeating cannot help (`auto: false`: a
 * credential, a security stop, a fact that will not change), the task blocks and the owner is asked.
 */
export async function blockEvidence(ctx: TaskCtx, reason: string, fact: Record<string, unknown>, opts: { auto?: boolean } = {}) {
  const resumeState = ctx.task.state;
  const resumeStep = ctx.task.step;
  if (opts.auto !== false && !(BLOCKED as readonly string[]).includes(resumeState) && resumeStep !== "self_recover") {
    const prior = await ctx.db.select({ id: decisions.id, context: decisions.context }).from(decisions).where(and(eq(decisions.taskId, ctx.task.id), eq(decisions.decidedVia, "policy")));
    const used = prior.filter((d) => (d.context as { stage?: string; resumeStep?: string }).stage === "recovery" && (d.context as { resumeStep?: string }).resumeStep === resumeStep).length;
    const delay = recoveryDelay(used);
    if (delay !== null) {
      await ctx.policyDecision(
        { kind: "block", title: `Self-recovery: repeat "${resumeStep}"`, why: reason, options: [{ id: "retry", label: "Retry", consequence: "The control system repeats the failed step." }], recommendation: "retry", context: { stage: "recovery", resumeStep, fact } },
        "retry",
        `Automatic retry ${used + 1} of 2 in ${Math.round(delay / 60)} min (retryable failure; reversible; no owner decision involved).`,
      );
      await ctx.save({ infraRetries: 0 });
      return ctx.goto("self_recover", { resumeStep, at: ctx.now().getTime() + delay * 1000, reason: reason.slice(0, 500) });
    }
  }
  // state first: a decision is only ever opened for a task that is actually blocked
  await ctx.transition("BLOCKED_EVIDENCE", reason, fact, { resumeState: resumeState as TaskState, infraRetries: 0 });
  await ctx.openDecision({
    kind: "block",
    title: opts.auto === false ? "Blocked: needs you" : "Blocked: automatic recovery did not succeed",
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

/** Step: wait out the recovery delay, then repeat the step that failed (fresh step data). */
export async function selfRecover(ctx: TaskCtx): Promise<void> {
  if (ctx.now().getTime() < Number(ctx.data.at ?? 0)) return;
  await ctx.log("system", `Self-recovery: repeating "${String(ctx.data.resumeStep)}".`, {});
  await ctx.goto(String(ctx.data.resumeStep), {});
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

/**
 * Options a worker wrote in BLOCKED.json. An option that ends the task (action "abandon", or simply named like the built-in
 * "Abandon the task") is not kept as a separate answer: it IS the built-in abandon, so choosing or recommending it ends the task
 * instead of sending the worker back to drafting (finding: T2 looped through three decisions for one owner choice).
 */
export function workerOptions(raw: unknown, defaultConsequence: string) {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .slice(0, 6)
    .map((o, i) => {
      const obj = typeof o === "string" ? { label: o } : ((o ?? {}) as { label?: unknown; consequence?: unknown; action?: unknown });
      const label = String(obj.label ?? `Option ${i + 1}`);
      const consequence = String(obj.consequence ?? defaultConsequence);
      return { id: `o${i + 1}`, label, consequence, ...(obj.action === "abandon" ? { action: "abandon" as const } : {}) };
    })
    .filter((o) => !/^abandon( the| this)? task\.?$/i.test(o.label.trim()));
}
