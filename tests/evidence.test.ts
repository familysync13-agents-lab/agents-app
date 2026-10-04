import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { artifacts, decisions, evidence, evidencePackages, plans, tasks, transitions } from "@/db/schema";
import { Contract, type Criterion } from "@/domain/contract";
import { buildPackage, criterionState, linkage, recordHash, stable, verifyChain, type ChainRow, type EvRow, type PackageInput } from "@/domain/evidence";
import { associationInput, EVIDENCE_ROLE, EVIDENCE_ROLES, listedCriteria } from "@/domain/evidence-roles";
import { PlanBody } from "@/domain/plan";
import { ALL_TASK_CLASSES, ROUTES } from "@/domain/router";
import { qualificationRecords } from "@/db/schema";
import { collectCandidates, HARNESS_CLASSES, holdoutReference, loadCaseSet, qualifyRun, routeTableAll, type SemanticCase } from "@/worker/qualify";
import { createTask } from "@/server/owner";
import { assemblePackage, auditEvidence, recordEvidence, replayEvidence, sealBacklog } from "@/worker/evidence";
import { clock, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario } from "./support/fixture-handlers";

/* Evidence phase acceptance tests (EV1..EV9): structure and linkage, provenance, integrity, computed status, packages, handoff. */

const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
  const { db, project } = await setup();
  const clk = clock();
  const { state, h } = scenario(opts);
  const ex = new FakeExecutor(db, h);
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, clk, state, ex, id };
};
const A = { id: "T9.a", purpose: "sorting", covers: ["AC1", "AC2"] };
const B = { id: "T9.b", purpose: "filtering", covers: ["AC3"] };

describe("EV1 structure and criterion linkage (by id, never by text)", () => {
  it("derives kind, criterion and provenance from the conventions every writer already follows", () => {
    const l = (subject: string, source: string, detail = "") => linkage({ subject, source, detail, taskKey: "T9" });
    expect(l("T9:AC1", "gate:555", "oracle:oracle/T9/check.mjs · Timeout 15000ms")).toEqual({ kind: "criterion", criterionTask: "T9", criterionId: "AC1", collector: "gate", runId: null, checkRun: 555, checkName: "oracle:oracle/T9/check.mjs" });
    expect(l("T4:AC3", "gate:556", "regression · oracle:oracle/T4/check.mjs · 4 !== 1")).toMatchObject({ kind: "regression", criterionTask: "T4", criterionId: "AC3", checkName: "oracle:oracle/T4/check.mjs" });
    expect(l("T4:AC3", "gate:556", "oracle:oracle/T4/check.mjs")).toMatchObject({ kind: "regression" }); // another task's criterion is a regression even without the marker
    expect(l("T9:C2", "gate:9", "static:x")).toMatchObject({ kind: "criterion", criterionId: "C2" });
    expect(l("finding:AC1", "verifier:77")).toMatchObject({ kind: "finding", criterionTask: "T9", criterionId: "AC1", collector: "verifier", runId: 77 });
    expect(l("finding:t4:ac3", "verifier:77")).toMatchObject({ kind: "finding", criterionTask: "T4", criterionId: "AC3" });
    expect(l("finding:general", "verifier:77")).toMatchObject({ kind: "finding", criterionTask: null, criterionId: null }); // not guessed
    expect(l("finding:the sort button", "verifier:77")).toMatchObject({ kind: "finding", criterionId: null });
    expect(l("independent-verifier", "verifier:unavailable")).toMatchObject({ kind: "verifier_run", collector: "verifier", runId: null });
    expect(l("attribution:T10:AC1", "verifier:80")).toMatchObject({ kind: "attribution", criterionTask: "T10", criterionId: "AC1" });
    expect(l("oracle-mutation:T9:AC4", "mutation:81")).toMatchObject({ kind: "oracle_mutation", criterionId: "AC4", collector: "builder", runId: 81 });
    expect(l("oracle-calibration:T9", "oracle-calibration")).toMatchObject({ kind: "oracle_calibration", criterionTask: "T9", collector: "control-plane" });
    expect(l("regression-oracle:T4", "regression-repair")).toMatchObject({ kind: "regression_oracle", criterionTask: "T4" });
    expect(l("something else", "x")).toMatchObject({ kind: "other", criterionId: null });
  });
});

