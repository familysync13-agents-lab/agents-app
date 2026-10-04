import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { artifacts, decisions, evidence, evidencePackages, gateResults, tasks, transitions } from "@/db/schema";
import { Contract } from "@/domain/contract";
import { buildPackage, type EvRow } from "@/domain/evidence";
import { acceptancePrompt } from "@/domain/prompts";
import { assessVerifier, calibration, needsReproduction, verificationScope } from "@/domain/verification";
import { createTask } from "@/server/owner";
import { verifierCalibration } from "@/worker/steps-verify";
import { clock, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario, V3_EXTRA } from "./support/fixture-handlers";

/* Verifier phase acceptance tests (VT1..VT9). */

const C = Contract.parse({ ...CONTRACT("T9"), criteria: [...CONTRACT("T9").criteria, V3_EXTRA.criterion], constraints: V3_EXTRA.constraints });
const F = (o: Record<string, unknown> = {}) => ({ id: "F1", severity: "high", class: "implementation", criterion: "AC1", title: "Sort ignores case", expected: "a before B", observed: "B before a", repro: ["open /lists"], reproduced: 2, ...o });
const OUT = (o: Record<string, unknown> = {}) => ({ schema: 2, coverage: [{ criterion: "AC1", verdict: "conforms", how: "sorted" }, { criterion: "C1", verdict: "conforms" }, { criterion: "C4", verdict: "conforms" }], judgments: [{ id: "C3", verdict: "satisfied", evidence: "Opened /lists three times; values static, nothing animated.", reason: "recorded values only" }], findings: [], ...o });
const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
  const { db, project } = await setup();
  const clk = clock();
  const { state, h } = scenario(opts);
  const ex = new FakeExecutor(db, h);
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, clk, state, ex, id };
};

describe("VT1 what the Verifier is asked: coverage by id and judgment with evidence", () => {
  it("covers observable requirements and judges judgment-class ones; repository facts are the gate's, not the Verifier's", () => {
    const s = verificationScope(C);
    expect(s.observe.map((x) => x.id)).toEqual(["AC1", "C1", "C4"]); // not AC3 (a repository fact), not C2 (static), not C3 (judgment)
    expect(s.judge.map((x) => x.id)).toEqual(["AC2", "C3"]); // the experience criterion and the judgment constraint
    const p = acceptancePrompt("T9", [], s);
    expect(p).toMatch(/- AC1: Given alice with lists B, A, when she clicks Sort A–Z, then A is listed before B/);
    expect(p).toMatch(/- C3: Nothing is estimated or animated\./);
    expect(p).toMatch(/"class": "implementation" \| "check" \| "infrastructure" \| "evidence" \| "control_plane"/);
    expect(p).toMatch(/You have no source code and no repository/);
    expect(p).not.toMatch(/REPORT\.md|Builder/); // blind to the Builder's narrative
  });
});

describe("VT2 coverage is computed by id and never assumed", () => {
  it("counts only requirements the Verifier names; a violated verdict needs a finding", () => {
    expect(assessVerifier(C, "T9", OUT(), null).coverage).toEqual({ required: ["AC1", "C1", "C4"], conforms: ["AC1", "C1", "C4"], violated: [], not_checked: [], ratio: 1 });
    const part = assessVerifier(C, "T9", OUT({ coverage: [{ criterion: "T9:AC1", verdict: "conforms" }, { criterion: "AC9", verdict: "conforms" }, { criterion: "C4", verdict: "maybe" }] }), null);
    expect(part.coverage).toMatchObject({ conforms: ["AC1"], not_checked: ["C1", "C4"] });
    expect(part.coverage.ratio).toBeCloseTo(1 / 3);
    const bare = assessVerifier(C, "T9", OUT({ coverage: [{ criterion: "AC1", verdict: "violated" }] }), null);
    expect(bare.problems).toEqual(["AC1: reported as violated without a finding that says how"]);
    expect(bare.coverage.not_checked).toContain("AC1");
    // a finding against a criterion makes it violated even when the coverage list says it conforms
    expect(assessVerifier(C, "T9", OUT({ findings: [F()] }), null).coverage.violated).toEqual(["AC1"]);
  });
});

