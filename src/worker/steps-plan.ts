import { eq } from "drizzle-orm";
import { plans, tasks } from "@/db/schema";
import { sha256, type Contract } from "@/domain/contract";
import { PlanBody, planFile, type IntegratedVerification, type PlanTask } from "@/domain/plan";
import { OUTCOME_DIR, planPrompt } from "@/domain/prompts";
import { activePlan, recordPlan } from "@/server/plans";
import type { TaskCtx } from "./context";
import { b64, blockEvidence, harnessFailure, latestGate, mainSha, ownerApproved, pollDue, sub, unb64, vols } from "./common";
import { currentContract, escalateGithub } from "./steps-contract";
import { finishSession, startSession } from "./sessions";

/*
 * Execution of a DECOMPOSED plan (Builder phase). A complex contract is split once (one level) by a planner session; the plan is
 * validated mechanically (coverage of every criterion by id), committed to the repository as tasks/<T>/plan.json so the gate can
 * judge each task on the criteria it covers, and then built task by task, strictly in order, each task on top of the previous one.
 * The last task carries the integrated result: its branch is not a plan task, so the gate requires the COMPLETE original contract.
 */
const MAX_PLAN_ATTEMPTS = 3;

/** Topological execution order (stable by id) of the tasks that are not dropped. */
export function executionOrder(p: PlanBody): PlanTask[] {
  const left = p.tasks.filter((t) => t.status !== "dropped").sort((a, b) => a.id.localeCompare(b.id));
  const out: PlanTask[] = [];
  const done = new Set<string>();
  while (left.length) {
    const i = left.findIndex((t) => t.depends_on.every((d) => done.has(d) || !left.some((x) => x.id === d)));
    const [t] = left.splice(i < 0 ? 0 : i, 1);
    out.push(t!);
    done.add(t!.id);
  }
  return out;
}

export interface PlanCursor {
  planId: number;
  body: PlanBody;
  integrated: IntegratedVerification;
  order: PlanTask[];
  current: PlanTask | null;
  index: number;
  isLast: boolean;
}

/** The decomposed plan in force for this task and the plan task that is next / in progress (null when the contract is built as one job). */
export async function planCursor(ctx: TaskCtx): Promise<PlanCursor | null> {
  const row = await activePlan(ctx.db, ctx.task.id);
  if (!row) return null;
  const body = PlanBody.parse(row.body);
  if (body.tasks.length === 0) return null;
  const order = executionOrder(body);
  const index = order.findIndex((t) => t.status !== "done");
  return { planId: row.id, body, integrated: row.integrated as unknown as IntegratedVerification, order, current: index < 0 ? null : order[index]!, index, isLast: index === order.length - 1 };
}

export async function savePlan(ctx: TaskCtx, cur: PlanCursor, patchTask: (t: PlanTask) => PlanTask, integrated?: IntegratedVerification) {
  const body = { ...cur.body, tasks: cur.body.tasks.map((t) => (cur.current && t.id === cur.current.id ? patchTask(t) : t)) };
  await ctx.db.update(plans).set({ body: body as unknown as Record<string, unknown>, ...(integrated ? { integrated: integrated as unknown as Record<string, unknown> } : {}) }).where(eq(plans.id, cur.planId));
}

/** Branch of a plan task's PR. The last task is the integrated result: its branch is deliberately NOT a plan task id. */
export const planBranch = (key: string, cur: PlanCursor, taskId: number) => `task/${key}/${cur.isLast ? "integration" : cur.current!.id.split(".")[1]}-${taskId}`;

export async function planStart(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  const row = await activePlan(ctx.db, ctx.task.id);
  if (!c || !row) return ctx.goto("build_start", { mainSha: ctx.data.mainSha });
  if (await ctx.builderBusy()) return;
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const base = mainSha(refs, ctx.project.repo)!;
  const reasons = PlanBody.parse(row.body).shape_reasons;
  const s = await startSession(ctx, "plan", base, planPrompt({ name: ctx.project.name, description: ctx.project.description, stack: ctx.project.stack }, { key: ctx.task.key!, title: ctx.task.title }, reasons, ctx.data.feedback as string | undefined), {
    context: { contract: c.body as unknown as Contract },
  });
  if (s === "wait") return;
  await ctx.goto("plan_poll", { runId: s.runId, container: s.container, attempt: ctx.data.attempt ?? 1 });
}

export async function planPoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") return;
  await ctx.goto("plan_collect", { runId: ctx.data.runId, attempt: ctx.data.attempt ?? 1 });
}

