import { desc, eq } from "drizzle-orm";
import { artifacts, executorJobs, qualificationRecords, runs } from "@/db/schema";
import { sha256, type Contract } from "@/domain/contract";
import type { PlanTask } from "@/domain/plan";
import { qualification, route, WORKERS, type CodeClass, type RouteDecision } from "@/domain/router";
import { CODE_SYSTEM, isSmallCode, repairScope } from "@/domain/semantic";
import { TaskCtx } from "./context";
import { harnessFailure, vols } from "./common";
import { qualRecords } from "./qualify";
import { planCursor, savePlan } from "./steps-plan";
import { currentContract } from "./steps-contract";
import { contextFor } from "./sessions";

/*
 * The local coder in production (local-worker extension). Two bounded classes only:
 *   small_code     - a plan task the plan confines to at most three named source files (deterministic classification);
 *   bounded_repair - a correction after the candidate's own check stage failed (FAIL:CHECK), confined to the files the check names.
 * A class is routed to the local coder only once it has QUALIFIED for it; until then Claude Code does the work and the local coder
 * gets the same bounded task in SHADOW mode on a scratch worktree (recorded, gated, verified, controlling nothing).
 * One local attempt, never more: if the local result fails its checks, or the gate later fails it, the work goes to Claude Code.
 */
type Task = Pick<PlanTask, "id" | "purpose" | "covers" | "contributes" | "scope_paths">;

/** What the local coder is told: the step, the criteria it must satisfy, the interface names, and the context package. */
export function localTaskInstruction(c: Contract, t: Task, pkg: string | null): string {
  const by = new Map<string, string>();
  for (const k of c.criteria) by.set(k.id, k.type === "behavior" ? `given ${k.given}; when ${k.when}; then ${k.then}` : k.type === "threshold" ? `${k.metric}: target ${k.target} (${k.conditions ?? ""})` : String((k as { statement?: string }).statement ?? ""));
  for (const k of c.constraints ?? []) by.set(k.id, k.statement);
  const list = (ids: string[]) => ids.map((id) => `- ${id}: ${(by.get(id) ?? "").slice(0, 900)}`).join("\n");
  return [
    `Step ${t.id} of the contract "${c.title}" (${c.id}).`,
    `What to do in this step: ${t.purpose}`,
    t.covers.length ? `This step must completely satisfy:\n${list(t.covers)}` : "",
    t.contributes.length ? `This step works towards (finished by a later step):\n${list(t.contributes)}` : "",
    c.interface?.ui ? `Names the implementation must use verbatim:\n${String(c.interface.ui).slice(0, 3500)}` : "",
    `Files you may change: ${t.scope_paths.join(", ")}. Add or update the unit tests in scope when the step changes behaviour that they cover.`,
    pkg ? `Context found in the repository:\n${pkg.slice(0, 5000)}` : "",
  ].filter(Boolean).join("\n\n");
}

export function repairInstruction(key: string, verdict: string, details: string): string {
  return `The project's own check stage (type check, lint, tests) failed on the current state of ${key}. Repair the change with the smallest correct edit so that the checks pass. Do not change what the code is meant to do, and do not touch tests unless a test file itself is what fails to compile or lint.\n\nVERDICT: ${verdict}\n${details.slice(-6000)}`;
}

/** The Router's decision for a coding class, for this task. */
export async function codeRoute(ctx: TaskCtx, cls: CodeClass): Promise<{ decision: RouteDecision; local: boolean; shadow: string | null }> {
  const records = await qualRecords(ctx.db);
  const decision = route({ taskClass: cls, risk: ctx.task.tier, records });
  const local = WORKERS[decision.worker]!.provider === "ollama-host";
  const shadow = !local ? (decision.shadow.find((w) => WORKERS[w]!.provider === "ollama-host" && qualification(records, w, cls).status !== "rejected") ?? null) : null;
  return { decision, local, shadow };
}

