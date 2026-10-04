import { and, desc, eq, inArray, like, ne, notInArray, sql } from "drizzle-orm";
import { decisions, evidence, gateResults, runs, tasks } from "@/db/schema";
import type { Contract } from "@/domain/contract";
import { classifyVerdict } from "@/domain/lifecycle";
import { criteriaFromGate, correctionDetails, oracleDefects, type GateEvidence, scansFromGate } from "@/domain/gate";
import { buildPrompt, correctionPrompt, noOutcomePrompt, OUTCOME_DIR } from "@/domain/prompts";
import { extraFiles } from "@/domain/context";
import { PlanBody } from "@/domain/plan";
import { planTaskPrompt } from "@/domain/prompts";
import { activePlan, planBlockers, recordPlan } from "@/server/plans";
import { planBranch, planCursor, savePlan } from "./steps-plan";
import { TaskCtx } from "./context";
import { currentContract, isBehind } from "./steps-contract";
import { workerOptions, blockEvidence, harnessFailure, latestGate, mainSha, ownerApproved, pollDue, PROTECTED, sub, unb64, vols } from "./common";
import { assemblePackage } from "./evidence";
import { finishSession, startSession } from "./sessions";
import { codeRoute, repairInstruction, repairPlan, shadowCode, shadowSmallCode, smallCodeTask } from "./steps-local";

/** Step: start the build - deliberately serialized per project (no accidental stacked branches: bake-off lesson 6). */
export async function buildStart(ctx: TaskCtx): Promise<void> {
  let parent: typeof tasks.$inferSelect | undefined;
  if (await ctx.projectHasOpenWork()) {
    parent = ctx.project.workMode === "stacked" ? await stackParent(ctx) : undefined;
    if (!parent) {
      if (!ctx.data.queuedLogged) {
        await ctx.log(
          "system",
          ctx.project.workMode === "stacked"
            ? "Queued: another task of this project is still being built or verified (stacking starts only on a DONE head)."
            : "Queued: another task of this project is being built or awaits acceptance (this project serializes its work).",
          {},
        );
        await ctx.setData({ queuedLogged: true });
      }
      return;
    }
  }
  if (await ctx.builderBusy()) return;
  if (!parent && !ctx.data.claimed) {
    // deterministic order: the oldest contracted task of the project builds first
    const [older] = await ctx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, ctx.project.id), eq(tasks.state, "CONTRACTED"), eq(tasks.step, "build_start"), sql`${tasks.id} < ${ctx.task.id}`))
      .limit(1);
    if (older) return;
  }
  if (!ctx.data.claimed) await ctx.setData({ claimed: true });
  const c = await currentContract(ctx);
  if (parent) {
    // deliberate stacking: build on the exact DONE head of the previous task; both are verified together by this task's gate run
    // (the previous task's criteria are regression criteria) and accepted with ONE owner approval of this task's PR
    await ctx.save({ stackParentId: parent.id });
    if (!ctx.data.stackLogged) await ctx.log("system", `Stacked on ${parent.key} (DONE at ${String(parent.headSha).slice(0, 8)}, awaiting acceptance): this task builds on its head and both are accepted together.`, { parent: parent.id, parent_head: parent.headSha });
    await ctx.setData({ mainSha: parent.headSha, stackLogged: true });
  }
  if (!parent) {
    // always build on the CURRENT main (other tasks or check amendments may have been merged since this contract was merged)
    const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
    if (!refs) return;
    const m = refs.status === "done" ? mainSha(refs, ctx.project.repo) : undefined;
    if (m) await ctx.setData({ mainSha: m });
  }
  // a decomposed contract is built task by task: the first task on main, every later task on the verified head of the previous one
  const cur = await planCursor(ctx);
  const base = String((cur && cur.index > 0 ? ctx.data.stackBase ?? ctx.task.headSha : null) ?? ctx.data.mainSha ?? c?.mergeCommit ?? "");
  if (!base) return blockEvidence(ctx, "No merged contract commit to build on.", { contract: c?.id ?? null });
  const info = { name: ctx.project.name, description: ctx.project.description, stack: ctx.project.stack };
  const prompt = cur?.current
    ? planTaskPrompt(info, { key: ctx.task.key!, title: ctx.task.title }, cur.current, { index: cur.index, total: cur.order.length, done: cur.order.slice(0, cur.index).map((t) => t.id) })
    : buildPrompt(info, { key: ctx.task.key!, title: ctx.task.title });
  // deterministic classification: a plan task confined to a few named files is SMALL_CODE; it goes to the local coder only when
  // that worker has qualified for the class (otherwise Claude Code builds it and the local coder is shadowed)
  if (c && cur?.current && !ctx.data.noLocal && smallCodeTask(ctx, c.body as unknown as Contract, cur.current).small && (await codeRoute(ctx, "small_code")).local)
    return ctx.goto("local_build", { baseSha: base, mainSha: ctx.data.mainSha, stackBase: ctx.data.stackBase });
  const s = await startSession(ctx, "build", base, prompt, c ? { context: { contract: c.body as unknown as Contract, task: cur?.current ?? null } } : {});
  if (s === "wait") return;
  if (c && cur?.current && !ctx.data.noLocal) await shadowSmallCode(ctx, c.body as unknown as Contract, cur.current, base, s.runId);
  if (cur?.current) await savePlan(ctx, cur, (t) => ({ ...t, status: "running" }));
  const fact = { run: s.runId, container: s.container, base_sha: base, contract: c?.id ?? null, plan_task: cur?.current?.id ?? null };
  if (ctx.task.state === "IN_PROGRESS") await ctx.log("system", `Builder started on plan task ${cur?.current?.id ?? ""} (on ${base.slice(0, 8)}).`, fact);
  else await ctx.transition("IN_PROGRESS", cur?.current ? `Builder started on plan task ${cur.current.id} of the approved contract` : "Builder started on the approved contract", fact);
  await ctx.goto("build_poll", { runId: s.runId, container: s.container, baseSha: base });
}

export async function buildPoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") return;
  await ctx.goto("build_collect", { runId: ctx.data.runId, baseSha: ctx.data.baseSha, nudged: ctx.data.nudged ?? false });
}

