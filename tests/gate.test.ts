import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { artifacts, evidence, evidencePackages, gateResults, tasks } from "@/db/schema";
import { Contract, Fact, GATE_VERSION, gateBindings, intentHash, lintContract, oracleCriteria } from "@/domain/contract";
import { buildPackage, type EvRow, type PackageInput } from "@/domain/evidence";
import { correctionDetails, criteriaFromGate, oracleDefects, scansFromGate, type GateEvidence } from "@/domain/gate";
import { classifyVerdict } from "@/domain/lifecycle";
import { validatePlan } from "@/domain/plan";
import { createTask } from "@/server/owner";
import { clock, contractRows, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario, V3_EXTRA } from "./support/fixture-handlers";

/* Gate phase acceptance tests (GT1..GT8). The gate's own rules (facts, verdict, plan scope) are tested in gate/tests/test_gate.py. */

const INTENT = "Sort lists\nLet owners sort their lists alphabetically on the list index.";
const v3 = (o: Record<string, unknown> = {}) => ({ ...CONTRACT("T9"), intent_sha256: intentHash(INTENT), policies: ["policy.json"], criteria: [...CONTRACT("T9").criteria, V3_EXTRA.criterion], constraints: V3_EXTRA.constraints, ...o });
const lint = (c: unknown) => lintContract(c, { id: "T9", tier: "standard" }, { intent: INTENT });
const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
  const { db, project } = await setup();
  const clk = clock();
  const { state, h } = scenario(opts);
  const ex = new FakeExecutor(db, h);
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, clk, state, ex, id };
};

describe("GT1 repository facts: the declarative proof of a static requirement", () => {
  it("accepts exactly the eight kinds, repository-relative paths and one needle; nothing executable", () => {
    for (const f of [{ kind: "path_exists", path: "src/domain/sort.ts" }, { kind: "path_absent", path: "drizzle/0007_*.sql" }, { kind: "file_contains", path: "src/**/*.ts", text: "APP_ENV" }, { kind: "file_lacks", path: "src/**", pattern: "eval\\(" }, { kind: "dependency_present", name: "zod" }, { kind: "dependency_absent", name: "left-pad", section: "any" }, { kind: "unchanged", paths: ["drizzle/**"] }, { kind: "changed_only", paths: ["src/app/**", "tests/**"] }])
      expect([f.kind, Fact.safeParse(f).success]).toEqual([f.kind, true]);
    for (const f of [{ kind: "shell", cmd: "true" }, { kind: "path_exists" }, { kind: "path_exists", path: "/etc/passwd" }, { kind: "path_exists", path: "../x" }, { kind: "path_exists", path: "a", run: "x" }, { kind: "file_contains", path: "a" }, { kind: "file_contains", path: "a", text: "x", pattern: "y" }, { kind: "file_contains", path: "a", pattern: "(" }, { kind: "unchanged", paths: [] }, { kind: "dependency_absent", name: "x", section: "peer" }, null, "path_exists"])
      expect([JSON.stringify(f), Fact.safeParse(f).success]).toEqual([JSON.stringify(f), false]);
  });
});

describe("GT2 lint: structural musts and static constraints need a fact; experience musts stay disabled", () => {
  it("accepts the Gate-phase contract and refuses each missing or misplaced fact", () => {
    expect(lint(v3())).toEqual({ ok: true, problems: [] });
    const noFact = { ...V3_EXTRA.criterion, fact: undefined };
    expect(lint(v3({ criteria: [...CONTRACT("T9").criteria, noFact] })).problems.join()).toMatch(/AC3: a structural must-criterion needs a valid "fact"/);
    expect(lint(v3({ criteria: [...CONTRACT("T9").criteria, { ...V3_EXTRA.criterion, fact: { kind: "unchanged", paths: ["x/**"] } }] })).problems.join()).toMatch(/AC3: "unchanged" describes this change, not the product; state it as a constraint/);
    expect(lint(v3({ criteria: [...CONTRACT("T9").criteria, { ...noFact, priority: "should" }] })).ok).toBe(true); // a structural should needs none
    expect(lint(v3({ constraints: [{ ...V3_EXTRA.constraints[1], fact: undefined }] })).problems.join()).toMatch(/C2: a static constraint needs a valid "fact".*its class is judgment or blackbox/);
    expect(lint(v3({ constraints: [{ ...V3_EXTRA.constraints[1], fact: { kind: "shell" } }] })).ok).toBe(false);
    expect(lint(v3({ constraints: [{ ...V3_EXTRA.constraints[0], fact: { kind: "path_exists", path: "a" } }] })).problems.join()).toMatch(/C1: "fact" belongs to static constraints only/);
    const exp = { id: "AC4", type: "experience", priority: "must", tags: [], statement: "Feels quick", refs: ["DESIGN"], verify: "judgment", evidence: "a recording", trace: { source: "intent", ref: "Let owners" } };
    expect(lint(v3({ criteria: [...CONTRACT("T9").criteria, exp] })).problems.join()).toMatch(/AC4: the gate verifies must-criteria of type behavior, threshold and structural only/);
  });
  it("a contract written before the Gate phase still loads and its constraints are simply unbound", () => {
    const old = Contract.parse({ ...CONTRACT("T9"), constraints: [{ ...V3_EXTRA.constraints[1], fact: undefined }, V3_EXTRA.constraints[2]] });
    expect(gateBindings(old, "oracle/T9/check.mjs")).toEqual({ AC1: "oracle:oracle/T9/check.mjs", C3: "judgment" }); // C2 (static, no fact) gets no binding
  });
});