export function smallCodeTask(ctx: TaskCtx, c: Contract, t: PlanTask | null) {
  return isSmallCode({ tier: ctx.task.tier, task: t, criteria: c.criteria.map((k) => ({ id: k.id, tags: k.tags })) });
}

const contextOf = (files: string[] | null | undefined, scope: string[]) => (files ?? []).filter((f) => !scope.includes(f) && /\.(ts|tsx|json|css|md)$/.test(f)).slice(0, 4);

/**
 * SHADOW MODE for a coding class: the same bounded task on a scratch worktree of the same commit. The jobs are queued and never
 * awaited by the task; the result is collected by the qualification bookkeeping (gate = the project's checks, then the Verifier).
 */
export async function shadowCode(ctx: TaskCtx, i: { cls: CodeClass; worker: string; ref: string; instruction: string; scope: string[]; context: string[] }): Promise<void> {
  const vol = `agents-qf-${100000 + ctx.task.id}`;
  const model = WORKERS[i.worker]!.model;
  const params = { vol, model, system: CODE_SYSTEM, instruction: i.instruction, scope: i.scope, context: i.context, checks: { typecheck: true, lint: true, tests: "all" } };
  await ctx.db.insert(executorJobs).values({ taskId: ctx.task.id, op: "worktree", params: { vol, repo: ctx.project.repo, ref: i.ref } });
  const [job] = await ctx.db.insert(executorJobs).values({ taskId: ctx.task.id, op: "local_code", params }).returning({ id: executorJobs.id });
  await ctx.db.insert(executorJobs).values({ taskId: ctx.task.id, op: "vol_rm", params: { names: [vol] } });
  await ctx.db.insert(qualificationRecords).values({ worker: i.worker, taskClass: i.cls, mode: "shadow", taskId: ctx.task.id, inputSha256: sha256(JSON.stringify(params)), jobId: job!.id, model, caseId: `${ctx.task.key}@${i.ref.slice(0, 8)}`, contextBytes: i.instruction.length });
  await ctx.log("system", `Shadow mode: ${i.worker} (${model}) receives the same bounded ${i.cls} task on a scratch worktree; its result is recorded and checked, and controls nothing.`, { job: job!.id });
}

/** Called once the trusted Builder session of a plan task has started: shadow the task when it is SMALL_CODE and a local coder may be compared. */
export async function shadowSmallCode(ctx: TaskCtx, c: Contract, t: PlanTask, ref: string, runId: number): Promise<void> {
  try {
    if (!smallCodeTask(ctx, c, t).small) return;
    const r = await codeRoute(ctx, "small_code");
    if (!r.shadow) return;
    const [run] = await ctx.db.select({ files: runs.contextFiles }).from(runs).where(eq(runs.id, runId));
    const [a] = await ctx.db.select({ content: artifacts.content }).from(artifacts).where(eq(artifacts.name, `instructions (run ${runId})`)).orderBy(desc(artifacts.id)).limit(1);
    const pkg = a?.content.includes("\n\n---\n") ? a.content.slice(a.content.lastIndexOf("\n\n---\n") + 6) : null;
    await shadowCode(ctx, { cls: "small_code", worker: r.shadow, ref, instruction: localTaskInstruction(c, t, pkg), scope: t.scope_paths, context: contextOf(run?.files, t.scope_paths) });
  } catch {
    /* shadow bookkeeping never affects the task */
  }
}

type LocalResult = { ok?: boolean; stage?: string; reason?: string; gate?: { pass?: boolean; stage?: string; reason?: string; checks?: { name: string; rc: number; tail: string }[] }; diffstat?: string; notes?: string; ms?: number; usage?: { prompt_tokens?: number; output_tokens?: number }; prompt_chars?: number; changed?: string[]; model?: string };

