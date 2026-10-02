import { and, desc, eq, inArray, like, ne, notInArray, sql } from "drizzle-orm";
import { decisions, evidence, gateResults, tasks } from "@/db/schema";
import { classifyVerdict } from "@/domain/lifecycle";
import { criteriaFromGate, correctionDetails, oracleDefects, type GateEvidence } from "@/domain/gate";
import { buildPrompt, correctionPrompt, noOutcomePrompt, OUTCOME_DIR } from "@/domain/prompts";
import { routineChoice } from "@/domain/policy";
import { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { blockEvidence, harnessFailure, latestGate, mainSha, ownerApproved, pollDue, PROTECTED, sub, unb64, vols } from "./common";
import { finishSession, startSession } from "./sessions";

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
    await ctx.log("system", `Stacked on ${parent.key} (DONE at ${String(parent.headSha).slice(0, 8)}, awaiting acceptance): this task builds on its head and both are accepted together.`, { parent: parent.id, parent_head: parent.headSha });
    await ctx.setData({ mainSha: parent.headSha });
  }
  if (!parent) {
    // always build on the CURRENT main (other tasks or check amendments may have been merged since this contract was merged)
    const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
    if (!refs) return;
    const m = refs.status === "done" ? mainSha(refs, ctx.project.repo) : undefined;
    if (m) await ctx.setData({ mainSha: m });
  }
  const base = String(ctx.data.mainSha ?? c?.mergeCommit ?? "");
  if (!base) return blockEvidence(ctx, "No merged contract commit to build on.", { contract: c?.id ?? null });
  const prompt = buildPrompt({ name: ctx.project.name, description: ctx.project.description, stack: ctx.project.stack }, { key: ctx.task.key!, title: ctx.task.title });
  const s = await startSession(ctx, "build", base, prompt);
  if (s === "wait") return;
  await ctx.transition("IN_PROGRESS", "Builder started on the approved contract", { run: s.runId, container: s.container, base_sha: base, contract: c?.id ?? null });
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
    const opts = Array.isArray(rec.options) ? (rec.options as unknown[]).slice(0, 6).map((o, i) => ({ id: `o${i + 1}`, label: typeof o === "string" ? o : String((o as { label?: unknown }).label ?? `Option ${i + 1}`), consequence: typeof o === "string" ? "The contract is amended accordingly and the build continues." : String((o as { consequence?: unknown }).consequence ?? "") })) : [];
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
      context: { stage: "build", artifactId: art, runId, criteria: rec.criteria ?? [], tried: rec.tried ?? null },
    };
    const auto = kind === "BLOCKED_DECISION" ? routineChoice({ cls: rec.class, recommendation: dec.recommendation, options: dec.options, taskTier: ctx.task.tier, text: `${dec.title} ${dec.why}` }) : null;
    if (auto) await ctx.policyDecision(dec, auto, "Routine, reversible choice inside the approved contract; the Builder's recommended option was selected.");
    else await ctx.openDecision(dec);
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
  const title = `${ctx.task.key}: ${ctx.task.title}`;
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
            branch: `task/${ctx.task.key}/agents-${ctx.task.id}`,
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
  const branch = isUpdate ? ctx.task.branch! : `task/${ctx.task.key}/agents-${ctx.task.id}`;
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
      });
    await ctx.log("gate", `Gate verdict for ${head.slice(0, 8)}: ${verdict}${ev.reasons?.length ? ` (${ev.reasons.join("; ").slice(0, 200)})` : ""}`, { check_run: checkRun, verdict });
  }
  const fact = { check_run: checkRun, head, verdict };
  if (kind === "pass") {
    // an agent's claim is never enough: DONE requires the gate's DONE for this exact head, bound to the approved contract
    const c = await currentContract(ctx);
    if (c && ev.contract_sha256 && ev.contract_sha256 !== c.sha256)
      return blockEvidence(ctx, "The gate evaluated a different contract version than the approved one.", { ...fact, gate_contract: ev.contract_sha256, approved: c.sha256 }, { auto: false });
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
  const unknown = criteriaFromGate(ev).filter((c) => c.status === "unknown").map((c) => `${c.subject}: ${c.detail.slice(0, 120)}`);
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
  if (verdict === "FAIL:REGRESSION" && !ctx.data.syncTried) {
    // a regression failure on a branch that is behind main is not evidence about the work: bring the branch up to date first
    return ctx.goto("sync_branch", { head: ctx.data.head, checkRun: ctx.data.checkRun, verdict });
  }
  const failing = criteriaFromGate(ev)
    .filter((c) => c.status !== "verified")
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

async function routeBuilderClaim(ctx: TaskCtx, claim: string, art: number): Promise<boolean> {
  const head = ctx.task.headSha!;
  const prior = await ctx.db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.taskId, ctx.task.id), eq(evidence.commitSha, head), like(evidence.subject, "attribution:%")));
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
    return ctx.goto("await_gate", { head, since: ctx.now().getTime(), syncTried: true });
  }
  // already up to date (or the update is not possible): judge the failure as it is
  return ctx.goto("gate_collect", { head: ctx.data.head, checkRun: ctx.data.checkRun, verdict: ctx.data.verdict, syncTried: true });
}

/** Automatic correction loop (no owner involvement) up to the project's budget; then a budget decision. */
export async function correction(ctx: TaskCtx, verdict: string, details: string, fact: Record<string, unknown>): Promise<void> {
  if (ctx.task.corrections >= ctx.project.maxCorrections + ctx.task.extraCorrections) {
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
  const prompt = correctionPrompt({ key: ctx.task.key! }, String(ctx.data.head), String(ctx.data.verdict), String(ctx.data.details));
  const resume = ctx.task.builderSessionId ?? undefined;
  const s = await startSession(ctx, "correction", String(ctx.task.headSha), resume ? prompt : prompt, { resume });
  if (s === "wait") return;
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
  await ctx.transition("DONE", `All must-criteria verified by the gate for ${g.headSha.slice(0, 8)}${ctx.data.acceptance ? "; independent Verifier check found no blocking defect" : ""}`, {
    gate_result: g.id,
    check_run: g.checkRunId,
    head: g.headSha,
    contract_sha256: g.contractSha256,
    acceptance: ctx.data.acceptance ?? null,
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
    context: { pr: ctx.task.prNumber, head: ctx.task.headSha, repo: ctx.project.repo, org: ctx.project.org, stack: together ? [parent!.id, ctx.task.id] : null },
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
  const head = String(u.head_sha);
  await ctx.transition("VERIFYING", `PR updated with main after the stack parent was merged (head ${head.slice(0, 8)}); gate re-evaluation started`, { pr: ctx.task.prNumber, head, previous_head: u.old_head ?? null }, { headSha: head });
  await ctx.goto("await_gate", { head, since: ctx.now().getTime() });
}

export { ownerApproved, latestGate };