describe("GT3 criterion and constraint -> verification binding by class", () => {
  it("binds every requirement to what proves it and extends the check of record to observable constraints", () => {
    const c = Contract.parse(v3());
    expect(gateBindings(c, "oracle/T9/check.mjs")).toEqual({ AC1: "oracle:oracle/T9/check.mjs", AC3: "static:fact", C1: "regression-set", C2: "static:fact", C3: "judgment", C4: "oracle:oracle/T9/check.mjs" });
    expect(oracleCriteria(c)).toEqual(["AC1", "C4"]); // not the fact, not the regression constraint, not the judgment constraint
    expect(gateBindings(Contract.parse({ ...v3(), constraints: [{ ...V3_EXTRA.constraints[0], id: "C5", kind: "compatibility", verify: "suite" }] }), "o").C5).toBe("suite");
    expect(GATE_VERSION).toBe(3);
    // a plan must still cover every constraint by id
    const plan = { contract: "T9", contract_version: 1, contract_sha256: "a".repeat(64), plan_version: 1, shape: "complex", tasks: [{ id: "T9.a", purpose: "a", covers: ["AC1", "AC3", "C1", "C2", "C4"] }, { id: "T9.b", purpose: "b", covers: [], contributes: ["AC1"], depends_on: ["T9.a"] }] };
    expect(validatePlan(c, "a".repeat(64), plan).problems.join()).toMatch(/C3: not covered by any task/);
  });
});

const EV: GateEvidence = {
  verdict: "FAIL:STATIC", reasons: ["a repository fact required by T9 does not hold"], head_sha: "h1",
  criteria: {
    "T9:AC1": { status: "Verified", check: "oracle:oracle/T9/check.mjs", detail: "", class: "blackbox", kind: "criterion" },
    "T9:AC3": { status: "Not verified", check: "static:fact", detail: "src/domain/sort.ts does not exist in the repository", class: "static", kind: "criterion" },
    "T9:AC5": { status: "Deferred", check: "oracle:oracle/T9/check.mjs", detail: "not yet required at this plan task (was: Not verified) | x", class: "blackbox", kind: "criterion" },
    "T9:C3": { status: "Judgment", check: "judgment", detail: "decided by independent judgment", class: "judgment", kind: "constraint" },
    "T9:C9": { status: "Unbound", check: null, detail: "constraint of a task record written before gate v3", class: "static", kind: "constraint" },
  },
  regression: {},
  checks: { secret_scan_findings: 0, osv: { vulnerabilities: 2, ids: ["GHSA-aaaa", "GHSA-bbbb"] }, opengrep: { error: "binary download/pin mismatch" } },
};

