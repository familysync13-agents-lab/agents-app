import { and, desc, eq } from "drizzle-orm";
import { artifacts, projects, qualificationRecords, runs } from "@/db/schema";
import type { Contract } from "@/domain/contract";
import { buildContextPackage, contextSeeds, rankFiles, type ContextPackage, type ScanResult } from "@/domain/context";
import type { PlanTask } from "@/domain/plan";
import { detectProfile, type CapabilityProfile } from "@/domain/profile";
import { classifyFailure, route, type RouteDecision, type TaskClass } from "@/domain/router";
import type { TaskCtx } from "./context";
import { blockEvidence, harnessFailure, pollDue, vols } from "./common";

type BuilderPurpose = "draft_contract" | "build" | "correction" | "plan";
const CLASS_OF: Record<BuilderPurpose, TaskClass> = { draft_contract: "contract_draft", build: "build", correction: "correction", plan: "plan" };

/** The Router's decision for a class of work on this task, from recorded qualification evidence (deterministic; recorded on the run). */
export async function routeFor(ctx: TaskCtx, taskClass: TaskClass, unavailable: string[] = []): Promise<RouteDecision> {
  const records = await ctx.db.select({ worker: qualificationRecords.worker, taskClass: qualificationRecords.taskClass, valid: qualificationRecords.valid, agree: qualificationRecords.agree }).from(qualificationRecords);
  return route({ taskClass, risk: ctx.task.tier, records, unavailable });
}

/** Ledger fields of a run: which worker, why, under which permission envelope. */
export function ledger(taskClass: TaskClass, d: RouteDecision) {
  return { taskClass, worker: d.worker, harness: d.harness, model: d.model, provider: d.provider, routeReason: d.reason, envelope: d.envelope as unknown as Record<string, unknown> };
}

/**
 * Deterministic Context Builder, executed before the worker starts: exact search for the contract's names in the worktree, then the
 * static relationships and history of the files that matter. Never blocks the work: if the scan fails, the worker starts without a
 * package (recorded). Also refreshes the project's capability profile from the same scan.
 */
async function contextFor(ctx: TaskCtx, vol: string, c: Contract, task: PlanTask | null, errors: string | null): Promise<"wait" | ContextPackage | null> {
  const seeds = contextSeeds(c, task);
  const s1 = await ctx.once("ctx1", "context_scan", () => ({ vol, terms: seeds.terms }));
  if (!s1) return "wait";
  if (s1.status === "error" || !s1.result?.ok) {
    await ctx.log("system", `Context scan unavailable (${String(s1.error ?? "").slice(0, 120)}); the worker starts without a context package.`, { job: s1.id });
    return null;
  }
  const scan1 = s1.result as unknown as ScanResult & { profile_files?: Record<string, string>; file_list?: string[] };
  const top = rankFiles(scan1);
  const s2 = top.length ? await ctx.once("ctx2", "context_scan", () => ({ vol, terms: [], files: top })) : s1;
  if (!s2) return "wait";
  const files = s2.status === "done" && s2.result?.ok ? ((s2.result as unknown as ScanResult).files ?? {}) : {};
  const profile = detectProfile(String(scan1.commit ?? ""), scan1.profile_files ?? {}, scan1.file_list ?? []);
  if ((ctx.project.capabilityProfile as { commit?: string } | null)?.commit !== profile.commit)
    await ctx.db.update(projects).set({ capabilityProfile: profile as unknown as Record<string, unknown> }).where(eq(projects.id, ctx.project.id));
  return buildContextPackage({ contract: c, task, profile: profile as CapabilityProfile, scan: { ...scan1, files }, errors });
}

/**
 * Start a Builder-slot session: a fresh worktree of the repository at `ref`, then Claude Code in its isolated container. The
 * instructions travel as a file inside the workspace (.bakeoff/PROMPT.md, written by the executor), never as argv.
 * Before the worker starts, the Router's decision is taken and recorded, and (for work on a contract) the deterministic context
 * package is assembled and placed at the top of the instructions.
 */