/** The DONE task this task may stack on: exactly one DONE task awaiting acceptance, nothing else in flight, not already stacked on. */
async function stackParent(ctx: TaskCtx) {
  const others = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.project.id), ne(tasks.id, ctx.task.id), inArray(tasks.state, ["IN_PROGRESS", "VERIFYING", "DONE"])));
  if (others.length !== 1) return undefined;
  const p = others[0]!;
  if (p.state !== "DONE" || p.step !== "await_acceptance" || !p.headSha) return undefined;
  const [child] = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.stackParentId, p.id), ne(tasks.id, ctx.task.id), notInArray(tasks.state, ["REJECTED", "ABANDONED", "ACCEPTED"])));
  if (child) return undefined;
  return p;
}

/** Step: read the Builder's STRUCTURED outcome (files), never its closing prose (bake-off lesson 1). */
export async function buildCollect(ctx: TaskCtx): Promise<void> {
  const v = vols(ctx.task.id);
  const runId = ctx.data.runId as number;
  const dump = await ctx.once("dump", "dump", () => ({ vol: v.worktree, paths: [`${OUTCOME_DIR}/REPORT.md`, `${OUTCOME_DIR}/BLOCKED.json`] }));
  if (!dump) return;
  if (dump.status === "error") return harnessFailure(ctx, dump, "dump", "reading the Builder's outcome files");
  const report = unb64(dump.result?.[`${OUTCOME_DIR}/REPORT.md`]);
  const blocked = unb64(dump.result?.[`${OUTCOME_DIR}/BLOCKED.json`]);
  if (blocked) {
    await ctx.updateRun(runId, { outcome: "blocked" });
    const art = await ctx.artifact("block-record", "BLOCKED.json (Builder)", blocked);
    let rec: Record<string, unknown> = {};
    try {
      rec = JSON.parse(blocked) as Record<string, unknown>;
    } catch {
      rec = { unknown: blocked.slice(0, 500) };
    }
    const kind = String(rec.type ?? "BLOCKED:DECISION") === "BLOCKED:EVIDENCE" ? "BLOCKED_EVIDENCE" : "BLOCKED_DECISION";
    if (kind === "BLOCKED_EVIDENCE" && ctx.task.prNumber && ctx.task.headSha) {
      // The Builder says the work cannot be verified (typically: "the check is wrong"). That is a claim, not a fact: the independent
      // arbiter tests it against a live preview before anyone - the owner included - is asked (V0: three such blocks reached the owner).
      const routed = await routeBuilderClaim(ctx, String(rec.unknown ?? blocked).slice(0, 2000), art);
      if (routed) return;
    }
    const opts = workerOptions(rec.options, "The contract is amended accordingly and the build continues.");
    await ctx.transition(kind, `The Builder blocked (${kind === "BLOCKED_DECISION" ? "decision" : "evidence"}): ${String(rec.unknown ?? "").slice(0, 200)}`, {
      run: runId,
      file: `${OUTCOME_DIR}/BLOCKED.json`,
      artifact: art,
    }, { resumeState: "CONTRACTED" });
    const dec = {
      kind: "block" as const,
      title: String(rec.unknown ?? "The Builder needs a decision"),
      why: String(rec.would_resolve ?? rec.why ?? "The Builder may not make this decision (it holds engineering rights only)."),
      options: [...opts, { id: "abandon", label: "Abandon the task", consequence: "The task ends; nothing is merged." }],
      recommendation: typeof rec.recommendation === "string" ? rec.recommendation : null,
      context: { stage: "build", artifactId: art, runId, criteria: rec.criteria ?? [], tried: rec.tried ?? null, class: kind === "BLOCKED_DECISION" ? (rec.class ?? null) : null },
    };
    await ctx.openDecision(dec);
    return ctx.goto("await_decision", {});
  }
  if (!report) {
    await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
    const sessionId = ctx.task.builderSessionId;
    if (!ctx.data.nudged && sessionId) {
      await ctx.log("system", "The Builder ended without REPORT.md or BLOCKED.json; asking it to write its structured outcome.", { run: runId });
      const s = await startSession(ctx, "correction", "", noOutcomePrompt(), { resume: sessionId, freshWorktree: false });
      if (s === "wait") return;
      return ctx.goto("build_poll", { runId: s.runId, container: s.container, baseSha: ctx.data.baseSha, nudged: true });
    }
    return blockEvidence(ctx, "The Builder ended twice without a structured outcome (no REPORT.md / BLOCKED.json).", { run: runId });
  }
  await ctx.updateRun(runId, { outcome: "report" });
  const art = await ctx.artifact("builder-report", `REPORT.md (run ${runId})`, report);
  await ctx.setData({ reportArtifact: art });
  await ctx.goto("ship", { runId, baseSha: ctx.data.baseSha });
}

