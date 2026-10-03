import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { contracts, evidence } from "@/db/schema";
import { oracleCriteria, outcomeChanged, sha256, type Contract } from "@/domain/contract";
import { calibrate, isOracleDefect, loosenedCriteria, staticOracleProblems, type OracleResult } from "@/domain/oracle-check";
import { contractEscalation } from "@/domain/policy";
import { oraclePrompt, VERIFIER_SCAFFOLD } from "@/domain/prompts";
import type { TaskCtx } from "./context";
import { currentContract, type ContractRow } from "./steps-contract";
import { b64, blockEvidence, harnessFailure, mainSha, sub, unb64, vols } from "./common";
import { finishSession, ledger, routeFor } from "./sessions";

/*
 * The oracle lifecycle. An oracle (the Verifier's black-box check of record) becomes authoritative only after it has passed, in order:
 *   1. syntax check,
 *   2. static validation of its declared execution environment (modules, files, hosts, env vars),
 *   3. calibration against the project's current main (the feature absent): every criterion must produce a verdict, nothing may
 *      crash or report a HARNESS problem, and - for a repair - no criterion may become weaker (a check that failed on main must still
 *      fail there).
 * Each failure goes back to the Verifier with the mechanical findings (never to the Builder, never to the owner) - up to three
 * authoring attempts. Nothing here looks at an implementation; the product criteria are never changed.
 *
 * Mode "contract": a new contract's oracle -> owner contract review.
 * Mode "repair": the SAME approved contract with a defective oracle -> an oracle-only amendment (owner approves only the protected
 * oracle file on GitHub), and the Builder's work is kept.
 */
const MAX_ATTEMPTS = 3;

type Mode = "contract" | "repair";

export async function oracleStart(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  if (!c) return blockEvidence(ctx, "No current contract to author an oracle for.", { task: ctx.task.id });
  const mode: Mode = ctx.data.mode === "repair" ? "repair" : "contract";
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const sha = mainSha(refs, ctx.project.repo)!;
  const ifaces = ctx.project.interfaceTasks.filter((k) => k !== ctx.task.key);
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha, paths: ifaces.map((k) => `tasks/${k}/contract.json`) }));
  if (!show) return;
  if (show.status === "error") return harnessFailure(ctx, show, "show", "reading earlier contracts");
  const files: Record<string, string> = { "contract.json": b64(c.text), "SCAFFOLD.md": b64(VERIFIER_SCAFFOLD) };
  const ifaceNames: string[] = [];
  for (const k of ifaces) {
    const v = show.result?.[`tasks/${k}/contract.json`];
    if (typeof v === "string") {
      files[`${k}-contract.json`] = v;
      ifaceNames.push(`${k}-contract.json`);
    }
  }
  if (mode === "repair" && c.oracleJs) files["previous-check.mjs"] = b64(c.oracleJs);
  const docNames = Object.keys(ctx.project.workerDocs);
  for (const [n, body] of Object.entries(ctx.project.workerDocs)) files[n] = b64(body);
  const criteria = oracleCriteria(c.body as unknown as Contract);
  const attempt = Number(ctx.data.attempt ?? 1);
  const tag = `${mode === "repair" ? "p" : "o"}${c.version}${attempt > 1 ? `r${attempt}` : ""}${mode === "repair" ? `x${Number(ctx.data.round ?? 1)}` : ""}`;
  const feedback = (ctx.data.feedback as string | undefined) ?? (mode === "contract" ? await lastOracleDefects(ctx) : undefined);
  const job = await ctx.once("verifier", "verifier", () => ({
    work_vol: vols(ctx.task.id).verifier(tag),
    prompt: oraclePrompt(ctx.task.key!, criteria, ifaceNames, docNames, feedback, mode === "repair"),
    files,
  }));
  if (!job) return;
  if (job.status === "error") return harnessFailure(ctx, job, "verifier", "starting the Verifier");
  const container = String(job.result?.detached ?? "");
  const runId = await ctx.startRun({ role: "verifier", purpose: mode === "repair" ? "repair_oracle" : "author_oracle", container, status: "running", ...ledger("check_author", await routeFor(ctx, "check_author")) });
  await ctx.log(
    "verifier",
    mode === "repair"
      ? `Verifier repairing the oracle of ${ctx.task.key} (contract v${c.version} unchanged, attempt ${attempt}); findings: ${String(feedback ?? "").slice(0, 200)}`
      : `Verifier started (blind: contract v${c.version} only) to author the oracle of record for ${criteria.join(", ")}${attempt > 1 ? ` (attempt ${attempt})` : ""}.`,
    { run: runId },
  );
  await ctx.goto("oracle_poll", { ...keep(ctx), runId, container, contractId: c.id, tag, attempt });
}