export async function planCollect(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  if (!c) return;
  const dump = await ctx.once("dump", "dump", () => ({ vol: vols(ctx.task.id).worktree, paths: [`${OUTCOME_DIR}/plan.json`] }));
  if (!dump) return;
  if (dump.status === "error") return harnessFailure(ctx, dump, "dump", "reading the planner's output");
  const runId = ctx.data.runId as number;
  const attempt = Number(ctx.data.attempt ?? 1);
  const raw = unb64(dump.result?.[`${OUTCOME_DIR}/plan.json`]);
  let problems: string[] = [];
  type RawPlan = { tasks?: unknown[]; integration?: string[] };
  const parse = (): RawPlan | null => {
    try {
      return raw ? (JSON.parse(raw) as RawPlan) : null;
    } catch {
      problems = ["plan.json is not valid JSON"];
      return null;
    }
  };
  const parsed = parse();
  if (!raw) problems = ["no plan.json was written"];
  if (parsed && problems.length === 0) {
    await ctx.updateRun(runId, { outcome: "output" });
    await ctx.artifact("plan", `plan.json (run ${runId})`, raw!);
    // strictly sequential execution, each task on top of the previous one: make that chain explicit in the dependencies (deterministic)
    const list = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((t) => ({ ...(t as Record<string, unknown>) }));
    const pre = PlanBody.safeParse({ contract: ctx.task.key, contract_version: c.version, contract_sha256: c.sha256, plan_version: 1, shape: "complex", tasks: list, integration: parsed.integration ?? [] });
    if (pre.success) {
      const order = executionOrder(pre.data);
      order.forEach((t, i) => {
        const e = list.find((x) => x.id === t.id)!;
        if (i > 0) e.depends_on = [...new Set([...(t.depends_on ?? []), order[i - 1]!.id])];
      });
    }
    const rec = await recordPlan(ctx.db, c, { tasks: list, integration: Array.isArray(parsed.integration) ? parsed.integration : [], reason: `Decomposed by the planner (run ${runId}).` });
    if (rec.ok) return ctx.goto("plan_pr", { planId: rec.plan.id });
    problems = rec.problems;
  } else await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
  await ctx.log("system", `Plan refused (${problems.slice(0, 3).join("; ")}).`, { run: runId });
  if (attempt < MAX_PLAN_ATTEMPTS) return ctx.goto("plan_start", { attempt: attempt + 1, feedback: problems.map((p) => `- ${p}`).join("\n") });
  // no valid plan: nothing is lost - the contract is built as ONE job against its full check, exactly as before decomposition existed
  await ctx.log("system", "No valid plan after three attempts; the contract is built as one job against its full check.", {});
  return ctx.goto("build_start", {});
}

/** Step: commit the validated plan as tasks/<T>/plan.json (hash-listed amendment; the gate confirms it; no owner action). */
export async function planPr(ctx: TaskCtx): Promise<void> {
  const cur = await planCursor(ctx);
  if (!cur) return ctx.goto("build_start", {});
  const key = ctx.task.key!;
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const sha = mainSha(refs, ctx.project.repo)!;
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha, paths: [`tasks/${key}/task.json`] }));
  if (!show) return;
  if (show.status === "error") return harnessFailure(ctx, show, "show", "reading the task record");
  const prev = unb64(show.result?.[`tasks/${key}/task.json`]);
  if (!prev) return blockEvidence(ctx, "The task record of the merged contract is missing on main.", { sha });
  const tj = JSON.parse(prev) as { amendments?: unknown[] };
  const file = planFile(cur.body);
  const now = ctx.now().toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  tj.amendments = [...(tj.amendments ?? []), { id: `A${(tj.amendments ?? []).length + 1}`, at: now, kind: "plan", reason: `Agents App: plan v${cur.body.plan_version} for contract v${cur.body.contract_version} (${cur.body.tasks.length} tasks; contract unchanged, sha256 ${cur.body.contract_sha256}).`, files: { [`tasks/${key}/plan.json`]: sha256(file) } }];
  const branch = `amend/${key}/plan-v${cur.body.plan_version}-${ctx.task.id}`;
  const job = await ctx.once("open", "transport", () => ({
    repo: ctx.project.repo,
    ops: [{ op: "pr_from_files", id: "pr", base_sha: sha, branch, title: `${key}: plan v${cur.body.plan_version} (${cur.body.tasks.length} tasks; contract unchanged)`, body: `Execution plan for the approved contract of ${key} (sha256 ${cur.body.contract_sha256}). The contract is unchanged. Tasks reference its criteria by id:\n\n${cur.order.map((t) => `- ${t.id}: covers ${t.covers.join(", ") || "-"}${t.contributes.length ? `; contributes to ${t.contributes.join(", ")}` : ""}`).join("\n")}\n\nIntegration-only: ${cur.body.integration.join(", ") || "-"}. The last task is gated against the complete contract.`, files: { [`tasks/${key}/plan.json`]: b64(file), [`tasks/${key}/task.json`]: b64(JSON.stringify(tj, null, 1) + "\n") } }],
  }));
  if (!job) return;
  const pr = job.status === "done" ? sub(job, "pr") : undefined;
  if (job.status === "error" || !pr?.ok) return harnessFailure(ctx, { ...job, error: job.error ?? JSON.stringify(pr ?? {}).slice(0, 300) }, "open", "opening the plan PR");
  await ctx.log("system", `Plan PR #${pr.pr} opened (${branch}); the gate validates it and the control system merges it.`, { pr: pr.pr });
  await ctx.goto("plan_merge", { prNo: pr.pr, prHead: pr.head_sha });
}