describe("GT4 control-plane reading of gate v3 evidence", () => {
  it("only judged requirements decide: deferred, judgment and unbound records never reach the Builder or the arbiter as failures", () => {
    const cs = criteriaFromGate(EV);
    expect(cs.map((c) => [c.subject, c.status, c.deciding, c.requirement, c.verifyClass])).toEqual([
      ["T9:AC1", "verified", true, "criterion", "blackbox"], ["T9:AC3", "not_verified", true, "criterion", "static"], ["T9:AC5", "unknown", false, "criterion", "blackbox"], ["T9:C3", "unknown", false, "constraint", "judgment"], ["T9:C9", "unknown", false, "constraint", "static"],
    ]);
    const d = correctionDetails(EV);
    expect(d).toMatch(/T9:AC3 \(static:fact\): not verified - src\/domain\/sort.ts does not exist/);
    expect(d).not.toMatch(/AC5|:C3|C9/);
    expect(oracleDefects(EV)).toBeNull(); // a failed repository fact is never a defect of the check
    expect(classifyVerdict("FAIL:STATIC")).toBe("candidate_failure");
  });
  it("scanner results become evidence: secrets decide, dependency and static-analysis findings are recorded and shown", () => {
    expect(scansFromGate(EV)).toEqual([
      { subject: "scan:secrets", status: "verified", severity: "info", detail: "gitleaks: no secret in the head tree" },
      { subject: "scan:dependencies", status: "partially_verified", severity: "info", detail: "OSV-Scanner: 2 known vulnerabilities recorded (not gate-deciding): GHSA-aaaa, GHSA-bbbb" },
      { subject: "scan:static-analysis", status: "unknown", severity: "info", detail: "Opengrep did not complete: binary download/pin mismatch" },
    ]);
    expect(scansFromGate({ checks: { secret_scan_findings: 1, secret_scan_detail: [{ file: "a.env", rule: "generic-api-key", line: 3 }] } })[0]).toMatchObject({ status: "not_verified", severity: "critical" });
    expect(scansFromGate({})).toEqual([]); // a gate that reported no scan yields no evidence (never an invented clean result)
  });
});

const row = (o: Partial<EvRow> & { id: number }): EvRow => ({ seq: o.id, subject: "T9:AC1", status: "verified", oracle: "deterministic", persistence: "regression", source: "gate:1", commitSha: "h1", contractSha256: "c1", detail: "", severity: null, artifactId: null, kind: "criterion", criterionTask: "T9", criterionId: "AC1", collector: "gate", runId: null, gateResultId: 1, checkName: "oracle:x", recordSha256: "r", ...o });
const pkg = (rows: EvRow[], gate: Partial<NonNullable<PackageInput["gate"]>> = {}) => buildPackage({
  task: { id: 1, key: "T9", title: "Sort lists", tier: "standard" }, scope: "task", planTask: null, inScope: null, head: "h1", stage: "gate", contract: { version: 1, sha256: "c1", body: Contract.parse(v3()) }, plan: null,
  gate: { id: 1, checkRunId: 5, verdict: "DONE", kind: "pass", headSha: "h1", contractSha256: "c1", evidenceArtifactId: null, ...gate }, rows, artifacts: {}, chain: { ok: true, rows: rows.length, sealed: rows.length, head: "x", problems: [] },
});
const C = (id: number, cid: string, o: Partial<EvRow> = {}) => row({ id, subject: `T9:${cid}`, criterionId: cid, ...o });

describe("GT5 evidence packages count judged constraints and name the ones that are not", () => {
  const base = [row({ id: 1 }), C(2, "AC3", { checkName: "static:fact" }), C(3, "C1", { checkName: "regression-set" }), C(4, "C2", { checkName: "static:fact" }), C(5, "C3", { status: "unknown", checkName: "judgment" }), C(6, "C4")];
  it("complete when every must and every judged constraint is verified; the judgment constraint is listed, not counted", () => {
    const p = pkg(base);
    expect(p.status).toBe("complete");
    expect(p.body.constraints.map((c) => [c.id, c.counted, c.status])).toEqual([["C1", true, "verified"], ["C2", true, "verified"], ["C3", false, "not_verified"], ["C4", true, "verified"]]);
    expect(p.body.constraints[2]!.reason).toMatch(/decided by independent judgment, not by the gate/);
    expect(p.body.handoff.decision).toMatchObject({ constraints_counted: 3, constraints_not_counted: ["C3"] });
    expect(p.body.handoff.verifier.judgment_constraints).toEqual(["C3"]);
  });
  it("a failed or unknown judged constraint is a gap like a failed must; a passing verdict over it is a contradiction", () => {
    const failed = base.map((r) => (r.criterionId === "C2" ? { ...r, status: "not_verified" as const, detail: "the change touches drizzle/0007_x.sql" } : r));
    expect(pkg(failed, { verdict: "FAIL:STATIC", kind: "candidate_failure" })).toMatchObject({ status: "incomplete", body: { gaps: ["T9:C2 (constraint) is not verified: the change touches drizzle/0007_x.sql"] } });
    expect(pkg(failed).status).toBe("inconsistent");
    expect(pkg(base.map((r) => (r.criterionId === "C4" ? { ...r, status: "unknown" as const } : r)), { verdict: "BLOCKED:EVIDENCE", kind: "blocked" }).status).toBe("blocked");
  });
  it("evidence from before gate v3 (no constraint rows, or unbound) is not counted and not required", () => {
    expect(pkg([row({ id: 1 }), C(2, "AC3", { checkName: "static:fact" })]).body.constraints.every((c) => !c.counted)).toBe(true);
    expect(pkg([row({ id: 1 }), C(2, "AC3"), C(3, "C2", { status: "unknown", checkName: "unbound" })]).status).toBe("complete");
  });
});