/** Data that travels through the whole oracle pipeline. */
function keep(ctx: TaskCtx) {
  const d = ctx.data;
  return { mode: d.mode ?? "contract", round: d.round, repairReason: d.repairReason, prevCalibration: d.prevCalibration, resume: d.resume, repaired: d.repaired };
}

export async function oraclePoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") return;
  await ctx.goto("oracle_collect", { ...keep(ctx), runId: ctx.data.runId, contractId: ctx.data.contractId, tag: ctx.data.tag, attempt: ctx.data.attempt ?? 1 });
}

/** Syntax check of a worker-authored oracle (it is never executed here - only parsed). */
export function checkSyntax(js: string): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), "oracle-"));
  try {
    const f = path.join(dir, "check.mjs");
    writeFileSync(f, js);
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8", timeout: 20000 });
    return r.status === 0 ? null : (r.stderr || "syntax check failed").slice(0, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function retryAuthoring(ctx: TaskCtx, what: string, problems: string[], runId: number) {
  const attempt = Number(ctx.data.attempt ?? 1);
  await ctx.evidence({
    subject: `oracle-validation:${ctx.task.key}`,
    status: "not_verified",
    oracle: "deterministic",
    persistence: "point_in_time",
    source: `oracle-${what}`,
    detail: `Attempt ${attempt} rejected by ${what}: ${problems.join("; ").slice(0, 1500)}`,
  });
  if (attempt < MAX_ATTEMPTS) {
    await ctx.log("system", `The oracle failed ${what} (attempt ${attempt}); returned to the Verifier with the findings: ${problems.join("; ").slice(0, 300)}`, { run: runId });
    return ctx.goto("oracle_start", { ...keep(ctx), attempt: attempt + 1, feedback: problems.join("\n") });
  }
  return blockEvidence(ctx, `The Verifier could not produce a valid oracle in ${MAX_ATTEMPTS} attempts (${what}): ${problems.join("; ").slice(0, 300)}`, { run: runId, stage: what });
}

export async function oracleCollect(ctx: TaskCtx): Promise<void> {
  const tag = ctx.data.tag as string;
  const dump = await ctx.once("dump", "dump", () => ({ vol: vols(ctx.task.id).verifier(tag), paths: ["out/check.mjs", "out/NOTES.md"] }));
  if (!dump) return;
  if (dump.status === "error") return harnessFailure(ctx, dump, "dump", "reading the Verifier's oracle");
  const js = unb64(dump.result?.["out/check.mjs"]);
  const notes = unb64(dump.result?.["out/NOTES.md"]);
  const runId = ctx.data.runId as number;
  if (!js || js.length < 100 || !js.includes("criterion")) {
    await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
    return retryAuthoring(ctx, "the output check", ["no out/check.mjs was written"], runId);
  }
  await ctx.updateRun(runId, { outcome: "output" });
  const syntax = checkSyntax(js);
  if (syntax) return retryAuthoring(ctx, "the syntax check", [syntax], runId);
  const problems = staticOracleProblems(js);
  if (problems.length) return retryAuthoring(ctx, "static environment validation", problems, runId);
  await ctx.goto("oracle_calibrate", { ...keep(ctx), js, notes, runId, attempt: ctx.data.attempt ?? 1 });
}

/**
 * Step: calibration run against the project's current main in a real preview (the gate's own environment). Harness problems of the
 * executor here never block: the result is recorded as Unknown and the owner sees it.
 */
export async function oracleCalibrate(ctx: TaskCtx): Promise<void> {
  const js = String(ctx.data.js);
  const c = await currentContract(ctx);
  if (!c) return;
  const mode: Mode = ctx.data.mode === "repair" ? "repair" : "contract";
  const v = vols(ctx.task.id);
  const pv = `t${ctx.task.id}`;
  const expected = oracleCriteria(c.body as unknown as Contract);
  const done = async (cal: Cal | null, problems: string[]) => {
    if (mode === "repair") return oracleAmend(ctx, c, js, cal);
    return openContractApproval(ctx, c, js, (ctx.data.notes as string | null) ?? null, ctx.data.runId as number, cal, problems);
  };
  // Calibration could not RUN (infrastructure, not the check): that is never the owner's question and never a reason to offer an
  // uncalibrated check. The step is repeated automatically (self-recovery) with its inputs kept; only if that is exhausted does the
  // task block as a genuine blocker.
  const skip = async (why: string) => {
    await ctx.submit("preview", { candidate: pv, action: "down" });
    await ctx.evidence({ subject: `oracle-calibration:${ctx.task.key}`, status: "unknown", oracle: "deterministic", persistence: "point_in_time", source: "oracle-calibration", detail: `Calibration against main not completed (${why}).` });
    return blockEvidence(ctx, `The check could not be calibrated against main (${why}): infrastructure, not the check.`, { stage: "calibration", why }, { resumeData: { ...keep(ctx), js, notes: ctx.data.notes ?? null, runId: ctx.data.runId, attempt: ctx.data.attempt ?? 1 } });
  };
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  const main = refs.status === "done" ? mainSha(refs, ctx.project.repo) : undefined;
  if (!main) return skip("repository refs");
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: main }));
  if (!wt) return;
  if (wt.status === "error") return skip("worktree");
  const xf = await ctx.once("xf", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}` }));
  if (!xf) return;
  if (xf.status === "error") return skip("export");
  const up = await ctx.once("pv", "preview", () => ({ candidate: pv, action: "up", xfer_ctx: `agents-${ctx.task.id}`, tag: main.slice(0, 12) }));
  if (!up) return;
  if (up.status === "error" || !up.result?.build_ok || !up.result?.health) return skip("preview of main");
  const run = await ctx.once("run", "oracle_run", () => ({ preview: pv, oracle_js: js }));
  if (!run) return;
  const down = await ctx.once("down", "preview", () => ({ candidate: pv, action: "down" }));
  if (!down) return;
  if (run.status === "error") return skip("oracle run");
  const res = (run.result?.results as OracleResult[] | undefined) ?? [];
  const cal = calibrate(expected, res, String(run.result?.stderr ?? ""));
  const problems = [...cal.problems];
  const prev = ctx.data.prevCalibration as Cal | undefined;
  if (mode === "repair" && prev) {
    // criteria whose check was itself found defective are exempt: their earlier "fail on main" may have been the defect, not the product
    const exempt = new Set(((ctx.data.repaired as string[] | undefined) ?? []).map((k) => String(k).replace(/^.*:/, "")));
    const loosened = loosenedCriteria(prev.failsOnMain, cal.failsOnMain).filter((k) => !exempt.has(k));
    for (const k of loosened)
      problems.push(`${k}: the previous check FAILED on main (the feature does not exist there) but the repaired check PASSES there - the repair made the check weaker; keep every product assertion and fix only the harness`);
  }
  const headSha = (ctx.data.resume as { head?: string } | undefined)?.head;
  if (mode === "repair" && headSha && !problems.length) {
    // a repaired check must also EXECUTE against the build it will judge (the arbiter showed the application is fine there): any
    // crash / harness signature on that build means the repair did not fix the defect. Passing is not required here.
    const wh = await ctx.once("wth", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: headSha }));
    if (!wh) return;
    const xh = wh.status === "done" ? await ctx.once("xfh", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}` })) : wh;
    if (!xh) return;
    const uh = xh.status === "done" ? await ctx.once("pvh", "preview", () => ({ candidate: pv, action: "up", xfer_ctx: `agents-${ctx.task.id}`, tag: headSha.slice(0, 12) })) : xh;
    if (!uh) return;
    if (uh.status === "done" && uh.result?.build_ok && uh.result?.health) {
      const rh = await ctx.once("runh", "oracle_run", () => ({ preview: pv, oracle_js: js }));
      if (!rh) return;
      const dh = await ctx.once("downh", "preview", () => ({ candidate: pv, action: "down" }));
      if (!dh) return;
      if (rh.status === "done") {
        const onHead = calibrate(expected, (rh.result?.results as OracleResult[] | undefined) ?? [], String(rh.result?.stderr ?? ""));
        for (const pr of onHead.problems) problems.push(`against the build under test (${headSha.slice(0, 8)}): ${pr}`);
      }
    }
  }
  const attempt = Number(ctx.data.attempt ?? 1);
  if (!problems.length)
    await ctx.evidence({
      subject: `oracle-calibration:${ctx.task.key}`,
      status: "verified",
      oracle: "deterministic",
      persistence: "point_in_time",
      source: "oracle-calibration",
      commitSha: main,
      detail: `Calibrated against main ${main.slice(0, 8)} (feature absent), attempt ${attempt}: ${res.map((r) => `${r.criterion}=${r.result}`).join(", ")}`,
    });
  if (problems.length) return retryAuthoring(ctx, "calibration against main", problems, ctx.data.runId as number);
  await ctx.log("system", `Oracle calibrated against main ${main.slice(0, 8)}: every criterion produced a verdict, no harness defect${mode === "repair" ? ", no criterion weakened" : ""}.`, {});
  return done({ main, failsOnMain: cal.failsOnMain, passesOnMain: cal.passesOnMain, attempts: attempt }, []);
}