/** Step: export exactly the git-tracked files (credential scan in the executor), then open or update the task PR. */
export async function ship(ctx: TaskCtx): Promise<void> {
  const v = vols(ctx.task.id);
  const ex = await ctx.once("export", "export", () => ({ vol: v.worktree, export_vol: v.export, candidate: ctx.project.builderKey }));
  if (!ex) return;
  if (ex.status === "error") {
    if (/credential/.test(String(ex.error))) {
      // a credential string in the Builder's output is a trust-boundary incident: stop this path (Critical)
      await ctx.transition("BLOCKED_DECISION", "Security stop: credential string in the Builder output (nothing was sent)", { job: ex.id });
      await ctx.openDecision({
        kind: "block",
        title: "Security stop: the Builder's output contained a credential string",
        why: "Nothing was sent. This is a trust-boundary incident and needs your decision.",
        options: [{ id: "abandon", label: "Abandon the task", consequence: "The output is discarded." }],
        context: { stage: "security", job: ex.id },
      });
      return ctx.goto("await_decision", {});
    }
    return harnessFailure(ctx, ex, "export", "exporting the Builder's work");
  }
  const cur = await planCursor(ctx);
  const newBranch = cur?.current ? planBranch(ctx.task.key!, cur, ctx.task.id) : `task/${ctx.task.key}/agents-${ctx.task.id}`;
  const title = `${ctx.task.key}${cur?.current ? ` [${cur.current.id}${cur.isLast ? ", integrated result" : ""}]` : ""}: ${ctx.task.title}`;
  const isUpdate = !!ctx.task.prNumber;
  const job = await ctx.once("pr", "transport", () => ({
    repo: ctx.project.repo,
    work_vol: v.export,
    ops: [
      isUpdate
        ? { op: "update_pr_from_worktree", id: "pr", branch: ctx.task.branch, expect_head: ctx.task.headSha, scope: ["**"], refuse: PROTECTED, title: `${title} - correction` }
        : {
            op: "pr_from_worktree",
            id: "pr",
            base_sha: ctx.data.baseSha,
            branch: newBranch,
            scope: ["**"],
            refuse: PROTECTED,
            title,
            body: `Built by the Builder (isolated container) under Agents App task ${ctx.task.id}. Contract: tasks/${ctx.task.key}/contract.json. Transport: agent GitHub App.`,
          },
    ],
  }));
  if (!job) return;
  if (job.status === "error") return harnessFailure(ctx, job, "pr", "opening the task PR");
  const pr = sub(job, "pr");
  if (!pr?.ok) {
    if (pr?.refused) {
      await ctx.transition("BLOCKED_DECISION", "Protected-path change refused by the transport (tamper protection)", { job: job.id, refused: pr.refused as unknown[] });
      await ctx.openDecision({
        kind: "block",
        title: "The Builder changed protected paths",
        why: `The transport refused the change: ${JSON.stringify(pr.refused).slice(0, 400)}. Workers may never redefine success.`,
        options: [
          { id: "retry", label: "Send it back to the Builder", consequence: "The Builder is told to undo the protected-path changes." },
          { id: "abandon", label: "Abandon the task", consequence: "Nothing is merged." },
        ],
        recommendation: "retry",
        context: { stage: "tamper", refused: pr.refused },
      });
      return ctx.goto("await_decision", {});
    }
    if (pr?.err === "no-changes") return blockEvidence(ctx, "The Builder reported completion but changed nothing.", { job: job.id });
    return harnessFailure(ctx, { ...job, error: JSON.stringify(pr ?? {}).slice(0, 300) }, "pr", "opening the task PR");
  }
  const head = String(pr.head_sha);
  const prNumber = isUpdate ? ctx.task.prNumber! : Number(pr.pr);
  const branch = isUpdate ? ctx.task.branch! : newBranch;
  // ledger: what the worker changed beyond what the context package pointed to (observable under-selection of the package)
  const [run] = await ctx.db.select({ id: runs.id, files: runs.contextFiles }).from(runs).where(eq(runs.id, Number(ctx.data.runId ?? 0)));
  if (run?.files) await ctx.updateRun(run.id, { extraFiles: extraFiles(run.files, ((pr.changed as [string, string][] | undefined) ?? []).map((x) => x[0])) });
  await ctx.transition("VERIFYING", `Work submitted as ${isUpdate ? "a correction to " : ""}PR #${prNumber} (head ${head.slice(0, 8)}); gate evaluation started`, {
    pr: prNumber,
    head,
    run: ctx.data.runId,
    credential_scan: (ex.result?.credential_scan as Record<string, unknown>) ?? null,
  }, { prNumber, headSha: head, branch });
  await ctx.goto("await_gate", { head, since: ctx.now().getTime() });
}

/** Step: wait for the required `gate` check for exactly this head. */
export async function awaitGate(ctx: TaskCtx): Promise<void> {
  const head = ctx.data.head as string;
  if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return;
  const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: ctx.task.prNumber }] }));
  if (!job) return;
  await ctx.forget("state");
  if (job.status === "error") return harnessFailure(ctx, job, "state", "reading the gate status");
  const s = sub(job, "s");
  if (!s?.ok || s.head !== head) return;
  const g = latestGate(s);
  if (g && g.id <= Number(ctx.data.afterRun ?? 0)) return; // an earlier run of the same head (a re-run was requested)
  if (!g || g.status !== "completed" || !g.verdict) {
    if ((ctx.now().getTime() - Number(ctx.data.since ?? 0)) / 1000 > 5400)
      return blockEvidence(ctx, `No gate verdict for ${head.slice(0, 8)} after 90 minutes.`, { pr: ctx.task.prNumber, head });
    return;
  }
  await ctx.goto("gate_collect", { head, checkRun: g.id, verdict: g.verdict, envRetried: ctx.data.envRetried ?? false, syncTried: ctx.data.syncTried ?? false });
}