describe("VT3 materiality is computed, not taken from the Verifier's wording", () => {
  const d = (f: Record<string, unknown>, repro: { criterion: string; result: string }[] | null = null) => assessVerifier(C, "T9", OUT({ findings: [F(f)] }), repro).findings[0]!;
  it("only an implementation defect, critical or high, against a requirement, a regression or security is material", () => {
    expect(d({})).toMatchObject({ material: true, criterion: "AC1", disposition: "blocking" });
    expect(d({ criterion: "T9:AC1" })).toMatchObject({ material: true, criterion: "AC1", regression: false });
    expect(d({ criterion: "T4:AC3" })).toMatchObject({ material: true, criterion: "T4:AC3", regression: true });
    expect(d({ criterion: "security", severity: "critical" })).toMatchObject({ material: true, security: true, criterion: null });
    expect(d({ criterion: "C4" })).toMatchObject({ material: true, criterion: "C4" }); // a constraint is a requirement
    expect(d({ severity: "medium" })).toMatchObject({ material: false, disposition: "advisory" });
    expect(d({ criterion: "none" })).toMatchObject({ material: false, disposition: "advisory", why: expect.stringMatching(/not tied to a requirement/) });
    expect(d({ criterion: "AC2" })).toMatchObject({ material: false }); // a should-criterion never sends work back
    expect(d({ criterion: "AC77" })).toMatchObject({ material: false, criterion: null }); // an id the contract does not have is not a link
    expect(d({ severity: "catastrophic" })).toMatchObject({ severity: "low", material: false });
  });
  it("separates implementation defects from check, infrastructure, evidence and control-plane failures", () => {
    for (const k of ["check", "infrastructure", "evidence", "control_plane"]) expect(d({ class: k, severity: "critical" })).toMatchObject({ class: k, material: false, disposition: "not_implementation" });
    const a = assessVerifier(C, "T9", OUT({ blocked: { class: "infrastructure", reason: "the preview stopped answering after 4 minutes" } }), null);
    expect(a).toMatchObject({ verdict: "unverified", blocked: { class: "infrastructure" }, blocking: [] });
    expect(assessVerifier(C, "T9", OUT({ blocked: { class: "implementation", reason: "x" } }), null).blocked?.class).toBe("infrastructure"); // "could not verify" is never the implementation
    expect(assessVerifier(C, "T9", "not json", null)).toMatchObject({ valid: false, verdict: "unverified", coverage: { not_checked: ["AC1", "C1", "C4"] } });
  });
});

describe("VT4 false-positive control: the control plane reproduces a finding before the work goes back", () => {
  const a = (repro: { criterion: string; result: string }[] | null) => assessVerifier(C, "T9", OUT({ findings: [F()] }), repro);
  it("reproduced -> blocking; ran and did not reproduce -> unconfirmed; no working reproduction -> treated as reported", () => {
    expect(needsReproduction(a(null))).toEqual(["F1"]);
    expect(a([{ criterion: "F1", result: "fail" }])).toMatchObject({ verdict: "defects_confirmed", findings: [{ reproduction: "reproduced", disposition: "blocking" }] });
    const fp = a([{ criterion: "F1", result: "pass" }]);
    expect(fp).toMatchObject({ verdict: "no_blocking_defect", blocking: [], findings: [{ reproduction: "not_reproduced", disposition: "unconfirmed" }] });
    expect(fp.coverage.violated).toEqual([]); // an unconfirmed finding does not mark the criterion violated
    // a missing or broken script can never hide a real defect: the finding keeps its effect
    expect(a(null)).toMatchObject({ verdict: "defects_confirmed", findings: [{ reproduction: "not_run", disposition: "blocking", why: expect.stringMatching(/treated as reported/) }] });
    expect(a([{ criterion: "F9", result: "pass" }])).toMatchObject({ findings: [{ reproduction: "no_result", disposition: "blocking" }] });
    expect(needsReproduction(assessVerifier(C, "T9", OUT({ findings: [F({ severity: "low" })] }), null))).toEqual([]);
  });
});

describe("VT5 judgment: a verdict with captured evidence per judgment-class requirement", () => {
  it("accepts a judgment only with its evidence; not satisfied goes back to the Builder; cannot judge is never a pass", () => {
    expect(assessVerifier(C, "T9", OUT(), null).judgments).toEqual([{ id: "AC2", verdict: "cannot_judge", evidence: "", reason: "the Verifier gave no judgment" }, { id: "C3", verdict: "satisfied", evidence: "Opened /lists three times; values static, nothing animated.", reason: "recorded values only" }]);
    expect(assessVerifier(C, "T9", OUT({ judgments: [{ id: "C3", verdict: "satisfied", evidence: "ok" }] }), null).judgments[1]).toMatchObject({ verdict: "cannot_judge", reason: "a judgment needs the evidence it rests on" });
    const no = assessVerifier(C, "T9", OUT({ judgments: [{ id: "C3", verdict: "not_satisfied", evidence: "A spinner animates an estimated completion time on /lists.", reason: "an estimate is shown" }] }), null);
    expect(no).toMatchObject({ verdict: "no_blocking_defect", blocking: [] }); // C3 is advisory: reported, never sent back
    const legacy = { ...C, constraints: (C.constraints ?? []).map((x) => (x.id === "C3" ? { ...x, advisory: undefined } : x)) } as typeof C;
    expect(assessVerifier(legacy, "T9", OUT({ judgments: [{ id: "C3", verdict: "not_satisfied", evidence: "A spinner animates an estimated completion time on /lists.", reason: "an estimate is shown" }] }), null)).toMatchObject({ verdict: "defects_confirmed", blocking: [{ finding: null, criterion: "C3", text: expect.stringMatching(/C3 is not satisfied: an estimate is shown/) }] });
  });
});