type Cal = { main: string; failsOnMain: string[]; passesOnMain: string[]; attempts: number };

async function lastOracleDefects(ctx: TaskCtx): Promise<string | undefined> {
  const rows = await ctx.db.select().from(evidence).where(eq(evidence.taskId, ctx.task.id)).orderBy(desc(evidence.id)).limit(200);
  const d = rows.filter((r) => r.subject.startsWith(`${ctx.task.key}:`) && isOracleDefect(r.detail)).slice(0, 12);
  return d.length ? d.map((r) => `${r.subject}: ${(r.detail ?? "").split("\n")[0]!.slice(0, 300)}`).join("\n") : undefined;
}

export async function openContractApproval(ctx: TaskCtx, c: ContractRow, js: string, notes: string | null, runId: number, cal: Cal | null, problems: string[] = []) {
  const oracleSha = sha256(js);
  await ctx.artifact("oracle", `oracle/${ctx.task.key}/check.mjs (contract v${c.version})`, js);
  if (notes) await ctx.artifact("verifier-notes", "Verifier NOTES.md", notes);
  await ctx.db.update(contracts).set({ oracleJs: js, oracleSha256: oracleSha, status: "review", calibration: cal }).where(eq(contracts.id, c.id));
  const decision = {
    kind: "contract_approval" as const,
    title: `Approve the contract for ${ctx.task.key}: ${ctx.task.title}`,
    why: "Work may start only on an approved contract. Once approved it is frozen; changes need an amendment.",
    options: [
      { id: "approve", label: "Approve contract", consequence: "The contract and its oracle become authoritative in the repository and the build starts." },
      { id: "changes", label: "Request changes", consequence: "The drafter revises the contract using your note." },
      { id: "reject", label: "Reject the intent", consequence: "The task ends; nothing is built." },
    ],
    recommendation: "approve",
    context: { contractId: c.id, version: c.version, sha256: c.sha256, oracleSha256: oracleSha, notes: notes ?? null, calibration: cal, problems } as Record<string, unknown>,
  };
  // A contract that exists is not a reason to ask the owner. It is approved automatically when it mechanically stays within the
  // recorded intent; the owner is asked only for a real owner-level decision (domain/policy.ts).
  const escalate = contractEscalation({ taskTier: ctx.task.tier, body: c.body as unknown as Contract, lintOk: c.lint?.ok === true, oracleProblems: problems, calibrated: cal !== null });
  // A new version whose REQUIRED OUTCOME is identical to the merged one (an assumption corrected, a trace fixed, wording clarified)
  // is still a new integer version, but it is approved by policy: the owner already holds the outcome it describes.
  const merged = await mergedContract(ctx);
  const sameOutcome = !!merged && merged.id !== c.id && merged.kind === "contract" && c.lint?.ok === true && problems.length === 0 && cal !== null && !outcomeChanged(merged.body as unknown as Contract, c.body as unknown as Contract);
  if (sameOutcome) {
    await ctx.db.update(contracts).set({ status: "approved_app" }).where(eq(contracts.id, c.id));
    await ctx.policyDecision(decision, "approve", `Contract v${c.version} changes no criterion, constraint, scope, non-goal or interface of the merged v${merged!.version}: the required outcome is unchanged.`);
    return ctx.goto("contract_batch", { contractId: c.id, since: ctx.now().getTime() });
  }
  if (escalate.length === 0) {
    await ctx.db.update(contracts).set({ status: "approved_app" }).where(eq(contracts.id, c.id));
    await ctx.policyDecision(decision, "approve", `Contract v${c.version} (sha256 ${c.sha256.slice(0, 12)}) is lint-clean, standard tier, touches no trust boundary, and its check passed validation and calibration: within the recorded intent.`);
    return ctx.goto("contract_batch", { contractId: c.id, since: ctx.now().getTime() });
  }
  decision.why = `This contract needs your decision: ${escalate.join("; ")}.`;
  decision.context.escalation = escalate;
  await ctx.openDecision(decision);
  await ctx.log("verifier", `Oracle of record written and validated (${js.length} bytes, sha ${oracleSha.slice(0, 12)}); contract v${c.version} needs your approval: ${escalate.join("; ")}.`, {
    run: runId,
  });
  await ctx.goto("await_owner_contract", { contractId: c.id });
}