/** Step: collect the gate's full evidence and decide: DONE, automatic correction, or block. */
export async function gateCollect(ctx: TaskCtx): Promise<void> {
  const head = ctx.data.head as string;
  const checkRun = ctx.data.checkRun as number;
  const job = await ctx.once("ev", "gate_evidence", () => ({ repo: ctx.project.repo, check_run: checkRun }));
  if (!job) return;
  if (job.status === "error") return harnessFailure(ctx, job, "ev", "reading the gate evidence");
  const ev = (job.result?.evidence ?? {}) as GateEvidence;
  const verdict = String(job.result?.verdict ?? ctx.data.verdict ?? "UNKNOWN").trim();
  const kind = classifyVerdict(verdict);
  const existing = await ctx.db.select({ id: gateResults.id }).from(gateResults).where(eq(gateResults.checkRunId, checkRun));
  if (existing.length === 0) {
    const art = await ctx.artifact("gate-evidence", `gate evidence (check run ${checkRun})`, JSON.stringify(ev, null, 1), false);
    await ctx.db.insert(gateResults).values({
      taskId: ctx.task.id,
      prNumber: ctx.task.prNumber!,
      headSha: head,
      checkRunId: checkRun,
      verdict,
      reasons: ev.reasons ?? [],
      contractSha256: ev.contract_sha256 ?? null,
      kind,
      evidenceArtifactId: art,
    });
    for (const c of criteriaFromGate(ev))
      await ctx.evidence({
        subject: c.subject,
        status: c.status,
        oracle: c.oracle,
        persistence: c.persistence,
        source: `gate:${checkRun}`,
        commitSha: head,
        contractSha256: ev.contract_sha256 ?? null,
        detail: `${c.regression ? "regression · " : ""}${c.check}${c.detail ? ` · ${c.detail}` : ""}`.slice(0, 2000),
        artifactId: art,
        kind: c.regression ? "regression" : "criterion",
        // "unmapped" = the gate reported the requirement without a verification binding (not judged)
        checkName: c.deciding ? c.check : c.check === "unmapped" ? "unbound" : c.check === "judgment" ? "judgment" : `deferred:${c.check}`,
      });
    for (const sc of scansFromGate(ev))
      await ctx.evidence({ subject: sc.subject, status: sc.status, oracle: "deterministic", persistence: "point_in_time", source: `gate:${checkRun}`, commitSha: head, contractSha256: ev.contract_sha256 ?? null, detail: sc.detail, severity: sc.severity, artifactId: art, kind: "scan", checkName: sc.subject });
    await ctx.log("gate", `Gate verdict for ${head.slice(0, 8)}: ${verdict}${ev.reasons?.length ? ` (${ev.reasons.join("; ").slice(0, 200)})` : ""}`, { check_run: checkRun, verdict });
  }
  // the evidence package of this head: criterion status computed from the rows bound to it, integrity checked (deterministic)
  const ep = await assemblePackage(ctx.db, ctx.task, { head, stage: "gate" });
  if (existing.length === 0) await ctx.log("system", `Evidence package for ${head.slice(0, 8)}: ${ep.pkg.status} (${ep.pkg.summary.must.verified} of ${ep.pkg.summary.must_total} required criteria verified${ep.pkg.body.plan_task ? `, plan task ${ep.pkg.body.plan_task}` : ep.pkg.body.scope === "integrated" ? ", integrated result" : ""}).`, { evidence_package: ep.id, sha256: ep.sha256, artifact: ep.artifactId });
  const fact = { check_run: checkRun, head, verdict, evidence_package: ep.id };
  // evidence that cannot be trusted stops everything, whatever the verdict says
  if (!ep.pkg.body.integrity.chain_ok || ep.pkg.body.integrity.artifacts_bad.length)
    return blockEvidence(ctx, `Evidence integrity check failed for ${head.slice(0, 8)}: ${ep.pkg.body.inconsistencies.join("; ").slice(0, 300)}`, fact, { auto: false });
  if (kind === "pass") {
    // a passing verdict must be carried by criterion evidence bound to this head: a verdict alone is a claim
    if (ep.pkg.status !== "complete")
      return blockEvidence(ctx, `The gate reported ${verdict}, but the evidence bound to ${head.slice(0, 8)} is ${ep.pkg.status}: ${[...ep.pkg.body.inconsistencies, ...ep.pkg.body.gaps].join("; ").slice(0, 400)}`, fact, { auto: false });
    // an agent's claim is never enough: DONE requires the gate's DONE for this exact head, bound to the approved contract
    const c = await currentContract(ctx);
    if (c && ev.contract_sha256 && ev.contract_sha256 !== c.sha256)
      return blockEvidence(ctx, "The gate evaluated a different contract version than the approved one.", { ...fact, gate_contract: ev.contract_sha256, approved: c.sha256 }, { auto: false });
    // a plan task that is not the last one was judged on the criteria it covers: record it and build the next task. The LAST task
    // is the integrated result (gated against the complete contract) and continues to independent verification like any work.
    const cur = await planCursor(ctx);
    if (cur?.current && !cur.isLast) return ctx.goto("plan_task_done", { head, checkRun });
    return ctx.goto("acceptance_start", { head, checkRun });
  }
  if (kind === "candidate_failure") return routeFailure(ctx, verdict, ev, fact);
  if (kind === "tamper") {
    await ctx.transition("BLOCKED_DECISION", `Security stop: ${verdict}`, fact);
    await ctx.openDecision({
      kind: "block",
      title: `Security stop: gate verdict ${verdict}`,
      why: "The gate detected a change to owner-only paths or a foreign head. This path is stopped.",
      options: [{ id: "abandon", label: "Abandon the task", consequence: "Nothing is merged." }],
      context: { stage: "security", ...fact },
    });
    return ctx.goto("await_decision", {});
  }
  // BLOCKED:* from the gate: an Unknown must-criterion or missing evidence (never silently passed)
  const unknown = criteriaFromGate(ev).filter((c) => c.deciding && c.status === "unknown").map((c) => `${c.subject}: ${c.detail.slice(0, 120)}`);
  return blockEvidence(ctx, `Gate ${verdict}: ${[...(ev.reasons ?? []), ...unknown].join("; ").slice(0, 400) || "no reason given"}`, fact);
}

/**
 * Route a failing gate verdict to the party that owns it (V1): mechanical rules first, the independent arbiter otherwise.
 *   build/check/secret/canary failures      -> the Builder (the implementation is at fault by construction)
 *   every failing criterion an oracle defect -> the Verifier repairs the check (not charged; Builder work kept)
 *   anything else (behavioural criteria)    -> the arbiter decides implementation / oracle / environment / ambiguity
 */
async function routeFailure(ctx: TaskCtx, verdict: string, ev: GateEvidence, fact: Record<string, unknown>): Promise<void> {
  const details = correctionDetails(ev);
  if (!["FAIL:ORACLE", "FAIL:REGRESSION"].includes(verdict)) return correction(ctx, verdict, details, fact);
  if (verdict === "FAIL:REGRESSION") {
    const deps = await unmergedDependencies(ctx, criteriaFromGate(ev).filter((c) => c.status === "not_verified" && c.regression).map((c) => c.subject));
    if (deps.wait) return waitForDependencies(ctx, deps.keys, verdict);
  }
  if (verdict === "FAIL:REGRESSION" && !ctx.data.syncTried) {
    // a regression failure on a branch that is behind main is not evidence about the work: bring the branch up to date first
    return ctx.goto("sync_branch", { head: ctx.data.head, checkRun: ctx.data.checkRun, verdict });
  }
  const failing = criteriaFromGate(ev)
    .filter((c) => c.deciding && c.status !== "verified")
    .map((c) => ({ subject: c.subject, detail: c.detail, regression: c.regression }));
  const defects = oracleDefects(ev);
  if (defects && !failing.some((c) => c.regression)) {
    const list = defects.map((c) => `${c.subject.replace(/^.*:/, "")}: ${c.detail.split("\n")[0]!.slice(0, 300)}`).join("\n");
    const c = await currentContract(ctx);
    await ctx.log("system", `The oracle of record crashed or could not measure (${defects.map((d) => d.subject).join(", ")}); the Verifier repairs the check. Not charged to the Builder.`, fact);
    return ctx.goto("oracle_start", { mode: "repair", feedback: list, repairReason: list, prevCalibration: c?.calibration ?? null, repaired: defects.map((d) => d.subject), resume: { head: ctx.data.head }, round: 1 });
  }
  const failure = { head: String(ctx.data.head), verdict, details, failing, fact };
  return ctx.goto("attribute_start", { failure, envRetried: ctx.data.envRetried ?? false });
}