const row = (o: Partial<EvRow> & { id: number }): EvRow => ({ seq: o.id, subject: "T9:AC1", status: "verified", oracle: "deterministic", persistence: "regression", source: "gate:1", commitSha: "h1", contractSha256: "c1", detail: "", severity: null, artifactId: null, kind: "criterion", criterionTask: "T9", criterionId: "AC1", collector: "gate", runId: null, gateResultId: 1, checkName: "oracle:x", recordSha256: "r", ...o });
const V = (id: number, o: Partial<EvRow>) => row({ id, oracle: "agent_judgment", source: "verifier:7", runId: 7, collector: "verifier", contractSha256: null, gateResultId: null, checkName: null, ...o });
const pkg = (rows: EvRow[], gate: Record<string, unknown> = {}) => buildPackage({ task: { id: 1, key: "T9", title: "Sort lists", tier: "standard" }, scope: "task", planTask: null, inScope: null, head: "h1", stage: "done", contract: { version: 1, sha256: "c1", body: Contract.parse(CONTRACT("T9")) }, plan: null, gate: { id: 1, checkRunId: 5, verdict: "DONE", kind: "pass", headSha: "h1", contractSha256: "c1", evidenceArtifactId: null, ...gate }, rows, artifacts: {}, chain: { ok: true, rows: rows.length, sealed: rows.length, head: "x", problems: [] } });

describe("VT6 the Verifier never overrides the gate or evidence integrity", () => {
  it("an independent 'conforms' does not repair a gate failure, and is shown beside the gate's status", () => {
    const failed = pkg([row({ id: 1, status: "not_verified", detail: "oracle:x · B before A" }), V(2, { kind: "verification", subject: "verification:AC1" }), V(3, { kind: "verifier_run", subject: "independent-verifier", criterionTask: null, criterionId: null })], { verdict: "FAIL:ORACLE", kind: "candidate_failure" });
    expect(failed).toMatchObject({ status: "incomplete", body: { criteria: [{ id: "AC1", status: "not_verified", independent: "conforms" }, { id: "AC2" }] } });
    const ok = pkg([row({ id: 1 }), V(2, { kind: "verification", subject: "verification:AC1" }), V(3, { kind: "verifier_run", subject: "independent-verifier", criterionTask: null, criterionId: null })]);
    expect(ok).toMatchObject({ status: "complete", body: { criteria: [{ id: "AC1", status: "verified", independent: "conforms" }, { id: "AC2", independent: null }], verifier: { status: "no_defect_found", coverage: { checked: 1, required: 1, conforms: 1 }, failure_class: null } } });
  });
  it("a confirmed finding contradicts a verified criterion; an unconfirmed or non-implementation one does not", () => {
    const f = (severity: string) => pkg([row({ id: 1 }), V(2, { kind: "finding", subject: "finding:AC1", status: "not_verified", severity })]).body.criteria[0]!;
    expect(f("high")).toMatchObject({ status: "partially_verified", contradicted_by: [2] });
    for (const s of ["unconfirmed", "infrastructure", "check", "medium"]) expect([s, f(s).status]).toEqual([s, "verified"]);
  });
  it("names the failure class when the Verifier could not verify, and uses the latest run of the head only", () => {
    const p = pkg([row({ id: 1 }), V(2, { kind: "finding", subject: "finding:AC1", status: "not_verified", severity: "high", runId: 6, source: "verifier:6" }), V(3, { kind: "verifier_run", subject: "independent-verifier", status: "unknown", severity: "infrastructure", detail: "unverified. could not verify (infrastructure): preview stopped", criterionTask: null, criterionId: null })]);
    expect(p.body.verifier).toMatchObject({ status: "unknown", failure_class: "infrastructure", run: 7, findings: { blocking: 0 } });
    expect(p.body.handoff.decision.verifier).toMatchObject({ status: "unknown", failure_class: "infrastructure", coverage: "0/0" });
  });
});