const row = (o: Partial<EvRow> & { id: number }): EvRow => ({ seq: o.id, subject: "T9:AC1", status: "verified", oracle: "deterministic", persistence: "regression", source: "gate:1", commitSha: "h1", contractSha256: "c1", detail: "oracle:x", severity: null, artifactId: null, kind: "criterion", criterionTask: "T9", criterionId: "AC1", collector: "gate", runId: null, gateResultId: 1, checkName: "oracle:x", recordSha256: "r", ...o });
const crit = (o: Partial<Criterion> = {}): Criterion => ({ id: "AC1", type: "behavior", priority: "must", tags: [], verify: "blackbox", ...o }) as Criterion;
const bind = { head: "h1", contractSha256: "c1" };

describe("EV2 criterion status is computed from evidence bound to the head and the contract version", () => {
  it("counts only the judged head and the approved contract version; the latest observation decides", () => {
    expect(criterionState(crit(), "T9", [], bind, true)).toMatchObject({ status: "not_verified", reason: "no evidence bound to h1" });
    expect(criterionState(crit(), "T9", [row({ id: 1, commitSha: "h0" })], bind, true)).toMatchObject({ status: "not_verified", not_counted: 1, reason: expect.stringMatching(/another head or version do not count/) });
    expect(criterionState(crit(), "T9", [row({ id: 1, contractSha256: "other" })], bind, true)).toMatchObject({ status: "not_verified", not_counted: 1 });
    expect(criterionState(crit(), "T9", [row({ id: 1 })], bind, true)).toMatchObject({ status: "verified", evidence: [1] });
    expect(criterionState(crit(), "T9", [row({ id: 1, status: "not_verified", detail: "oracle:x · B before A" }), row({ id: 2 })], bind, true).status).toBe("verified"); // a later gate run replaces the earlier one
    expect(criterionState(crit(), "T9", [row({ id: 1 }), row({ id: 2, status: "not_verified", detail: "B before A" })], bind, true)).toMatchObject({ status: "not_verified", reason: "B before A" });
    expect(criterionState(crit(), "T9", [row({ id: 1, status: "unknown", detail: "HARNESS: preview unreachable" })], bind, true)).toMatchObject({ status: "unknown" });
    expect(criterionState(crit(), "T9", [row({ id: 1, criterionId: "AC2" })], bind, true).status).toBe("not_verified"); // another criterion's evidence never counts
  });
  it("agent judgment alone never satisfies a must; a judgment criterion needs human judgment or a waiver; a blocking finding contradicts", () => {
    expect(criterionState(crit(), "T9", [row({ id: 1, oracle: "agent_judgment" })], bind, true)).toMatchObject({ status: "partially_verified", reason: expect.stringMatching(/agent judgment alone/) });
    expect(criterionState(crit({ priority: "should" }), "T9", [row({ id: 1, oracle: "agent_judgment" })], bind, true).status).toBe("verified");
    const exp = crit({ type: "experience", verify: "judgment", evidence: "screenshots at 375px" });
    expect(criterionState(exp, "T9", [row({ id: 1 })], bind, true)).toMatchObject({ status: "partially_verified", required_proof: "judgment" });
    expect(criterionState(exp, "T9", [row({ id: 1 }), row({ id: 2, oracle: "human_judgment", source: "owner" })], bind, true).status).toBe("verified");
    expect(criterionState(exp, "T9", [row({ id: 1, status: "waived", source: "owner", detail: "accepted without the screenshot" })], bind, true)).toMatchObject({ status: "waived" });
    const finding = row({ id: 5, kind: "finding", subject: "finding:AC1", status: "not_verified", oracle: "agent_judgment", severity: "high", source: "verifier:9", contractSha256: null });
    expect(criterionState(crit(), "T9", [row({ id: 1 }), finding], bind, true)).toMatchObject({ status: "partially_verified", contradicted_by: [5], findings: [5] });
    expect(criterionState(crit(), "T9", [row({ id: 1 }), { ...finding, severity: "low" }], bind, true)).toMatchObject({ status: "verified", findings: [5], contradicted_by: [] });
    expect(criterionState(crit(), "T9", [row({ id: 1 }), { ...finding, commitSha: "h0" }], bind, true)).toMatchObject({ status: "verified", findings: [] }); // a finding against an earlier head is not about this one
  });
});