/**
 * A "regression" on the criteria of an EARLIER task whose contract is on main but whose work is not merged yet is not a regression
 * at all: that behaviour does not exist on main, so no branch built from main can pass it. It is neither the Builder's defect nor a
 * stale check (found in the first decomposed run: T6.a failed only on T4's criteria while T4 was still unaccepted). The task waits
 * for that work to be accepted, then takes it in from main and is gated again. Nobody is asked and no check is rewritten.
 */
export async function unmergedDependencies(ctx: TaskCtx, regressionSubjects: string[]): Promise<{ wait: boolean; keys: string[] }> {
  const keys = [...new Set(regressionSubjects.map((s) => s.split(":")[0]!).filter((k) => /^T[0-9]+$/.test(k) && k !== ctx.task.key))];
  if (keys.length === 0) return { wait: false, keys: [] };
  const rows = await ctx.db.select({ key: tasks.key, state: tasks.state }).from(tasks).where(and(eq(tasks.projectId, ctx.project.id), inArray(tasks.key, keys)));
  const open = rows.filter((r) => !["ACCEPTED", "REJECTED", "ABANDONED"].includes(r.state)).map((r) => r.key!);
  // wait only when EVERY failing regression criterion belongs to such unmerged work (anything else is judged normally)
  return { wait: open.length > 0 && keys.every((k) => open.includes(k)), keys: open };
}

export async function waitForDependencies(ctx: TaskCtx, keys: string[], verdict: string): Promise<void> {
  await ctx.log("system", `The gate failed only on criteria of ${keys.join(", ")}, whose work is not merged yet. Waiting for it to be accepted, then this branch takes it in from main and is gated again (nothing is charged, no check is changed).`, { waiting_for: keys });
  await ctx.goto("await_dependency", { keys, head: ctx.data.head ?? ctx.task.headSha, checkRun: ctx.data.checkRun ?? null, verdict });
}

/** Step: wait until the earlier tasks this branch depends on are merged (or gone), then update the branch with main and re-gate. */
export async function awaitDependency(ctx: TaskCtx): Promise<void> {
  const keys = (ctx.data.keys as string[]) ?? [];
  const rows = await ctx.db.select({ key: tasks.key, state: tasks.state }).from(tasks).where(and(eq(tasks.projectId, ctx.project.id), inArray(tasks.key, keys)));
  if (rows.some((r) => !["ACCEPTED", "REJECTED", "ABANDONED"].includes(r.state))) return;
  await ctx.log("system", `${keys.join(", ")} ${rows.every((r) => r.state === "ACCEPTED") ? "merged" : "no longer in progress"}; updating this branch with main and re-running the gate.`, {});
  // depsChecked: whatever the gate says on the updated branch is judged normally from here on
  await ctx.goto("sync_branch", { head: ctx.data.head, checkRun: ctx.data.checkRun, verdict: ctx.data.verdict, depsChecked: true });
}

async function routeBuilderClaim(ctx: TaskCtx, claim: string, art: number): Promise<boolean> {
  const head = ctx.task.headSha!;
  const prior = await ctx.db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.taskId, ctx.task.id), eq(evidence.commitSha, head), eq(evidence.kind, "attribution")));
  if (prior.length) return false; // already arbitrated for this head: the claim goes to the owner
  const [g] = await ctx.db.select().from(gateResults).where(and(eq(gateResults.taskId, ctx.task.id), eq(gateResults.headSha, head))).orderBy(desc(gateResults.id)).limit(1);
  if (!g || g.kind !== "candidate_failure") return false;
  const rows = await ctx.db
    .select()
    .from(evidence)
    .where(and(eq(evidence.taskId, ctx.task.id), eq(evidence.commitSha, head), like(evidence.source, "gate:%"), ne(evidence.status, "verified")));
  const failing = rows.map((r) => ({ subject: r.subject, detail: r.detail ?? "", regression: (r.detail ?? "").startsWith("regression") }));
  if (!failing.length) return false;
  await ctx.log("system", "The Builder claims the work cannot be verified; the independent arbiter tests the claim before any owner involvement.", { artifact: art });
  const details = failing.map((x) => `- ${x.subject}: ${x.detail.slice(0, 600)}`).join("\n");
  await ctx.goto("attribute_start", {
    failure: { head, verdict: g.verdict, details, failing, builderClaim: claim, fact: { check_run: g.checkRunId, head, verdict: g.verdict, builder_block_artifact: art } },
  });
  return true;
}

/**
 * Step: after an oracle-only amendment is merged, bring the task PR up to date with main (a merge commit made by GitHub on the task
 * branch - the Builder's work is kept) so the gate evaluates the SAME implementation against the repaired oracle.
 */
export async function resumeAfterOracle(ctx: TaskCtx): Promise<void> {
  const job = await ctx.once("upd", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "update_branch", id: "u", pr: ctx.task.prNumber }] }));
  if (!job) return;
  const u = job.status === "done" ? sub(job, "u") : undefined;
  if (job.status === "error" || !u?.ok) return harnessFailure(ctx, { ...job, error: job.error ?? JSON.stringify(u ?? {}).slice(0, 300) }, "upd", "updating the task branch with the repaired oracle");
  const head = String(u.head_sha);
  await ctx.transition("VERIFYING", `Task branch updated with the repaired oracle (Builder work kept; head ${head.slice(0, 8)}); gate re-evaluation started`, {
    pr: ctx.task.prNumber,
    head,
    previous_head: u.old_head ?? null,
    main: ctx.data.mainSha ?? null,
  }, { headSha: head });
  await ctx.goto("await_gate", { head, since: ctx.now().getTime() });
}