describe("GT6 end to end: a contract with a structural must and constraints of every class", () => {
  it("writes the bindings into the task record, corrects a failed repository fact without the arbiter, and packages the result", async () => {
    const { db, clk, ex, id, state } = await start({ v3: { staticFailsFirst: true } });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const [c] = await contractRows(db, id);
    expect(c!.lint).toEqual({ ok: true, problems: [] });
    // the task record committed with the contract: every requirement bound by class, and the strict gate version
    const prFiles = ex.log.find((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_files")!;
    const files = ((prFiles.params.ops as Record<string, unknown>[])[0]!.files ?? {}) as Record<string, string>;
    const tj = JSON.parse(Buffer.from(files["tasks/T9/task.json"]!, "base64").toString());
    expect(tj.checks).toEqual({ AC1: "oracle:oracle/T9/check.mjs", AC3: "static:fact", C1: "regression-set", C2: "static:fact", C3: "judgment", C4: "oracle:oracle/T9/check.mjs" });
    expect(tj.gate_version).toBe(3);
    // the blind Verifier was asked to cover the observable constraint too, and only that one
    expect(state.verifierPrompts.find((p) => p.includes("oracle of record"))).toMatch(/covering exactly these criteria:\s+AC1, C4 \(ids starting with "C" are constraints/);
    // FAIL:STATIC went straight back to the Builder with the fact; no arbiter, no oracle repair, nobody asked
    const gates = await db.select().from(gateResults).where(eq(gateResults.taskId, id)).orderBy(asc(gateResults.id));
    expect(gates.map((g) => [g.headSha, g.verdict, g.kind])).toEqual([["h1", "FAIL:STATIC", "candidate_failure"], ["h2", "DONE", "pass"]]);
    expect(state.builderPrompts.find((p) => p.includes("VERDICT: FAIL:STATIC"))).toMatch(/T9:AC3 \(static:fact\): not verified - src\/domain\/sort.ts does not exist in the repository/);
    expect(state.verifierPrompts.some((p) => /arbiter/i.test(p))).toBe(false);
    expect((await taskRow(db, id)).corrections).toBe(1);
    expect((await openDecisions(db, id)).map((d) => d.kind)).toEqual(["acceptance"]);
    // evidence: constraints and scans are rows like criteria; the final package counts the judged constraints
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id)).orderBy(asc(evidence.seq));
    const h2 = ev.filter((r) => r.commitSha === "h2");
    expect(h2.filter((r) => r.criterionId?.startsWith("C")).map((r) => [r.criterionId, r.status, r.checkName])).toEqual([["C1", "verified", "regression-set"], ["C2", "verified", "static:fact"], ["C3", "unknown", "judgment"], ["C4", "verified", "oracle:oracle/T9/check.mjs"]]);
    expect(h2.filter((r) => r.kind === "scan").map((r) => [r.subject, r.status])).toEqual([["scan:secrets", "verified"], ["scan:dependencies", "partially_verified"], ["scan:static-analysis", "verified"]]);
    const ps = await db.select().from(evidencePackages).where(eq(evidencePackages.taskId, id)).orderBy(asc(evidencePackages.id));
    expect(ps.map((p) => [p.headSha, p.stage, p.status])).toEqual([["h1", "gate", "incomplete"], ["h2", "gate", "complete"], ["h2", "done", "complete"]]);
    const body = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.id, ps.at(-1)!.artifactId)))[0]!.content);
    expect(body.criteria.filter((k: { priority: string }) => k.priority === "must").map((k: { id: string; status: string }) => [k.id, k.status])).toEqual([["AC1", "verified"], ["AC3", "verified"]]);
    expect(body.constraints.map((k: { id: string; counted: boolean }) => [k.id, k.counted])).toEqual([["C1", true], ["C2", true], ["C3", false], ["C4", true]]);
    expect(body.scans.map((s: { scanner: string; status: string }) => [s.scanner, s.status])).toEqual([["dependencies", "partially_verified"], ["secrets", "verified"], ["static-analysis", "verified"]]);
    expect(body.handoff.verifier.judgment_constraints).toEqual(["C3"]);
    void tasks;
  });
});