export async function startSession(
  ctx: TaskCtx,
  purpose: BuilderPurpose,
  ref: string,
  prompt: string,
  opts: { resume?: string; freshWorktree?: boolean; context?: { contract: Contract; task?: PlanTask | null; errors?: string | null }; planTask?: string | null } = {},
): Promise<"wait" | { runId: number; container: string }> {
  const v = vols(ctx.task.id);
  if (opts.freshWorktree !== false) {
    const wt = await ctx.once("wt", "worktree", () => ({ vol: v.worktree, repo: ctx.project.repo, ref }));
    if (!wt) return "wait";
    if (wt.status === "error") {
      await harnessFailure(ctx, wt, "wt", "preparing the worktree");
      return "wait";
    }
  }
  const taskClass = CLASS_OF[purpose];
  const decision = await routeFor(ctx, taskClass);
  let pkg: ContextPackage | null = null;
  if (opts.context && !opts.resume) {
    const r = await contextFor(ctx, v.worktree, opts.context.contract, opts.context.task ?? null, opts.context.errors ?? null);
    if (r === "wait") return "wait";
    pkg = r;
  }
  const full = pkg ? `${prompt}\n\n---\n${pkg.markdown}` : prompt;
  const b = await ctx.once("builder", "builder", () => ({
    candidate: ctx.project.builderKey,
    vol: v.worktree,
    model: decision.model === "opus" || decision.model === "sonnet" ? decision.model : "opus",
    prompt_text: full,
    ...(opts.resume ? { resume: opts.resume } : {}),
  }));
  if (!b) return "wait";
  if (b.status === "error") {
    if (/still running/.test(String(b.error))) {
      await ctx.forget("builder"); // another session of this Builder home is running: wait for it (serialized)
      return "wait";
    }
    await harnessFailure(ctx, b, "builder", "starting the Builder");
    return "wait";
  }
  const container = String(b.result?.detached ?? "");
  const runId = await ctx.startRun({
    role: "builder",
    purpose,
    container,
    status: "running",
    sessionId: opts.resume ?? null,
    ...ledger(taskClass, decision),
    planTask: opts.planTask ?? opts.context?.task?.id ?? null,
    contextBytes: pkg?.bytes ?? null,
    contextFiles: pkg?.files ?? null,
  });
  // the exact instructions of every run are kept: execution is reconstructable, and a paused run can be restarted from them
  await ctx.artifact("prompt", `instructions (run ${runId})`, full, false);
  await ctx.log(
    "builder",
    purpose === "draft_contract"
      ? "Contract drafter started (Builder slot, isolated container, no GitHub access)."
      : purpose === "plan"
        ? "Planner started (Builder slot): splitting the complex contract into a one-level task graph."
        : purpose === "build"
          ? `Builder started on ${opts.context?.task?.id ?? ctx.task.key} (isolated container; repository ${ref.slice(0, 8)}${pkg ? `; context package ${pkg.bytes} bytes, ${pkg.files.length} files` : ""}).`
          : "Builder resumed for a correction.",
    { run: runId, container, route: decision.reason },
  );
  return { runId, container };
}

/** Builder-role polling steps: where a paused session continues once the worker is available again. */
const QUOTA_BASE_MIN = 30;

/**
 * The worker's subscription quota is exhausted. This is neither a failure of the work nor an owner matter: the job PAUSES with
 * everything preserved (contract, plan, worktree, evidence, counters, the session itself) and resumes by itself.
 */
/** Non-Builder workers (Verifier, arbiter) keep no resumable session: after the pause the step that started them is repeated with the same inputs; no attempt is spent. */
const RESTART_STEP: Record<string, string> = { oracle_poll: "oracle_start", acceptance_poll: "acceptance_start", attribute_poll: "attribute_start", regress_poll: "regress_start" };

async function quotaPause(ctx: TaskCtx, runId: number, closing: string, resetAt: number | undefined, restartStep?: string) {
  const run = await ctx.run(runId);
  const n = Number(ctx.data.quotaPauses ?? 0) + 1;
  const wait = Math.min(QUOTA_BASE_MIN * n, 120) * 60_000;
  const until = resetAt && resetAt > ctx.now().getTime() ? Math.min(resetAt + 60_000, ctx.now().getTime() + 6 * 3600_000) : ctx.now().getTime() + wait;
  await ctx.updateRun(runId, { status: "finished", outcome: "aborted", failureClass: "quota" });
  await ctx.log("system", `Worker quota exhausted (${closing.slice(0, 100)}). The job is paused with all state kept and resumes automatically at ${new Date(until).toISOString().slice(0, 16)}Z.`, { run: runId });
  const data = { ...ctx.data };
  delete data.sess;
  delete data.pollAt;
  if (restartStep) {
    delete data.runId;
    delete data.container;
    delete data.started;
    return ctx.goto("await_quota", { restartStep, restartData: data, until, quotaPauses: n, runId });
  }
  await ctx.goto("await_quota", { pollStep: ctx.task.step, pollData: data, purpose: run?.purpose ?? "build", sessionId: run?.sessionId ?? null, runId, until, quotaPauses: n });
}