/**
 * Step: before attributing a regression failure, bring the task branch up to date with main (GitHub merge commit; the Builder's work
 * is kept). If the branch was behind, the gate runs again on the updated head; if it was already current, attribution proceeds.
 */
export async function syncBranch(ctx: TaskCtx): Promise<void> {
  const job = await ctx.once("upd", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "update_branch", id: "u", pr: ctx.task.prNumber }] }));
  if (!job) return;
  const u = job.status === "done" ? sub(job, "u") : undefined;
  if (u?.ok && u.head_sha) {
    const head = String(u.head_sha);
    await ctx.transition("VERIFYING", `The branch was behind main; updated (head ${head.slice(0, 8)}) and re-gated before judging the regression failure`, { pr: ctx.task.prNumber, head, previous_head: u.old_head ?? null }, { headSha: head });
    return ctx.goto("await_gate", { head, since: ctx.now().getTime(), syncTried: true, depsChecked: ctx.data.depsChecked ?? false });
  }
  // already up to date (or the update is not possible): judge the failure as it is
  return ctx.goto("gate_collect", { head: ctx.data.head, checkRun: ctx.data.checkRun, verdict: ctx.data.verdict, syncTried: true, depsChecked: ctx.data.depsChecked ?? false });
}

/** Automatic correction loop (no owner involvement) up to the project's budget; then a budget decision. */
export async function correction(ctx: TaskCtx, verdict: string, details: string, fact: Record<string, unknown>): Promise<void> {
  if (ctx.task.corrections >= ctx.project.maxCorrections + ctx.task.extraCorrections) {
    // shape rule 5: an exhausted atomic attempt re-classifies the PLAN (a new plan version; the contract and its version are untouched)
    const cur = await currentContract(ctx);
    if (cur) await recordPlan(ctx.db, cur, { facts: { budgetExhausted: true }, reason: "Correction budget exhausted on the atomic attempt." });
    await ctx.transition("BLOCKED_DECISION", `Correction budget exhausted (${ctx.task.corrections} corrections)`, fact);
    await ctx.openDecision({
      kind: "budget",
      title: `Correction budget exhausted on ${ctx.task.key}`,
      why: `The work failed verification ${ctx.task.corrections + 1} times (latest: ${verdict}). Continuing means more spend.`,
      options: [
        { id: "more", label: "Allow 2 more corrections", consequence: "The Builder continues with the latest findings." },
        { id: "abandon", label: "Abandon the task", consequence: "Nothing is merged." },
      ],
      recommendation: "more",
      context: { stage: "budget", verdict, details: details.slice(0, 4000) },
    });
    return ctx.goto("await_decision", {});
  }
  await ctx.save({ corrections: ctx.task.corrections + 1 });
  await ctx.log("system", `Correction ${ctx.task.corrections} of ${ctx.project.maxCorrections + ctx.task.extraCorrections}: returning the gate findings (${verdict}) to the Builder automatically.`, fact);
  await ctx.goto("fix_start", { verdict, details, head: ctx.task.headSha, fact });
}

export async function fixStart(ctx: TaskCtx): Promise<void> {
  if (await ctx.builderBusy()) return;
  const fix = correctionPrompt({ key: ctx.task.key! }, String(ctx.data.head), String(ctx.data.verdict), String(ctx.data.details));
  const resume = ctx.task.builderSessionId ?? undefined;
  // a failed check stage confined to a few named files is a BOUNDED REPAIR: the qualified local coder gets one attempt
  const plan = ctx.data.noLocal ? null : await repairPlan(ctx, String(ctx.data.verdict), String(ctx.data.details));
  if (plan?.route.local) return ctx.goto("local_fix", { verdict: ctx.data.verdict, details: ctx.data.details, head: ctx.data.head, fact: ctx.data.fact });
  // no session to resume (the work so far was built by the local coder): the Builder starts with its full instructions
  let prompt = fix;
  if (!resume) {
    const cur = await planCursor(ctx);
    const info = { name: ctx.project.name, description: ctx.project.description, stack: ctx.project.stack };
    const full = cur?.current
      ? planTaskPrompt(info, { key: ctx.task.key!, title: ctx.task.title }, cur.current, { index: cur.index, total: cur.order.length, done: cur.order.slice(0, cur.index).map((t) => t.id) })
      : buildPrompt(info, { key: ctx.task.key!, title: ctx.task.title });
    prompt = `${full}\n\nAN EARLIER ATTEMPT IS ALREADY IN THIS WORKSPACE (made by another worker). Keep what is right, fix what is not.\n${fix}`;
  }
  const s = await startSession(ctx, "correction", String(ctx.task.headSha), prompt, { resume });
  if (s === "wait") return;
  if (plan?.route.shadow) {
    try {
      await shadowCode(ctx, { cls: "bounded_repair", worker: plan.route.shadow, ref: String(ctx.task.headSha), instruction: repairInstruction(ctx.task.key!, String(ctx.data.verdict), String(ctx.data.details)), scope: plan.scope, context: [] });
    } catch {
      /* shadow bookkeeping never affects the task */
    }
  }
  await ctx.transition("IN_PROGRESS", `Correction ${ctx.task.corrections}: Builder resumed with the verification findings`, {
    run: s.runId,
    ...(ctx.data.fact as Record<string, unknown>),
  });
  await ctx.goto("build_poll", { runId: s.runId, container: s.container, baseSha: ctx.task.headSha });
}