describe("VT7 end to end: structured result, reproduction by the control plane, clean handoff to Decision", () => {
  it("a reproduced high finding goes back to the Builder once; the final package carries coverage, judgments and the assessment", async () => {
    const { db, clk, ex, id, state } = await start({ v3: {}, verifierHigh: true });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    expect(state.reproRuns).toBe(1);
    const fix = state.builderPrompts.find((p) => p.includes("VERDICT: VERIFIER:DEFECT"))!;
    expect(fix).toMatch(/\[high\] AC1 - Sort ignores case[\s\S]*\(reproduced by the control system against this build\)/);
    expect((await taskRow(db, id)).corrections).toBe(1);
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id)).orderBy(asc(evidence.seq));
    const h1 = ev.filter((r) => r.commitSha === "h1"), h2 = ev.filter((r) => r.commitSha === "h2");
    expect(h1.filter((r) => r.kind === "finding").map((r) => [r.criterionId, r.severity, r.contractVersion])).toEqual([["AC1", "high", 1]]);
    expect(h1.find((r) => r.kind === "verifier_run")).toMatchObject({ status: "not_verified", detail: expect.stringMatching(/defects confirmed\. Coverage 3 of 3 requirements; 1 finding\(s\): 1 blocking, 0 unconfirmed[\s\S]*F1=reproduced/) });
    expect(h2.filter((r) => r.kind === "verification").map((r) => [r.criterionId, r.status])).toEqual([["AC1", "verified"], ["C1", "verified"], ["C4", "verified"]]);
    expect(h2.filter((r) => r.kind === "judgment").map((r) => [r.criterionId, r.status, r.oracle])).toEqual([["AC2", "unknown", "agent_judgment"], ["C3", "verified", "agent_judgment"]]); // the should-level experience criterion was asked too; no answer = cannot judge
    expect(h2.find((r) => r.kind === "verifier_run")).toMatchObject({ status: "verified", runId: expect.any(Number) });
    const final = (await db.select().from(evidencePackages).where(eq(evidencePackages.taskId, id)).orderBy(asc(evidencePackages.id))).at(-1)!;
    const body = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.id, final.artifactId)))[0]!.content);
    expect(body).toMatchObject({ status: "complete", head: "h2", verifier: { status: "no_defect_found", coverage: { checked: 3, required: 3, conforms: 3, violated: 0 }, findings: { blocking: 0 }, judgments: [{ id: "AC2", verdict: "cannot_judge" }, { id: "C3", verdict: "satisfied" }] } });
    expect(body.criteria.find((k: { id: string }) => k.id === "AC1")).toMatchObject({ status: "verified", independent: "conforms" });
    expect(body.constraints.find((k: { id: string }) => k.id === "C3")).toMatchObject({ counted: false, advisory: true, status: "verified", reason: expect.stringMatching(/independent judgment, verifier:/) });
    expect(body.handoff.decision.verifier).toEqual({ status: "no_defect_found", failure_class: null, coverage: "3/3", findings: { blocking: 0, unconfirmed: 0, not_implementation: 0, advisory: 0 }, judgments: ["AC2=cannot_judge", "C3=satisfied"] });
    // the assessment is stored for Decision, tied to head, run and contract version
    const rep = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.taskId, id))).filter((a) => a.kind === "verifier-report").at(-1)!.content);
    expect(rep).toMatchObject({ schema: "agents-app/verifier-assessment@1", head: "h2", contract_version: 1, verdict: "no_blocking_defect", run: expect.any(Number) });
    expect(await verifierCalibration(db)).toMatchObject({ runs: 2, material: 1, reproduced: 1, not_reproduced: 0, false_positive_rate: 0, coverage: 1 });
    void [tasks, gateResults, decisions];
  });
  it("a high finding the control plane cannot reproduce is recorded as unconfirmed and does NOT send the work back", async () => {
    const { db, clk, ex, id, state } = await start({ verifierHigh: true, repro: "not_reproduced" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    expect([state.reproRuns, (await taskRow(db, id)).corrections]).toEqual([1, 0]);
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id));
    expect(ev.filter((r) => r.kind === "finding").map((r) => [r.severity, /unconfirmed \(the control plane ran the Verifier's reproduction/.test(r.detail ?? "")])).toEqual([["unconfirmed", true]]);
    const final = (await db.select().from(evidencePackages).where(eq(evidencePackages.taskId, id)).orderBy(asc(evidencePackages.id))).at(-1)!;
    expect(final).toMatchObject({ status: "complete", stage: "done" });
    const body = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.id, final.artifactId)))[0]!.content);
    expect(body.verifier.findings).toEqual({ blocking: 0, unconfirmed: 1, not_implementation: 0, advisory: 0 }); // the owner still sees it at acceptance
    expect((await verifierCalibration(db)).false_positive_rate).toBe(1);
  });
  it("a finding without a reproduction script, and a legacy-format result, keep their effect (nothing is weakened)", async () => {
    for (const opts of [{ verifierHigh: true, repro: "none" as const }, { verifierHigh: true, verifierLegacy: true }]) {
      const { db, clk, ex, id, state } = await start(opts);
      await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
      expect([state.reproRuns, (await taskRow(db, id)).corrections]).toEqual([0, 1]);
    }
  });
  it("an advisory constraint judged not satisfied is reported to the owner and never sent back; a check or infrastructure finding never goes back", async () => {
    const a = await start({ v3: {}, judgmentNo: true });
    await runUntil(a.db, a.ex, a.clk, async () => (await taskRow(a.db, a.id)).step === "await_acceptance");
    expect(a.state.builderPrompts.some((p) => p.includes("C3 is not satisfied"))).toBe(false);
    const [acc] = (await openDecisions(a.db, a.id)).filter((d) => d.kind === "acceptance");
    expect(((acc!.context as { decisionRecord: { residual: string[] } }).decisionRecord.residual).join("\n")).toMatch(/C3: advisory \(non-blocking by contract\): judged NOT satisfied/);
    const b = await start({ verifierExtra: [{ id: "F1", severity: "critical", class: "infrastructure", criterion: "AC1", title: "Preview returned 502 twice", expected: "200", observed: "502" }, { id: "F2", severity: "high", class: "check", criterion: "AC1", title: "AC1 does not say which locale sorts", expected: "-", observed: "-" }] });
    await runUntil(b.db, b.ex, b.clk, async () => (await taskRow(b.db, b.id)).step === "await_acceptance");
    expect((await taskRow(b.db, b.id)).corrections).toBe(0);
    expect((await b.db.select().from(evidence).where(eq(evidence.taskId, b.id))).filter((r) => r.kind === "finding").map((r) => r.severity).sort()).toEqual(["check", "infrastructure"]);
  });
  it("incomplete coverage and a Verifier that could not verify are recorded as such, with the class, and reach Decision", async () => {
    const { db, clk, ex, id } = await start({ v3: {}, verifierSkips: ["C4"], verifierBlocked: { class: "evidence", reason: "no way to observe the escaped parameter from outside" } });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const run = (await db.select().from(evidence).where(eq(evidence.taskId, id))).filter((r) => r.kind === "verifier_run").at(-1)!;
    expect(run).toMatchObject({ status: "unknown", severity: "evidence", detail: expect.stringMatching(/unverified\. Coverage 2 of 3 requirements \(not checked: C4\)[\s\S]*could not verify \(evidence\)/) });
    const [acc] = (await openDecisions(db, id)).filter((d) => d.kind === "acceptance");
    expect(acc).toBeTruthy();
    const done = (await db.select().from(transitions).where(eq(transitions.taskId, id))).find((t) => t.toState === "DONE")!;
    expect((done.fact as { acceptance: unknown }).acceptance).toMatchObject({ verdict: "unverified", coverage: expect.closeTo(2 / 3, 5) });
  });
});

describe("VT8 calibration figures", () => {
  it("measures how the Verifier's material findings stood up and how much it covered", () => {
    const as = [assessVerifier(C, "T9", OUT({ findings: [F()] }), [{ criterion: "F1", result: "fail" }]), assessVerifier(C, "T9", OUT({ findings: [F(), F({ id: "F2", class: "check" })] }), [{ criterion: "F1", result: "pass" }]), assessVerifier(C, "T9", OUT({ coverage: [] }), null), assessVerifier(C, "T9", null, null)];
    expect(calibration(as)).toMatchObject({ runs: 4, unusable: 1, findings: 3, material: 2, reproduced: 1, not_reproduced: 1, no_reproduction: 0, false_positive_rate: 0.5, by_class: { implementation: 2, check: 1 } });
    expect(calibration(as).coverage).toBeCloseTo(0.5);
    expect(calibration([])).toMatchObject({ runs: 0, false_positive_rate: null, coverage: null });
  });
});