export async function planMerge(ctx: TaskCtx): Promise<void> {
  const prNo = Number(ctx.data.prNo);
  if (!("merge" in ctx.data)) {
    if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return;
    const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: prNo }] }));
    if (!job) return;
    await ctx.forget("state");
    if (job.status === "error") return harnessFailure(ctx, job, "state", "reading the plan PR");
    const s = sub(job, "s");
    if (!s?.ok) return;
    if (s.merged) return ctx.goto("build_start", { mainSha: s.merge_commit, claimed: true });
    const g = latestGate(s);
    if (!g || g.status !== "completed") return;
    const owner = ownerApproved(s, ctx.project.ownerLogin, String(ctx.data.prHead)).ok;
    if (g.verdict === "BLOCKED:DECISION" && !owner) return escalateGithub(ctx, prNo, String(ctx.data.prHead), "The repository's gate requires your review for this plan file.");
    if (g.verdict !== "AMENDMENT-OK" && !owner) return blockEvidence(ctx, `The gate rejected the plan PR #${prNo} (verdict ${g.verdict}).`, { pr: prNo, run: g.id }, { auto: false });
    await ctx.setData({ viaOwner: owner && g.verdict !== "AMENDMENT-OK" });
  }
  const m = await ctx.once("merge", "transport", () => ({ repo: ctx.project.repo, ops: [ctx.data.viaOwner ? { op: "merge_approved", id: "m", pr: prNo, owner: ctx.project.ownerLogin } : { op: "merge_system", id: "m", pr: prNo }] }));
  if (!m) return;
  const mr = m.status === "done" ? sub(m, "m") : undefined;
  if (m.status === "error" || !mr?.ok) {
    await ctx.forget("merge");
    if (mr && [405, 409, 422].includes(Number(mr.status))) return escalateGithub(ctx, prNo, String(ctx.data.prHead), "The repository's ruleset requires your review to merge this plan file.");
    return harnessFailure(ctx, { ...m, error: m.error ?? JSON.stringify(mr ?? {}).slice(0, 300) }, "merge", "merging the plan PR");
  }
  await ctx.log("system", `Plan merged (${String(mr.merge_commit).slice(0, 8)}); building its tasks in order.`, { pr: prNo });
  await ctx.goto("build_start", { mainSha: mr.merge_commit, claimed: true });
}

/** Step: a plan task passed its per-task gate. Record it and move to the next task (built on this task's head). */
export async function planTaskDone(ctx: TaskCtx): Promise<void> {
  const cur = await planCursor(ctx);
  if (!cur?.current) return ctx.goto("acceptance_start", { head: ctx.data.head, checkRun: ctx.data.checkRun });
  const head = String(ctx.data.head);
  await savePlan(ctx, cur, (t) => ({ ...t, status: "done", evidence: [...t.evidence, `check_run:${String(ctx.data.checkRun)}`, `pr:${ctx.task.prNumber}`, `branch:${ctx.task.branch}`, `head:${head}`] }));
  await ctx.transition("IN_PROGRESS", `Plan task ${cur.current.id} verified by the gate on the criteria it covers (${cur.current.covers.join(", ") || "none alone"}); ${cur.order.length - cur.index - 1} task(s) remain`, { plan_task: cur.current.id, head, pr: ctx.task.prNumber, check_run: ctx.data.checkRun });
  // the next task gets its own PR, its own Builder session and its own correction budget; it builds on this verified head
  await ctx.db.update(tasks).set({ prNumber: null, branch: null, builderSessionId: null, corrections: 0, extraCorrections: 0 }).where(eq(tasks.id, ctx.task.id));
  await ctx.goto("build_start", { stackBase: head, claimed: true });
}
