import { eq } from "drizzle-orm";
import { runs } from "@/db/schema";
import type { Contract } from "@/domain/contract";
import { staticOracleProblems } from "@/domain/oracle-check";
import { acceptancePrompt, VERIFIER_SCAFFOLD } from "@/domain/prompts";
import { assessVerifier, needsReproduction, verificationScope, type Assessment, type ReproResult } from "@/domain/verification";
import { verificationPlan } from "@/domain/policy";
import type { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { correction, markDone } from "./steps-build";
import { b64, blockEvidence, mainSha, unb64, vols } from "./common";
import { finishSession, ledger, routeFor } from "./sessions";
import { latestPackage } from "./evidence";
import { checkSyntax } from "./steps-oracle";

const previewKey = (taskId: number) => `t${taskId}`;

/**
 * Independent post-build check by the Verifier (different vendor, blind to code and to the Builder's narrative) against a local
 * preview of the exact head. It is one evidence source, not truth (bake-off lesson 3): its findings are agent judgment, reproduced
 * steps are stored, and only critical/high findings send the work back automatically.
 */
export async function acceptanceStart(ctx: TaskCtx): Promise<void> {
  const head = String(ctx.data.head);
  const v = vols(ctx.task.id);
  const fail = async (what: string, err: unknown) => {
    await ctx.log("executor", `Independent Verifier check unavailable (${what}): ${String(err).slice(0, 200)}`, {});
    await ctx.evidence({
      subject: "independent-verifier",
      status: "unknown",
      oracle: "agent_judgment",
      persistence: "point_in_time",
      source: "verifier:unavailable",
      commitSha: head,
      detail: `The independent Verifier check could not run (${what}); the gate's deterministic evidence stands alone.`,
    });
    // Unknown is recorded, not escalated: it blocks only where the tier requires independent evidence (critical)
    if (verificationPlan(ctx.task.tier).unknownBlocks) return blockEvidence(ctx, `Critical tier: the independent Verifier check is required but could not run (${what}).`, { head });
    await ctx.goto("mark_done", { acceptance: "unavailable" });
  };
  // Precedence: the Verifier is asked only about a head the deterministic evidence already carries. It can add findings; it can
  // never stand in for a gate verdict or for evidence that fails its integrity check.
  const ep = await latestPackage(ctx.db, ctx.task.id, head);
  if (!ep || ep.status !== "complete")
    return blockEvidence(ctx, `Independent verification is not started: the evidence package of ${head.slice(0, 8)} is ${ep?.status ?? "missing"} (the gate verdict and evidence integrity come first).`, { head, evidence_package: ep?.id ?? null }, { auto: false });
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: head }));
  if (!wt) return;
  if (wt.status === "error") return fail("worktree", wt.error);
  const xf = await ctx.once("xf", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}` }));
  if (!xf) return;
  if (xf.status === "error") return fail("export", xf.error);
  const pv = await ctx.once("pv", "preview", () => ({ candidate: previewKey(ctx.task.id), action: "up", xfer_ctx: `agents-${ctx.task.id}`, tag: head.slice(0, 12) }));
  if (!pv) return;
  if (pv.status === "error" || !pv.result?.build_ok || !pv.result?.health) return fail("preview", pv.error ?? JSON.stringify(pv.result ?? {}).slice(0, 300));
  const c = await currentContract(ctx);
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  const sha = refs.status === "done" ? mainSha(refs, ctx.project.repo) : undefined;
  const ifaces = ctx.project.interfaceTasks.filter((k) => k !== ctx.task.key);
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha: sha ?? head, paths: ifaces.map((k) => `tasks/${k}/contract.json`) }));
  if (!show) return;
  const files: Record<string, string> = { "contract.json": b64(c?.text ?? "{}"), "SCAFFOLD.md": b64(VERIFIER_SCAFFOLD) };
  const names: string[] = [];
  for (const k of ifaces) {
    const body = show.result?.[`tasks/${k}/contract.json`];
    if (typeof body === "string") {
      files[`${k}-contract.json`] = body;
      names.push(`${k}-contract.json`);
    }
  }
  for (const [n, body] of Object.entries(ctx.project.workerDocs)) files[n] = b64(body);
  const job = await ctx.once("verifier", "verifier", () => ({
    work_vol: v.verifier("acc"),
    preview: previewKey(ctx.task.id),
    prompt: acceptancePrompt(ctx.task.key!, names, c ? verificationScope(c.body as unknown as Contract) : undefined),
    files,
  }));
  if (!job) return;
  if (job.status === "error") return fail("verifier", job.error);
  const container = String(job.result?.detached ?? "");
  const runId = await ctx.startRun({ role: "verifier", purpose: "acceptance_check", container, status: "running", ...ledger("acceptance_check", await routeFor(ctx, "acceptance_check")) });
  await ctx.log("verifier", `Independent Verifier started against a local preview of ${head.slice(0, 8)} (blind to code).`, { run: runId });
  await ctx.goto("acceptance_poll", { head, runId, container, started: ctx.now().getTime() });
}

export async function acceptancePoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") {
    if ((ctx.now().getTime() - Number(ctx.data.started)) / 1000 > 45 * 60) {
      await ctx.submit("session", { name: ctx.data.container, kill: true });
      await ctx.log("system", "Independent Verifier exceeded 45 minutes; stopped.", {});
    } else return;
  }
  await ctx.goto("acceptance_collect", { head: ctx.data.head, runId: ctx.data.runId });
}

type Parsed = { raw: string; json: unknown } | null;
const parseFindings = (raw: string | null): Parsed => {
  if (!raw) return null;
  try { return { raw, json: JSON.parse(raw) as unknown }; } catch { return { raw, json: null }; }
};

/**
 * Step: read the Verifier's structured result. Material findings are not acted on yet: when the Verifier supplied a reproduction
 * script that passes static validation, the control plane runs it itself against the same preview first (acceptance_confirm).
 */
export async function acceptanceCollect(ctx: TaskCtx): Promise<void> {
  const head = String(ctx.data.head);
  const v = vols(ctx.task.id);
  const runId = ctx.data.runId as number;
  const dump = await ctx.once("dump", "dump", () => ({ vol: v.verifier("acc"), paths: ["out/findings.json", "out/repro.mjs"] }));
  if (!dump) return;
  const parsed = parseFindings(dump.status === "done" ? unb64(dump.result?.["out/findings.json"]) : null);
  const c = await currentContract(ctx);
  if (!parsed || !c) {
    const down = await ctx.once("down", "preview", () => ({ candidate: previewKey(ctx.task.id), action: "down" }));
    if (!down) return;
    await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
    await ctx.evidence({ subject: "independent-verifier", status: "unknown", oracle: "agent_judgment", persistence: "point_in_time", source: `verifier:${runId}`, commitSha: head, severity: "check", detail: "The Verifier wrote no structured findings file (a failure of the verification, not of the implementation)." });
    if (verificationPlan(ctx.task.tier).unknownBlocks) return blockEvidence(ctx, "Critical tier: the independent Verifier wrote no findings file.", { head, run: runId });
    return ctx.goto("mark_done", { acceptance: "no_output" });
  }
  const first = assessVerifier(c.body as unknown as Contract, ctx.task.key!, parsed.json, null);
  const script = dump.status === "done" ? unb64(dump.result?.["out/repro.mjs"]) : null;
  const want = needsReproduction(first);
  let reproNote = want.length ? "no reproduction script was written" : "no finding needs a reproduction";
  let repro: ReproResult[] | null = null;
  if (want.length && script) {
    const problems = [checkSyntax(script), ...staticOracleProblems(script)].filter((x): x is string => !!x);
    if (problems.length) reproNote = `the reproduction script was not run: ${problems.join("; ").slice(0, 300)}`;
    else {
      // the control plane's own run of the reproduction, against the same preview, before anything is sent back
      const run = await ctx.once("repro", "oracle_run", () => ({ preview: previewKey(ctx.task.id), oracle_js: script }));
      if (!run) return;
      if (run.status === "done") { repro = ((run.result?.results as ReproResult[] | undefined) ?? []).map((r) => ({ criterion: String(r.criterion), result: String(r.result), detail: String(r.detail ?? "").slice(0, 300) })); reproNote = `reproduction run by the control plane: ${repro.map((r) => `${r.criterion}=${r.result === "fail" ? "reproduced" : r.result === "pass" ? "not reproduced" : r.result}`).join(", ") || "no result line"}`; }
      else reproNote = `the reproduction could not be run (${String(run.error ?? "").slice(0, 160)})`;
    }
  }
  const down = await ctx.once("down", "preview", () => ({ candidate: previewKey(ctx.task.id), action: "down" }));
  if (!down) return;
  const a = assessVerifier(c.body as unknown as Contract, ctx.task.key!, parsed.json, repro);
  await recordAssessment(ctx, a, { head, runId, raw: parsed.raw, script, reproNote, contractVersion: c.version });
  if (a.blocking.length > 0) {
    const details = a.blocking.map((b, i) => `${i + 1}. ${b.text}`).join("\n");
    return correction(ctx, "VERIFIER:DEFECT", `The independent Verifier found these defects against a preview of your build:\n${details}`, { verifier_run: runId, head, findings: a.blocking.map((b) => b.finding ?? b.criterion) });
  }
  if (a.verdict === "unverified" && verificationPlan(ctx.task.tier).unknownBlocks) return blockEvidence(ctx, `Critical tier: the independent Verifier could not verify (${a.blocked?.class}: ${a.blocked?.reason ?? ""}).`, { head, run: runId });
  // token policy: the oracle mutation test (an extra AI session and previews) runs for the critical tier only
  await ctx.goto(verificationPlan(ctx.task.tier).mutation ? "mutation_start" : "mark_done", { acceptance: { run: runId, findings: a.findings.length, verdict: a.verdict, coverage: a.coverage.ratio, unconfirmed: a.findings.filter((f) => f.disposition === "unconfirmed").length } });
}

/**
 * Record one assessed Verifier result as evidence: a summary row for the run, one row per requirement the Verifier checked itself,
 * one per judgment, one per finding (with its class and what became of it), and the assessment as the artifact Decision reads.
 * Rows are agent judgment bound to the head; none of them can change a criterion's gate status.
 */
async function recordAssessment(ctx: TaskCtx, a: Assessment, o: { head: string; runId: number; raw: string; script: string | null; reproNote: string; contractVersion: number }) {
  const src = `verifier:${o.runId}`;
  const base = { oracle: "agent_judgment" as const, persistence: "point_in_time" as const, source: src, commitSha: o.head };
  await ctx.updateRun(o.runId, { outcome: "output" });
  const art = await ctx.artifact("verifier-findings", `findings.json (run ${o.runId})`, o.raw);
  if (o.script) await ctx.artifact("verifier-repro", `repro.mjs (run ${o.runId})`, o.script);
  const report = await ctx.artifact("verifier-report", `verifier assessment (run ${o.runId}, ${o.head.slice(0, 8)})`, JSON.stringify({ ...a, head: o.head, run: o.runId, contract_version: o.contractVersion, reproduction: o.reproNote }, null, 1), false);
  for (const id of a.coverage.required) {
    const st = a.coverage.conforms.includes(id) ? "verified" : a.coverage.violated.includes(id) ? "not_verified" : "unknown";
    await ctx.evidence({ ...base, subject: `verification:${id}`, status: st, kind: "verification", criterionTask: ctx.task.key, criterionId: id, artifactId: report, detail: st === "verified" ? "checked independently through the running product: conforms" : st === "not_verified" ? "checked independently: violated (see the finding)" : "not checked by the Verifier" });
  }
  for (const j of a.judgments)
    await ctx.evidence({ ...base, subject: `judgment:${j.id}`, status: j.verdict === "satisfied" ? "verified" : j.verdict === "not_satisfied" ? "not_verified" : "unknown", kind: "judgment", criterionTask: ctx.task.key, criterionId: j.id, artifactId: report, detail: `${j.verdict}${j.reason ? `: ${j.reason}` : ""}\nEvidence: ${j.evidence || "(none)"}`.slice(0, 2000) });
  for (const f of a.findings)
    await ctx.evidence({
      ...base, subject: `finding:${f.criterion ?? (f.security ? "security" : "general")}`, status: "not_verified", artifactId: art,
      // only a finding that stands is blocking evidence; an unconfirmed or non-implementation finding keeps its record but not its weight
      severity: f.disposition === "blocking" ? f.severity : f.disposition === "unconfirmed" ? "unconfirmed" : f.disposition === "not_implementation" ? f.class : f.severity,
      detail: `${f.title}\nExpected: ${f.expected}\nObserved: ${f.observed}\nClass: ${f.class}; reported severity: ${f.severity}; ${f.disposition} (${f.why})`.slice(0, 2000),
    });
  const full = a.coverage.not_checked.length === 0;
  await ctx.evidence({
    ...base, subject: "independent-verifier", artifactId: report,
    status: a.verdict === "no_blocking_defect" ? (full ? "verified" : "partially_verified") : a.verdict === "unverified" ? "unknown" : "not_verified",
    severity: a.blocked ? a.blocked.class : null,
    detail: `${a.verdict.replace(/_/g, " ")}. Coverage ${a.coverage.conforms.length + a.coverage.violated.length} of ${a.coverage.required.length} requirements${a.coverage.not_checked.length ? ` (not checked: ${a.coverage.not_checked.join(", ")})` : ""}; ${a.findings.length} finding(s): ${a.findings.filter((f) => f.disposition === "blocking").length} blocking, ${a.findings.filter((f) => f.disposition === "unconfirmed").length} unconfirmed, ${a.findings.filter((f) => f.disposition === "not_implementation").length} not the implementation's; judgments: ${a.judgments.map((j) => `${j.id}=${j.verdict}`).join(", ") || "none"}; ${o.reproNote}${a.blocked ? `; could not verify (${a.blocked.class}): ${a.blocked.reason}` : ""}${a.problems.length ? `; output problems: ${a.problems.join("; ").slice(0, 300)}` : ""}`.slice(0, 2000),
  });
  await ctx.log("verifier", `Independent Verifier: ${a.verdict.replace(/_/g, " ")}; ${a.coverage.conforms.length + a.coverage.violated.length} of ${a.coverage.required.length} requirements checked; ${a.findings.length} finding(s), ${a.blocking.length} sent back${a.findings.some((f) => f.disposition === "unconfirmed") ? `, ${a.findings.filter((f) => f.disposition === "unconfirmed").length} not reproduced by the control system` : ""}.`, { run: o.runId, artifact: report });
}

/** Calibration figures of the Verifier over every recorded assessment (read-only). */
export async function verifierCalibration(db: TaskCtx["db"]) {
  const { artifacts } = await import("@/db/schema");
  const { calibration } = await import("@/domain/verification");
  const rows = await db.select({ content: artifacts.content }).from(artifacts).where(eq(artifacts.kind, "verifier-report"));
  const as: Assessment[] = [];
  for (const r of rows) { try { as.push(JSON.parse(r.content) as Assessment); } catch { /* not an assessment */ } }
  const legacy = (await db.select({ id: runs.id }).from(runs).where(eq(runs.purpose, "acceptance_check"))).length - as.length;
  return { ...calibration(as), runs_before_structured_findings: Math.max(0, legacy) };
}

export { markDone };