/** One bounded local attempt on the task's worktree. Returns "wait", or the outcome with the ledger run it recorded. */
async function localAttempt(ctx: TaskCtx, i: { cls: CodeClass; purpose: "build" | "correction"; ref: string; decision: RouteDecision; instruction: string; scope: string[]; context: string[]; planTask: string | null }): Promise<"wait" | { pass: boolean; runId: number; why: string }> {
  const v = vols(ctx.task.id);
  const wt = await ctx.once("lwt", "worktree", () => ({ vol: v.worktree, repo: ctx.project.repo, ref: i.ref }));
  if (!wt) return "wait";
  if (wt.status === "error") { await harnessFailure(ctx, wt, "lwt", "preparing the worktree"); return "wait"; }
  const job = await ctx.once("lc", "local_code", () => ({ vol: v.worktree, model: i.decision.model, system: CODE_SYSTEM, instruction: i.instruction, scope: i.scope, context: i.context, checks: { typecheck: true, lint: true, tests: "all" } }));
  if (!job) return "wait";
  const res = (job.result ?? {}) as LocalResult;
  const pass = job.status === "done" && res.ok !== false && res.gate?.pass === true;
  const why = job.status === "error" ? String(job.error).slice(0, 200) : res.ok === false ? `${res.stage}: ${String(res.reason).slice(0, 200)}` : pass ? "the project's checks pass" : res.gate?.stage === "checks" ? `checks failed: ${(res.gate.checks ?? []).filter((c) => c.rc !== 0).map((c) => c.name).join(", ")}` : `${res.gate?.stage}: ${String(res.gate?.reason ?? "").slice(0, 200)}`;
  const closing = pass ? `${res.notes ?? ""}\n${res.diffstat ?? ""}`.trim() : why;
  const runId = await ctx.startRun({
    role: "builder", purpose: i.purpose, container: `local:${job.id}`, status: "finished", outcome: pass ? "report" : "aborted", durationMs: res.ms ?? null, closingText: closing.slice(0, 4000), finishedAt: ctx.now(),
    taskClass: i.cls, worker: i.decision.worker, harness: i.decision.harness, model: i.decision.model, provider: i.decision.provider, routeReason: i.decision.reason, envelope: i.decision.envelope as unknown as Record<string, unknown>,
    planTask: i.planTask, contextBytes: res.prompt_chars ?? i.instruction.length, contextFiles: [...i.scope, ...i.context], ...(pass ? {} : { failureClass: job.status === "error" || res.ok === false ? "infrastructure" : "check_defect" }),
  });
  if (pass) {
    // the work in the workspace is now the local coder's: an earlier Builder-slot session (the planner's) must not be resumed for it
    await ctx.save({ builderSessionId: null });
    const art = await ctx.artifact("builder-report", `REPORT (local run ${runId})`, `Built by ${i.decision.worker} (${i.decision.model}) in one bounded request.\n\n${res.notes ?? ""}\n\n${res.diffstat ?? ""}\n\nThe project's type check, lint and tests pass on the result.`);
    await ctx.setData({ reportArtifact: art });
  }
  return { pass, runId, why };
}