/** Step: paused for quota. At the scheduled time the same session is resumed (or, if it never got a session, restarted from its recorded instructions). */
export async function awaitQuota(ctx: TaskCtx): Promise<void> {
  if (ctx.now().getTime() < Number(ctx.data.until ?? 0) && !("builder" in ctx.data)) return;
  if (ctx.data.restartStep) {
    await ctx.log("system", "Quota available again: the paused worker step is repeated with the same inputs; no state was lost and no attempt was spent.", { resumed_from: ctx.data.runId });
    return ctx.goto(String(ctx.data.restartStep), { ...(ctx.data.restartData as Record<string, unknown>), quotaPauses: ctx.data.quotaPauses });
  }
  if (await ctx.builderBusy()) return;
  const sessionId = (ctx.data.sessionId as string | null) ?? undefined;
  let prompt = "You were interrupted because the usage limit was reached. Nothing was lost: continue the same task from where you stopped. All instructions and rules given at the start still apply, including the output files you must write.";
  if (!sessionId) {
    const [a] = await ctx.db.select().from(artifacts).where(and(eq(artifacts.taskId, ctx.task.id), eq(artifacts.name, `instructions (run ${Number(ctx.data.runId)})`))).orderBy(desc(artifacts.id)).limit(1);
    if (!a) return blockEvidence(ctx, "A paused run has neither a session nor recorded instructions to restart from.", { run: ctx.data.runId }, { auto: false });
    prompt = a.content;
  }
  const purpose = (["draft_contract", "build", "correction", "plan"].includes(String(ctx.data.purpose)) ? ctx.data.purpose : "build") as BuilderPurpose;
  const s = await startSession(ctx, purpose, "", prompt, { resume: sessionId, freshWorktree: false, planTask: null });
  if (s === "wait") return;
  const [prev] = await ctx.db.select({ planTask: runs.planTask, contextBytes: runs.contextBytes, contextFiles: runs.contextFiles }).from(runs).where(eq(runs.id, Number(ctx.data.runId)));
  if (prev) await ctx.updateRun(s.runId, prev);
  await ctx.log("system", "Quota available again: the paused session was resumed; no state was lost.", { run: s.runId, resumed_from: ctx.data.runId });
  await ctx.goto(String(ctx.data.pollStep), { ...(ctx.data.pollData as Record<string, unknown>), runId: s.runId, container: s.container, quotaPauses: ctx.data.quotaPauses });
}

/** Poll a detached worker session; when it has exited, record its measured facts. Returns "running" or "finished". */
export async function finishSession(ctx: TaskCtx, runId: number, container: string): Promise<"running" | "finished"> {
  if (!("sess" in ctx.data) && !(await pollDue(ctx, 20))) return "running";
  const j = await ctx.once("sess", "session", () => ({ name: container, tail_lines: 2 }));
  if (!j) return "running";
  await ctx.forget("sess");
  if (j.status === "error") {
    await harnessFailure(ctx, j, "sess", "reading the worker session");
    return "running";
  }
  const r = j.result ?? {};
  if (r.running) return "running";
  const res = (r.result ?? null) as Record<string, unknown> | null;
  await ctx.updateRun(runId, {
    status: r.gone ? "harness_error" : "finished",
    exitCode: r.exit !== undefined ? String(r.exit) : r.gone ? "gone" : null,
    costUsd: typeof res?.total_cost_usd === "number" ? res.total_cost_usd : null,
    turns: typeof res?.num_turns === "number" ? res.num_turns : null,
    durationMs: typeof res?.duration_ms === "number" ? res.duration_ms : null,
    sessionId: typeof res?.session_id === "string" ? res.session_id : undefined,
    closingText: typeof res?.result === "string" ? res.result.slice(0, 4000) : typeof r.tail === "string" ? String(r.tail).slice(-1500) : null,
    finishedAt: ctx.now(),
  });
  const closing = typeof res?.result === "string" ? res.result : "";
  const erred = res?.is_error === true || Number(res?.num_turns ?? 0) <= 1 || !res;
  // a worker that printed no result at all (Codex): only its own ERROR lines on stderr are evidence, never the echoed instructions
  const errLines = !res && typeof r.stderr_tail === "string" ? String(r.stderr_tail).split("\n").filter((l) => /^ERROR:/.test(l)).join("\n") : "";
  const said = closing || (typeof r.tail === "string" && r.tail ? String(r.tail) : "") || errLines;
  const failure = classifyFailure(said, ctx.now().getTime());
  if (failure.cls === "quota" && erred) {
    const run = await ctx.run(runId);
    if (run?.role === "builder") {
      await quotaPause(ctx, runId, said, failure.resetAt);
      return "running";
    }
    const restart = RESTART_STEP[ctx.task.step];
    if (restart) {
      await quotaPause(ctx, runId, said, failure.resetAt, restart);
      return "running";
    }
  }
  if (failure.cls !== "unknown" && erred) await ctx.updateRun(runId, { failureClass: failure.cls });
  if (/Failed to authenticate|OAuth session expired|Invalid API key|Please run \/login/i.test(closing) && Number(res?.num_turns ?? 0) <= 1) {
    // the worker never started working: its vendor login is not usable. Not the work's fault and not fixable by retrying blindly.
    const run = await ctx.run(runId);
    await ctx.updateRun(runId, { status: "harness_error", outcome: "aborted" });
    await blockEvidence(ctx, `The ${run?.role === "verifier" ? "Verifier" : "Builder"}'s vendor login is not usable (${closing.slice(0, 120)}). This is a credential problem of the worker environment, not of the work.`, { run: runId, credential: true }, { auto: false });
    return "running";
  }
  if (typeof res?.session_id === "string") {
    const run = await ctx.run(runId);
    if (run?.role === "builder" && run.purpose !== "draft_contract") await ctx.save({ builderSessionId: res.session_id });
  }
  return "finished";
}