const sealed = (n: number, o: Partial<ChainRow> = {}): ChainRow[] => {
  const out: ChainRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const r = { id: i, taskId: 1, seq: i, subject: `T9:AC${i}`, status: "verified", oracle: "deterministic", persistence: "regression", source: "gate:1", commitSha: "h1", contractSha256: "c1", detail: `d${i}`, severity: null, kind: "criterion", criterionTask: "T9", criterionId: `AC${i}`, contractVersion: 1, planTask: null, scope: "task", collector: "gate", runId: null, gateResultId: 1, checkName: "x", artifactSha256: i === 2 ? "a".repeat(64) : null, ...o };
    const h: string = recordHash(prev, r);
    out.push({ ...r, prevSha256: prev, recordSha256: h });
    prev = h;
  }
  return out;
};

describe("EV3 integrity: a hash chain per task over the canonical row and its artifact hash", () => {
  it("verifies an untouched chain and reports any edit, removal, reordering or changed artifact", () => {
    const rows = sealed(4);
    expect(verifyChain(rows)).toMatchObject({ ok: true, rows: 4, sealed: 4, head: rows[3]!.recordSha256, problems: [] });
    expect(verifyChain(rows.map((r) => (r.id === 2 ? { ...r, status: "not_verified" } : r)))).toMatchObject({ ok: false, problems: [expect.stringMatching(/evidence 2: content does not match its seal/)] });
    expect(verifyChain(rows.map((r) => (r.id === 3 ? { ...r, detail: "edited" } : r))).ok).toBe(false);
    expect(verifyChain(rows.map((r) => (r.id === 2 ? { ...r, artifactSha256: "b".repeat(64) } : r))).ok).toBe(false); // the artifact body is part of the seal
    expect(verifyChain(rows.filter((r) => r.id !== 2))).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringMatching(/a row is missing or was inserted/)]) });
    expect(verifyChain(rows.slice(0, 3)).head).toBe(rows[2]!.recordSha256); // removing the newest row changes the chain head (the head is recorded in every package)
    expect(verifyChain([...rows, { ...rows[3]!, id: 9, seq: 5, recordSha256: null }])).toMatchObject({ ok: false, problems: [expect.stringMatching(/evidence 9: not sealed/)] });
  });
});

const pkgInput = (o: Partial<PackageInput> = {}): PackageInput => ({
  task: { id: 1, key: "T9", title: "Sort lists", tier: "standard" }, scope: "task", planTask: null, inScope: null, head: "h1", stage: "gate",
  contract: { version: 1, sha256: "c1", body: Contract.parse(CONTRACT("T9")) }, plan: null,
  gate: { id: 1, checkRunId: 500, verdict: "DONE", kind: "pass", headSha: "h1", contractSha256: "c1", evidenceArtifactId: 7 },
  rows: [row({ id: 1, artifactId: 7 })], artifacts: { 7: { sha256: "s7", intact: true, kind: "gate-evidence", name: "g" } }, chain: { ok: true, rows: 1, sealed: 1, head: "hh", problems: [] }, ...o,
});