/** Step: a SMALL_CODE plan task built by the qualified local coder. On any failure the task goes to Claude Code (one local attempt only). */
export async function localBuild(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  const cur = await planCursor(ctx);
  const base = String(ctx.data.baseSha);
  const back = (why: string) => ctx.goto("build_start", { noLocal: true, claimed: true, mainSha: ctx.data.mainSha, stackBase: ctx.data.stackBase, localWhy: why });
  if (!c || !cur?.current) return back("no plan task");
  const body = c.body as unknown as Contract;
  const r = await codeRoute(ctx, "small_code");
  if (!r.local && !("lc" in ctx.data)) return back("the local coder is not qualified (any more)");
  if (ctx.task.state !== "IN_PROGRESS") {
    await savePlan(ctx, cur, (t) => ({ ...t, status: "running" }));
    await ctx.transition("IN_PROGRESS", `Local coder started on plan task ${cur.current.id} of the approved contract`, { base_sha: base, plan_task: cur.current.id, worker: r.decision.worker, route: r.decision.reason });
  }
  // the same deterministic context package the trusted Builder would get, built on the same worktree
  const v = vols(ctx.task.id);
  const wt = await ctx.once("lwt", "worktree", () => ({ vol: v.worktree, repo: ctx.project.repo, ref: base }));
  if (!wt) return;
  if (wt.status === "error") return harnessFailure(ctx, wt, "lwt", "preparing the worktree");
  const pkg = "lc" in ctx.data ? null : await contextFor(ctx, v.worktree, body, cur.current, null);
  if (pkg === "wait") return;
  const a = await localAttempt(ctx, { cls: "small_code", purpose: "build", ref: base, decision: r.decision, instruction: localTaskInstruction(body, cur.current, pkg?.markdown ?? null), scope: cur.current.scope_paths, context: contextOf(pkg?.files, cur.current.scope_paths), planTask: cur.current.id });
  if (a === "wait") return;
  if (a.pass) {
    await ctx.log("builder", `Local coder (${r.decision.model}) finished ${cur.current.id}: ${a.why}. Handing over to the normal path (transport, gate, Verifier).`, { run: a.runId });
    return ctx.goto("ship", { runId: a.runId, baseSha: base, localBuilt: true, reportArtifact: ctx.data.reportArtifact });
  }
  await ctx.log("system", `The local coder did not deliver ${cur.current.id} (${a.why}). No second local attempt: Claude Code builds this step.`, { run: a.runId });
  return back(a.why);
}

/** Should this correction be a bounded local repair? Only FAIL:CHECK, only files the check output names, only when qualified. */
export async function repairPlan(ctx: TaskCtx, verdict: string, details: string): Promise<{ scope: string[]; route: Awaited<ReturnType<typeof codeRoute>> } | null> {
  if (verdict !== "FAIL:CHECK" || ctx.task.tier !== "standard") return null;
  const scope = repairScope(details).slice(0, 3);
  if (scope.length === 0 || repairScope(details).length > 3) return null;
  return { scope, route: await codeRoute(ctx, "bounded_repair") };
}

/** Step: a bounded repair by the qualified local coder; on failure the correction goes to Claude Code. */
export async function localFix(ctx: TaskCtx): Promise<void> {
  const head = String(ctx.data.head ?? ctx.task.headSha);
  const back = (why: string) => ctx.goto("fix_start", { verdict: ctx.data.verdict, details: ctx.data.details, head, fact: ctx.data.fact, noLocal: true, localWhy: why });
  const plan = await repairPlan(ctx, String(ctx.data.verdict), String(ctx.data.details));
  if (!plan || (!plan.route.local && !("lc" in ctx.data))) return back("not a qualified bounded repair");
  if (ctx.task.state !== "IN_PROGRESS") await ctx.transition("IN_PROGRESS", `Correction ${ctx.task.corrections}: bounded repair by the local coder`, { ...(ctx.data.fact as Record<string, unknown>), worker: plan.route.decision.worker });
  const a = await localAttempt(ctx, { cls: "bounded_repair", purpose: "correction", ref: head, decision: plan.route.decision, instruction: repairInstruction(ctx.task.key!, String(ctx.data.verdict), String(ctx.data.details)), scope: plan.scope, context: [], planTask: null });
  if (a === "wait") return;
  if (a.pass) {
    await ctx.log("builder", `Local coder (${plan.route.decision.model}) repaired the failed check: ${a.why}.`, { run: a.runId });
    return ctx.goto("ship", { runId: a.runId, baseSha: head, localBuilt: true, reportArtifact: ctx.data.reportArtifact });
  }
  await ctx.log("system", `The local coder did not repair the failed check (${a.why}). No second local attempt: Claude Code takes the correction.`, { run: a.runId });
  return back(a.why);
}