/** Step: DONE, then the owner's acceptance on GitHub (the only identity allowed to approve merges), then merge. */
export async function markDone(ctx: TaskCtx): Promise<void> {
  const [g] = await ctx.db
    .select()
    .from(gateResults)
    .where(and(eq(gateResults.taskId, ctx.task.id), eq(gateResults.headSha, ctx.task.headSha ?? "")))
    .orderBy(desc(gateResults.id))
    .limit(1);
  if (!g || g.kind !== "pass") return blockEvidence(ctx, "DONE requires a passing gate result for the current head.", { head: ctx.task.headSha });
  const cur = await planCursor(ctx);
  if (cur?.current && cur.isLast) {
    // the integrated result passed the gate against the COMPLETE original contract (its branch is not a plan task). Integrated
    // verification additionally needs the independent Verifier to have actually judged this head: an Unknown never counts.
    const acc = ctx.data.acceptance as { run?: number; findings?: number } | string | null | undefined;
    const verified = !!acc && typeof acc === "object" && typeof acc.run === "number";
    if (!verified && Number(ctx.data.ivRetry ?? 0) < 2) {
      await ctx.log("system", "Integrated verification needs the independent Verifier; it did not produce a result - running it again.", {});
      return ctx.goto("acceptance_start", { head: ctx.task.headSha, ivRetry: Number(ctx.data.ivRetry ?? 0) + 1 });
    }
    await savePlan(
      ctx,
      cur,
      (t) => (verified ? { ...t, status: "done", evidence: [...t.evidence, `gate_result:${g.id}`, `pr:${ctx.task.prNumber}`, `head:${g.headSha}`] } : t),
      verified ? { required: true, status: "passed", head: g.headSha, contract_version: cur.body.contract_version, contract_sha256: cur.body.contract_sha256 } : undefined,
    );
  }
  // a decomposed contract is fulfilled only by its integrated result, verified against the ORIGINAL contract - never by tasks alone
  const blockers = await planBlockers(ctx.db, ctx.task.id);
  if (blockers.length) return blockEvidence(ctx, `The contract is not fulfilled yet: ${blockers.join("; ")}.`, { head: ctx.task.headSha, plan: true }, { auto: false });
  // the final evidence package (gate + independent Verifier evidence of this head) is what the acceptance decision rests on
  const ep = await assemblePackage(ctx.db, ctx.task, { head: g.headSha, stage: "done" });
  if (ep.pkg.status !== "complete")
    return blockEvidence(ctx, `DONE requires complete evidence for ${g.headSha.slice(0, 8)}; the evidence package is ${ep.pkg.status}: ${[...ep.pkg.body.inconsistencies, ...ep.pkg.body.gaps].join("; ").slice(0, 400)}`, { head: g.headSha, evidence_package: ep.id }, { auto: false });
  await ctx.transition("DONE", `All must-criteria verified by the gate for ${g.headSha.slice(0, 8)}${ctx.data.acceptance ? "; independent Verifier check found no blocking defect" : ""}`, {
    gate_result: g.id,
    check_run: g.checkRunId,
    head: g.headSha,
    contract_sha256: g.contractSha256,
    acceptance: ctx.data.acceptance ?? null,
    evidence_package: ep.id,
    evidence_package_sha256: ep.sha256,
  });
  const parent = ctx.task.stackParentId ? (await ctx.db.select().from(tasks).where(eq(tasks.id, ctx.task.stackParentId)))[0] : undefined;
  if (parent && parent.state === "ACCEPTED") {
    // the parent was accepted on its own meanwhile: bring this PR up to date with main and re-verify before asking for acceptance
    await ctx.save({ stackParentId: null });
    await ctx.log("system", `${parent.key} was accepted on its own; this task's PR is updated with main and re-verified.`, { parent: parent.id });
    return ctx.goto("restack", {});
  }
  if (parent && parent.state === "DONE") {
    const pctx = new TaskCtx(ctx.db, parent, ctx.project, ctx.now);
    await pctx.closeDecisions("acceptance", "stacked", "app", `accepted together with ${ctx.task.key} (PR #${ctx.task.prNumber})`);
    await pctx.log("system", `Acceptance moved to the stack: ${ctx.task.key} (PR #${ctx.task.prNumber}) contains this work and was verified with it.`, { child: ctx.task.id });
    await pctx.goto("await_stack", { child: ctx.task.id });
  }
  const together = parent && parent.state === "DONE" ? `${parent.key} + ` : "";
  await ctx.openDecision({
    kind: "acceptance",
    title: together ? `Accept ${together}${ctx.task.key} together (one PR): ${parent!.title} / ${ctx.task.title}` : `Accept ${ctx.task.key}: ${ctx.task.title}`,
    why: "The work is DONE by mechanical evidence. Merging needs your approval of the exact head on GitHub.",
    options: [
      { id: "github", label: `Approve PR #${ctx.task.prNumber} on GitHub`, consequence: "The control system merges it; the task becomes ACCEPTED." },
      { id: "reject", label: "Reject the result", consequence: "The PR is closed; nothing is merged." },
    ],
    recommendation: "github",
    context: { pr: ctx.task.prNumber, head: ctx.task.headSha, repo: ctx.project.repo, org: ctx.project.org, stack: together ? [parent!.id, ctx.task.id] : null, evidencePackage: { id: ep.id, sha256: ep.sha256, artifactId: ep.artifactId, status: ep.pkg.status } },
  });
  await ctx.goto("await_acceptance", { head: ctx.task.headSha });
}