describe("EV4 the evidence package: deterministic, criterion-linked, with gaps and inconsistencies named", () => {
  it("is complete when every in-scope must is verified; should-criteria are reported, never required", () => {
    const p = buildPackage(pkgInput());
    expect(p.status).toBe("complete");
    expect(p.body.criteria.map((c) => [c.id, c.priority, c.status, c.in_scope])).toEqual([["AC1", "must", "verified", true], ["AC2", "should", "not_verified", true]]);
    expect(p.body.gaps).toEqual([]);
    expect(p.body.handoff.decision).toMatchObject({ status: "complete", must_total: 1, must: { verified: 1 }, should: { not_verified: 1 }, blocking: [] });
    expect(p.body.evidence[0]).toMatchObject({ id: 1, kind: "criterion", collector: "gate", gate_result: 1, check: "oracle:x", record_sha256: "r", artifact: { id: 7, sha256: "s7" } });
    expect(p.body.integrity).toMatchObject({ chain_ok: true, chain_head: "hh", artifacts_checked: 1, artifacts_bad: [] });
    // deterministic: the same evidence gives the same bytes and hash, whatever the order rows arrive in
    const again = buildPackage(pkgInput({ rows: [row({ id: 1, artifactId: 7 })] }));
    expect([again.sha256, again.text]).toEqual([p.sha256, p.text]);
    expect(stable({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it("never lets a passing verdict stand without criterion evidence, a wrong binding or a broken seal", () => {
    expect(buildPackage(pkgInput({ rows: [] }))).toMatchObject({ status: "inconsistent", body: { gaps: ["T9:AC1 is not verified: no evidence bound to h1"], inconsistencies: [expect.stringMatching(/verdict is DONE, but the evidence bound to this head does not verify every required criterion/)] } });
    expect(buildPackage(pkgInput({ rows: [row({ id: 1, commitSha: "h0" })] })).status).toBe("inconsistent"); // evidence for another head does not count
    expect(buildPackage(pkgInput({ gate: { ...pkgInput().gate!, contractSha256: "old" } })).body.inconsistencies).toEqual([expect.stringMatching(/different contract version/)]);
    expect(buildPackage(pkgInput({ chain: { ok: false, rows: 1, sealed: 1, head: "x", problems: ["evidence 1: content does not match its seal"] } }))).toMatchObject({ status: "inconsistent", body: { inconsistencies: [expect.stringMatching(/evidence integrity: evidence 1/)] } });
    expect(buildPackage(pkgInput({ artifacts: { 7: { sha256: "s7", intact: false, kind: "gate-evidence", name: "g" } } })).body.inconsistencies).toEqual([expect.stringMatching(/artifact\(s\) 7 no longer match/)]);
    expect(buildPackage(pkgInput({ artifacts: {} })).body.integrity.artifacts_missing).toEqual([7]);
    expect(buildPackage(pkgInput({ contract: null })).status).toBe("inconsistent");
  });
  it("distinguishes incomplete, blocked (Unknown on a must) and failing regressions; hands each stage only what it needs", () => {
    const fail = { ...pkgInput().gate!, verdict: "FAIL:ORACLE", kind: "candidate_failure" };
    const p = buildPackage(pkgInput({ gate: fail, rows: [row({ id: 1, status: "not_verified", detail: "oracle:x · B before A" })] }));
    expect(p).toMatchObject({ status: "incomplete", body: { handoff: { gate: { failing: ["AC1"], unknown: [], missing: [] } } } });
    const u = buildPackage(pkgInput({ gate: { ...fail, verdict: "BLOCKED:EVIDENCE", kind: "blocked" }, rows: [row({ id: 1, status: "unknown", detail: "HARNESS: preview is unreachable" })] }));
    expect(u).toMatchObject({ status: "blocked", body: { handoff: { gate: { unknown: ["AC1"] } } } });
    const reg = row({ id: 2, subject: "T4:AC3", kind: "regression", criterionTask: "T4", criterionId: "AC3", status: "not_verified", detail: "regression · oracle:y · 4 !== 1" });
    const r = buildPackage(pkgInput({ gate: { ...fail, verdict: "FAIL:REGRESSION" }, rows: [row({ id: 1 }), reg] }));
    expect(r).toMatchObject({ status: "incomplete", body: { regressions: [{ subject: "T4:AC3", status: "not_verified", evidence: 2 }], handoff: { gate: { regressions_failing: ["T4:AC3"] } } } });
    // the Verifier handoff holds ids and evidence requirements only: no Builder narrative, no code, no gate detail
    const c2 = Contract.parse({ ...CONTRACT("T9"), criteria: [CONTRACT("T9").criteria[0], { ...CONTRACT("T9").criteria[1], evidence: "a screen recording of sorting 200 lists" }] });
    const v = buildPackage(pkgInput({ contract: { version: 1, sha256: "c1", body: c2 }, rows: [row({ id: 1 }), row({ id: 3, kind: "finding", subject: "finding:general", criterionTask: null, criterionId: null, status: "not_verified", oracle: "agent_judgment", severity: "low", source: "verifier:9", contractSha256: null, detail: "Sort button has no focus ring" })] }));
    expect(v.body.handoff.verifier).toEqual({ head: "h1", contract_sha256: "c1", judgment_required: [{ id: "AC2", priority: "should", requirement: "a screen recording of sorting 200 lists" }], unlinked_findings: [3] });
    expect(JSON.stringify(v.body.handoff.verifier)).not.toMatch(/oracle|Builder|B before A/);
    expect(v.body.findings).toEqual([{ evidence: 3, criterion: null, severity: "low", title: "Sort button has no focus ring", linked: false }]);
  });
  it("judges a plan task on the criteria in its scope only", () => {
    const three = Contract.parse({ ...CONTRACT("T9"), criteria: [CONTRACT("T9").criteria[0], { ...CONTRACT("T9").criteria[0], id: "AC2" }, { ...CONTRACT("T9").criteria[0], id: "AC3" }] });
    const rows = [row({ id: 1 }), row({ id: 2, subject: "T9:AC2", criterionId: "AC2" }), row({ id: 3, subject: "T9:AC3", criterionId: "AC3", status: "unknown", detail: "not yet required at this plan task" })];
    const task = buildPackage(pkgInput({ contract: { version: 1, sha256: "c1", body: three }, scope: "plan_task", planTask: "T9.a", inScope: ["AC1", "AC2"], rows }));
    expect(task).toMatchObject({ status: "complete", body: { plan_task: "T9.a", criteria: [{ id: "AC1", in_scope: true }, { id: "AC2", in_scope: true }, { id: "AC3", in_scope: false, status: "unknown" }] } });
    // the same evidence does NOT satisfy the integrated result: there every criterion is in scope
    expect(buildPackage(pkgInput({ contract: { version: 1, sha256: "c1", body: three }, scope: "integrated", rows })).status).toBe("inconsistent");
  });
});

describe("EV5 every write is structured, linked and sealed; legacy rows are backfilled", () => {
  it("seals new rows into the task's chain and backfills rows written before the Evidence phase", async () => {
    const { db, id } = await start();
    await db.update(tasks).set({ key: "T9" }).where(eq(tasks.id, id));
    // a legacy row: written directly, as before the Evidence phase
    const [art] = await db.insert(artifacts).values({ taskId: id, kind: "gate-evidence", name: "g", content: "{}", sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", workerAuthored: false }).returning({ id: artifacts.id });
    await db.insert(evidence).values({ taskId: id, subject: "T9:AC1", status: "not_verified", oracle: "deterministic", persistence: "regression", source: "gate:41", commitSha: "h0", detail: "oracle:oracle/T9/check.mjs · B before A", artifactId: art!.id });
    await db.insert(evidence).values({ taskId: id, subject: "attribution:T9:AC1", status: "not_verified", oracle: "agent_judgment", persistence: "point_in_time", source: "verifier:3", commitSha: "h0", detail: "IMPLEMENTATION: not sorted" });
    expect(await sealBacklog(db)).toBe(2);
    expect(await sealBacklog(db)).toBe(0); // idempotent
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
    const newId = await recordEvidence(db, t!, { subject: "finding:AC1", status: "not_verified", oracle: "agent_judgment", persistence: "point_in_time", source: "verifier:5", commitSha: "h1", severity: "high", detail: "Not sorted\nExpected: A, B\nObserved: B, A" });
    const rows = await db.select().from(evidence).where(eq(evidence.taskId, id)).orderBy(asc(evidence.seq));
    expect(rows.map((r) => [r.seq, r.kind, r.criterionTask, r.criterionId, r.collector, r.sealed, r.checkName, r.runId])).toEqual([
      [1, "criterion", "T9", "AC1", "gate", "backfilled", "oracle:oracle/T9/check.mjs", null],
      [2, "attribution", "T9", "AC1", "verifier", "backfilled", null, 3],
      [3, "finding", "T9", "AC1", "verifier", "recorded", null, 5],
    ]);
    expect(rows[2]!.id).toBe(newId);
    expect(rows[1]!.prevSha256).toBe(rows[0]!.recordSha256);
    expect(rows[2]!.prevSha256).toBe(rows[1]!.recordSha256);
    expect(await auditEvidence(db, id)).toMatchObject({ ok: true, backfilled: 2, chain: { rows: 3, sealed: 3, head: rows[2]!.recordSha256 }, artifacts: { checked: 1, bad: [], missing: [] } });
    // tampering with a row, or with a stored artifact body, is detected
    await db.update(evidence).set({ status: "verified" }).where(eq(evidence.id, rows[0]!.id));
    expect(await auditEvidence(db, id)).toMatchObject({ ok: false, chain: { problems: [expect.stringMatching(/content does not match its seal/)] } });
    await db.update(evidence).set({ status: "not_verified" }).where(eq(evidence.id, rows[0]!.id));
    expect((await auditEvidence(db, id)).ok).toBe(true);
    await db.update(artifacts).set({ content: '{"verdict":"DONE"}' }).where(eq(artifacts.id, art!.id));
    expect(await auditEvidence(db, id)).toMatchObject({ ok: false, artifacts: { bad: [art!.id] } });
  });
});

describe("EV6 atomic task end to end: packages at the gate and before acceptance; downstream reads the package", () => {
  it("stores one package per judged head and stage, binds DONE and the acceptance decision to the final package", async () => {
    const { db, clk, ex, id } = await start({ failFirstGate: true });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const ps = await db.select().from(evidencePackages).where(eq(evidencePackages.taskId, id)).orderBy(asc(evidencePackages.id));
    expect(ps.map((p) => [p.headSha, p.stage, p.scope, p.status])).toEqual([["h1", "gate", "task", "incomplete"], ["h2", "gate", "task", "complete"], ["h2", "done", "task", "complete"]]);
    const final = ps.at(-1)!;
    const [body] = await db.select().from(artifacts).where(eq(artifacts.id, final.artifactId));
    expect(body).toMatchObject({ kind: "evidence-package", sha256: final.sha256, workerAuthored: false });
    const pkg = JSON.parse(body!.content);
    expect(pkg).toMatchObject({ schema: "agents-app/evidence-package@1", head: "h2", status: "complete", scope: "task", contract: { version: 1 }, gate: { verdict: "DONE", kind: "pass" }, verifier: { status: "no_defect_found" }, integrity: { chain_ok: true, artifacts_bad: [] } });
    expect(pkg.criteria.find((c: { id: string }) => c.id === "AC1")).toMatchObject({ status: "verified", priority: "must" });
    // the final package includes the independent Verifier's evidence; the gate-stage package of the same head did not
    expect(ps[1]!.summary).toMatchObject({ verifier: "not_run" });
    expect(final.summary).toMatchObject({ verifier: "no_defect_found", must_total: 1, must: { verified: 1 } });
    // every row is structured and sealed, and bound to the contract version
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id)).orderBy(asc(evidence.seq));
    expect(ev.every((r) => r.kind !== null && r.recordSha256 !== null && r.sealed === "recorded" && r.collector !== null)).toBe(true);
    expect(ev.filter((r) => r.kind === "criterion").every((r) => r.criterionTask === "T9" && r.criterionId === "AC1" && r.contractVersion === 1 && r.gateResultId !== null && r.scope === "task")).toBe(true);
    expect((await auditEvidence(db, id)).ok).toBe(true);
    // DONE and the acceptance decision cite the package
    const done = (await db.select().from(transitions).where(eq(transitions.taskId, id))).find((t) => t.toState === "DONE")!;
    expect(done.fact).toMatchObject({ evidence_package: final.id, evidence_package_sha256: final.sha256 });
    const [acc] = (await db.select().from(decisions).where(eq(decisions.taskId, id))).filter((d) => d.kind === "acceptance");
    expect((acc!.context as { evidencePackage: unknown }).evidencePackage).toEqual({ id: final.id, sha256: final.sha256, artifactId: final.artifactId, status: "complete" });
    // assembling again changes nothing: same evidence, same package
    const t = await taskRow(db, id);
    expect((await assemblePackage(db, t, { head: "h2", stage: "done" })).id).toBe(final.id);
    // replay over history: every recorded verdict is carried (or not) by the package of its head
    expect(await replayEvidence(db)).toMatchObject({ heads: 2, agree: 2, disagreements: [], results: ["T9 h1 FAIL:ORACLE -> incomplete", "T9 h2 DONE -> complete"] });
    // evidence tampered with after the fact makes the package of that head inconsistent
    await db.update(evidence).set({ detail: "edited" }).where(eq(evidence.id, ev.find((r) => r.kind === "criterion" && r.commitSha === "h2")!.id));
    expect((await assemblePackage(db, t, { head: "h2", stage: "audit" })).pkg).toMatchObject({ status: "inconsistent", body: { integrity: { chain_ok: false } } });
  });
  it("blocks instead of passing when the gate reports DONE without criterion evidence for the head", async () => {
    const { db, clk, ex, id } = await start();
    const real = ex.handlers.gate_evidence!;
    ex.handlers.gate_evidence = (p, j) => { const r = real(p, j) as { evidence: { criteria: unknown } }; r.evidence.criteria = {}; return r as unknown as Record<string, unknown>; };
    await runUntil(db, ex, clk, async () => (await openDecisions(db, id)).some((d) => d.kind === "block"));
    const t = await taskRow(db, id);
    expect(t.state).toBe("BLOCKED_EVIDENCE");
    expect(t.stateReason).toMatch(/gate reported DONE, but the evidence bound to h1 is inconsistent/);
    expect((await db.select().from(transitions).where(eq(transitions.taskId, id))).some((x) => x.toState === "DONE")).toBe(false);
  });
});

describe("EV7 decomposed contract: a package per plan task on its own criteria, and the integrated package against the whole contract", () => {
  it("packages each plan task and the integrated result separately; the plan records them", async () => {
    const { db, clk, ex, id } = await start({ complex: { plans: [{ tasks: [A, B] }] } });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance", 900);
    const ps = await db.select().from(evidencePackages).where(eq(evidencePackages.taskId, id)).orderBy(asc(evidencePackages.id));
    const shape = ps.map((p) => [p.scope, p.planTask, p.stage, p.status]);
    expect(shape[0]).toEqual(["plan_task", "T9.a", "gate", "complete"]);
    expect(shape.at(-1)).toEqual(["integrated", null, "done", "complete"]);
    expect(shape.some((s) => s[0] === "integrated" && s[2] === "gate" && s[3] === "complete")).toBe(true);
    const first = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.id, ps[0]!.artifactId)))[0]!.content);
    expect(first.criteria.map((c: { id: string; in_scope: boolean }) => [c.id, c.in_scope])).toEqual([["AC1", true], ["AC2", true], ["AC3", false], ["AC4", false]]);
    const last = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.id, ps.at(-1)!.artifactId)))[0]!.content);
    expect(last.criteria.filter((c: { priority: string }) => c.priority === "must").map((c: { id: string; in_scope: boolean; status: string }) => [c.id, c.in_scope, c.status])).toEqual([["AC1", true, "verified"], ["AC2", true, "verified"], ["AC3", true, "verified"]]);
    expect(last.plan.tasks.map((t: { id: string }) => t.id)).toEqual(["T9.a", "T9.b"]);
    // rows are tagged with the plan task (or integrated result) their head belongs to
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id));
    expect([...new Set(ev.filter((r) => r.kind === "criterion").map((r) => `${r.scope}:${r.planTask ?? ""}`))].sort()).toEqual(["integrated:", "plan_task:T9.a"]);
    const plan = PlanBody.parse((await db.select().from(plans).where(eq(plans.taskId, id)).orderBy(plans.planVersion)).at(-1)!.body);
    expect(plan.tasks[0]!.evidence).toEqual(expect.arrayContaining([`evidence_package:${ps[0]!.id}`, `evidence_package_sha256:${ps[0]!.sha256}`]));
    expect((await auditEvidence(db, id)).ok).toBe(true);
    // replay uses the scope the gate recorded for each head: plan-task heads on their criteria, the integrated head on all
    const rp = await replayEvidence(db);
    expect(rp.disagreements).toEqual([]);
    expect(rp.heads).toBeGreaterThanOrEqual(2);
  });
});