/**
 * Oracle-only amendment: the approved contract bytes stay exactly as they are; a new contract row of kind "oracle_revision" carries
 * the repaired oracle. The protected oracle file changes only through an owner-approved PR on GitHub (the trust boundary); there is
 * no in-app contract review, because the product contract did not change.
 */
async function oracleAmend(ctx: TaskCtx, c: ContractRow, js: string, cal: Cal | null) {
  const [last] = await ctx.db.select().from(contracts).where(eq(contracts.taskId, ctx.task.id)).orderBy(desc(contracts.version)).limit(1);
  const version = (last?.version ?? c.version) + 1;
  const oracleSha = sha256(js);
  const [row] = await ctx.db
    .insert(contracts)
    .values({
      taskId: ctx.task.id,
      version,
      body: c.body,
      text: c.text,
      sha256: c.sha256,
      lint: c.lint,
      oracleJs: js,
      oracleSha256: oracleSha,
      status: "approved_app",
      kind: "oracle_revision",
      calibration: cal,
      ownerNote: String(ctx.data.repairReason ?? "").slice(0, 2000),
    })
    .returning();
  await ctx.save({ currentContractId: row!.id });
  await ctx.artifact("oracle", `oracle/${ctx.task.key}/check.mjs (repair, contract unchanged, rev ${version})`, js);
  await ctx.log("verifier", `Repaired oracle validated (sha ${oracleSha.slice(0, 12)}); proposing an oracle-only amendment (contract ${c.sha256.slice(0, 12)} unchanged).`, {});
  await ctx.goto("contract_pr", { contractId: row!.id, resume: ctx.data.resume ?? null });
}

/** The contract row of the currently merged (authoritative) version, if any. */
export async function mergedContract(ctx: TaskCtx): Promise<ContractRow | undefined> {
  const [c] = await ctx.db
    .select()
    .from(contracts)
    .where(and(eq(contracts.taskId, ctx.task.id), eq(contracts.status, "merged")))
    .orderBy(desc(contracts.version))
    .limit(1);
  return c;
}

export { sub };