export async function awaitAcceptance(ctx: TaskCtx): Promise<void> {
  const head = ctx.data.head as string;
  const [rej] = await ctx.db
    .select({ id: decisions.id, note: decisions.note })
    .from(decisions)
    .where(and(eq(decisions.taskId, ctx.task.id), eq(decisions.kind, "acceptance"), eq(decisions.status, "decided"), eq(decisions.choice, "reject")))
    .limit(1);
  if (rej) {
    await ctx.submit("transport", { repo: ctx.project.repo, ops: [{ op: "cleanup", id: "c", close: [ctx.task.prNumber] }] });
    await ctx.transition("REJECTED", `The owner rejected the result${rej.note ? `: ${rej.note.slice(0, 200)}` : ""}`, { decision: rej.id, pr: ctx.task.prNumber });
    return ctx.goto("cleanup", {});
  }
  if (!ctx.data.approvedAt) {
    if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return;
    const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: ctx.task.prNumber }] }));
    if (!job) return;
    await ctx.forget("state");
    if (job.status === "error") return harnessFailure(ctx, job, "state", "reading the task PR");
    const s = sub(job, "s");
    if (!s?.ok) return;
    if (s.merged) return finishAccepted(ctx, String(s.merge_commit), null);
    if (s.head !== head) return blockEvidence(ctx, "The PR head changed after DONE; the verdict no longer applies.", { expected: head, actual: s.head }, { auto: false });
    const a = ownerApproved(s, ctx.project.ownerLogin, head);
    if (!a.ok) return;
    await ctx.closeDecisions("acceptance", "approved", "github");
    await ctx.log("owner", `PR #${ctx.task.prNumber} approved on GitHub (head ${head.slice(0, 8)}).`, { at: a.at });
    await ctx.setData({ approvedAt: a.at });
  }
  const m = await ctx.once("merge", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "merge_approved", id: "m", pr: ctx.task.prNumber, owner: ctx.project.ownerLogin }] }));
  if (!m) return;
  const mr = m.status === "done" ? sub(m, "m") : undefined;
  if (m.status === "error" || !mr?.ok) {
    if (isBehind(mr)) {
      // main moved after this head was verified and approved: the ruleset demands an up-to-date branch. Not an infrastructure
      // failure and not retryable as-is: take main in, verify the new head, and ask for acceptance of THAT head (an approval is
      // bound to the exact commit - GitHub dismisses it when the branch changes).
      await ctx.log("system", `PR #${ctx.task.prNumber} was approved but main has moved since; the branch is brought up to date and verified again. Your approval was for ${String(ctx.data.head).slice(0, 8)} and is needed once more for the updated head.`, { pr: ctx.task.prNumber });
      return ctx.goto("restack", {});
    }
    await ctx.forget("merge");
    return harnessFailure(ctx, { ...m, error: m.error ?? JSON.stringify(mr ?? {}).slice(0, 300) }, "merge", "merging the accepted PR");
  }
  return finishAccepted(ctx, String(mr.merge_commit), String(ctx.data.approvedAt ?? mr.approval_at ?? ""));
}

async function finishAccepted(ctx: TaskCtx, mergeCommit: string, approvedAt: string | null) {
  if (ctx.task.stackParentId) {
    const [parent] = await ctx.db.select().from(tasks).where(eq(tasks.id, ctx.task.stackParentId));
    if (parent && parent.state === "DONE" && parent.step === "await_stack") {
      const pctx = new TaskCtx(ctx.db, parent, ctx.project, ctx.now);
      await pctx.submit("transport", { repo: ctx.project.repo, ops: [{ op: "cleanup", id: "c", close: [parent.prNumber] }] });
      await pctx.transition("ACCEPTED", `Accepted by the owner together with ${ctx.task.key}: PR #${ctx.task.prNumber} contained this work (verified at ${String(parent.headSha).slice(0, 8)} and again in the stack) and was merged (${mergeCommit.slice(0, 8)})`, {
        stacked_in: ctx.task.id,
        pr: ctx.task.prNumber,
        head: parent.headSha,
        merge_commit: mergeCommit,
        owner_approved_at: approvedAt,
      }, { mergeCommit });
      await pctx.goto("cleanup", {});
    }
  }
  await ctx.transition("ACCEPTED", `Accepted by the owner on GitHub and merged (${mergeCommit.slice(0, 8)})`, {
    pr: ctx.task.prNumber,
    head: ctx.task.headSha,
    merge_commit: mergeCommit,
    owner_approved_at: approvedAt,
  }, { mergeCommit });
  await ctx.goto("cleanup", {});
}

export async function cleanup(ctx: TaskCtx): Promise<void> {
  const v = vols(ctx.task.id);
  // the per-task PRs of a decomposed contract were never merged on their own: the integrated PR carried them. Close them.
  const row = await activePlan(ctx.db, ctx.task.id);
  const ev = row ? PlanBody.parse(row.body).tasks.flatMap((t) => t.evidence) : [];
  const prs = [...new Set(ev.filter((e) => e.startsWith("pr:")).map((e) => Number(e.slice(3))))].filter((n) => n && n !== ctx.task.prNumber);
  const branches = [...new Set(ev.filter((e) => e.startsWith("branch:")).map((e) => e.slice(7)))].filter((b) => b !== ctx.task.branch);
  if (prs.length && !("planPrs" in ctx.data)) {
    await ctx.setData({ planPrs: await ctx.submit("transport", { repo: ctx.project.repo, ops: [{ op: "cleanup", id: "c", close: prs, delete_branches: branches }] }) });
    return;
  }
  const j = await ctx.once("rm", "vol_rm", () => ({ names: [v.worktree, v.export, v.final] }));
  if (!j) return;
  await ctx.goto("done", {});
}

/** Step (stack parent): the child task carries this work; wait for it. If the child leaves the stack, this task's own acceptance returns. */
export async function awaitStack(ctx: TaskCtx): Promise<void> {
  const [child] = await ctx.db.select().from(tasks).where(eq(tasks.id, Number(ctx.data.child)));
  if (!child || ["REJECTED", "ABANDONED"].includes(child.state)) {
    await ctx.log("system", `The stacked task ${child?.key ?? ""} left the stack; ${ctx.task.key} returns to its own acceptance.`, { child: ctx.data.child });
    return ctx.goto("mark_done", {});
  }
}

/** Step: bring a stacked task's PR up to date with main (its parent was merged separately) and re-verify. */
export async function restack(ctx: TaskCtx): Promise<void> {
  const job = await ctx.once("upd", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "update_branch", id: "u", pr: ctx.task.prNumber }] }));
  if (!job) return;
  const u = job.status === "done" ? sub(job, "u") : undefined;
  if (job.status === "error" || !u?.ok) return harnessFailure(ctx, { ...job, error: job.error ?? JSON.stringify(u ?? {}).slice(0, 300) }, "upd", "updating the task branch with main");
  if (u.up_to_date) {
    // nothing to bring in: the verified head is unchanged, so its verdict stands (no re-verification of an identical head)
    await ctx.log("system", "The PR is already up to date with main; its verified head is unchanged.", { pr: ctx.task.prNumber, head: ctx.task.headSha });
    return ctx.goto("mark_done", {});
  }
  const head = String(u.head_sha);
  await ctx.transition("VERIFYING", `PR updated with main (head ${head.slice(0, 8)}); gate re-evaluation started`, { pr: ctx.task.prNumber, head, previous_head: u.old_head ?? null }, { headSha: head });
  await ctx.goto("await_gate", { head, since: ctx.now().getTime() });
}

export { ownerApproved, latestGate };