describe("EV8 Evidence roles for a local model: separate qualification, evaluation only, the deterministic result stands", () => {
  const role = EVIDENCE_ROLE.finding_association;
  it("the role is in no route and has its own pinned, calibrated case set; every reference passes the role's gate", () => {
    expect(EVIDENCE_ROLES).toEqual(["finding_association"]);
    expect((ALL_TASK_CLASSES as readonly string[]).includes("finding_association")).toBe(false);
    expect(Object.keys(ROUTES).includes("finding_association")).toBe(false);
    expect(HARNESS_CLASSES).toContain("finding_association");
    const set = loadCaseSet<SemanticCase>("finding_association");
    expect(set.calibrated).toBe(50);
    expect(set.cases.length).toBeGreaterThanOrEqual(56);
    expect(set.cases.filter((c) => c.expect.criterion === "none").length).toBeGreaterThanOrEqual(10);
    for (const c of set.cases) expect([c.id, role.structural(c.input, c.expect), role.agree(c.expect, c.expect)]).toEqual([c.id, [], []]);
  });
  it("gate: only a listed criterion or none, with a verbatim phrase of the finding; the reference decides agreement", () => {
    const input = associationInput([{ id: "AC1", text: "Given lists B and A, when the owner clicks Sort, then A is before B." }, { id: "AC2", text: "The order survives a reload." }], { title: "Order lost after reload", expected: "sorted order", observed: "creation order after reloading" });
    expect(listedCriteria(input)).toEqual(["AC1", "AC2"]);
    expect(role.structural(input, { criterion: "AC2", evidence: "creation order after reloading" })).toEqual([]);
    expect(role.structural(input, { criterion: "none", evidence: "Order lost after reload" })).toEqual([]);
    expect(role.structural(input, { criterion: "AC7", evidence: "creation order after reloading" })).toEqual(["[schema] criterion is neither a listed criterion id nor none"]);
    expect(role.structural(input, { criterion: "AC2", evidence: "the order survives a reload" })).toEqual(["[hallucination] evidence is not a verbatim phrase of the finding"]); // a phrase of the criterion is not evidence
    expect(role.agree({ criterion: "AC1" }, { criterion: "AC2" })).toEqual(["[reference] criterion AC1 differs from the reference AC2"]);
  });
  it("runs only after the references were calibrated by the Verifier, as an evaluation candidate, and changes no route", async () => {
    const set = loadCaseSet<SemanticCase>("finding_association");
    const { db, clk, ex, state } = await start({ localLlm: (p) => ({ ok: true, available: true, model: String(p.model), ms: 900, output: set.cases.find((k) => p.prompt === k.input)!.expect }) });
    const settle = async (n: number) => { for (let i = 0; i < n; i++) { await ex.drain(); await collectCandidates(db, clk.now); clk.advance(25); } };
    await expect(qualifyRun(db, "finding_association", { worker: "cand-qwen38" })).rejects.toThrow(/not calibrated/);
    expect(await holdoutReference(db, "finding_association")).toMatchObject({ inserted: set.cases.length });
    await settle(30);
    expect(state.verifierPrompts.at(-1)).toMatch(/satisfies its rubric/);
    expect(await qualifyRun(db, "finding_association", { worker: "cand-qwen38" })).toMatchObject({ submitted: 50, worker: "cand-qwen38", model: "qwen3.8:27b" });
    await settle(40);
    const rs = (await db.select().from(qualificationRecords)).filter((r) => r.worker === "cand-qwen38");
    expect([rs.length, rs.filter((r) => r.agree === true).length, rs.every((r) => r.verifier === "pass" && r.taskClass === "finding_association")]).toEqual([50, 50, true]);
    expect((await routeTableAll(db)).every((r) => r.worker !== "cand-qwen38" && r.taskClass !== ("finding_association" as string))).toBe(true);
  });
});
