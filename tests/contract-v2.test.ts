import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contracts, plans, tasks } from "@/db/schema";
import { Contract, contractIntegrity, intentHash, lintContract, outcomeChanged, stableIdProblems, canonicalJson, sha256 } from "@/domain/contract";
import { classifyShape, fulfilmentBlockers, gateScope, integratedRequirement, partialMergeDecision, planFile, validatePlan, PlanBody, CALIBRATION } from "@/domain/plan";
import { contractEscalation } from "@/domain/policy";
import { runAdmin } from "@/server/admin";
import { createTask, decideBlock } from "@/server/owner";
import { activePlan, recordPlan } from "@/server/plans";
import { clock, contractApproved, contractRows, FakeExecutor, openDecisions, policyDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario } from "./support/fixture-handlers";

/* Locked Contract specification v2: its twelve acceptance tests (AT1..AT12) and the behaviours listed for this phase. */

const INTENT = "Sort lists\nLet owners sort their lists alphabetically on the list index.";
const v2 = (over: Record<string, unknown> = {}) => ({ ...CONTRACT("T9"), intent_sha256: intentHash(INTENT), policies: ["policy.json"], ...over }) as Record<string, unknown>;
const lint = (c: unknown, previous: unknown[] = []) => lintContract(c, { id: "T9", tier: "standard" }, { intent: INTENT, previous });
const crit = (over: Record<string, unknown>) => ({ id: "AC1", type: "behavior", priority: "must", tags: [], given: "g", when: "w", then: "t", verify: "blackbox", trace: { source: "intent", ref: "Let owners" }, ...over });
const big = (n: number, extra: (i: number) => Record<string, unknown> = () => ({})) => v2({ criteria: Array.from({ length: n }, (_, i) => crit({ id: `AC${i + 1}`, ...extra(i) })) }) as unknown as Contract;
const SHA = "a".repeat(64);
const plan = (c: Contract, tasks: unknown[], integration: string[] = [], over: Record<string, unknown> = {}) => ({ contract: c.id, contract_version: c.version, contract_sha256: SHA, plan_version: 1, shape: "complex", shape_reasons: [], tasks, integration, ...over });

// a real V1 contract exactly as committed in the managed repository (tasks/T1/contract.json of agents-app), abbreviated criteria text
const V1_FILE = {
  id: "T1", title: "New intent shortcut on the Command page", traces_to: ["OWNER-INTENT-T1"], tier: "standard",
  scope: { summary: "A shortcut.", paths: ["**"] }, non_goals: [], open_questions: [], interface: { ui: "link New intent" },
  criteria: [{ id: "AC1", type: "behavior", priority: "must", tags: [], given: "the owner on /", when: "they look at Projects", then: "each project has a New intent link" }],
  canary_routes: ["/"], version: 1,
};

describe("contract v2: fields, lint, traceability", () => {
  it("AT12 an existing V1 contract file still loads, lints (legacy read) and keeps today's gate scope", () => {
    expect(Contract.safeParse(V1_FILE).success).toBe(true);
    expect(lintContract(V1_FILE, { id: "T1", tier: "standard" })).toEqual({ ok: true, problems: [] });
    expect(gateScope(null, "agents", [], false)).toBeNull(); // no plan: every criterion required, as before
    // ... but a V1-shaped contract can no longer be WRITTEN: new fields are required on write
    expect(lintContract(V1_FILE, { id: "T1", tier: "standard" }, { intent: "x" }).ok).toBe(false);
  });

  it("accepts a complete v2 contract; new fields validate and survive canonical bytes", () => {
    const c = v2({ constraints: [{ id: "C1", kind: "regression", statement: "Sign-in keeps working", verify: "blackbox", trace: { source: "project", ref: "T2 sign-in" } }], assumptions: [{ id: "A1", question: "Case-sensitive?", chosen: "No", basis: "existing behaviour", reversible: true }] });
    expect(lint(c)).toEqual({ ok: true, problems: [] });
    const text = canonicalJson(c);
    const back = Contract.parse(JSON.parse(text));
    expect(back.constraints![0]!.trace.source).toBe("project");
    expect(back.assumptions![0]!.chosen).toBe("No");
    expect(back.policies).toEqual(["policy.json"]); // a reference, not policy text
    expect(contractIntegrity({ body: JSON.parse(text), text, sha256: sha256(text) })).toEqual([]);
  });

  it("AT1 a must-criterion without verify, or any criterion without a valid trace, fails lint (no drafter inflation)", () => {
    const p = (c: unknown) => lint(c).problems.join(" | ");
    expect(p(v2({ criteria: [crit({ verify: undefined })] }))).toMatch(/AC1: a must-criterion needs a verification class/);
    expect(p(v2({ criteria: [crit({ trace: undefined })] }))).toMatch(/AC1: trace is required/);
    expect(p(v2({ criteria: [crit({ trace: { source: "intent", ref: "Add a dark mode toggle" } })] }))).toMatch(/must quote the owner's intent verbatim/);
    expect(p(v2({ criteria: [crit({ trace: { source: "intent", ref: "sort" } })] }))).toMatch(/verbatim/); // too short to mean anything
    expect(p(v2({ criteria: [crit({ trace: { source: "policy", ref: "some-other-policy: rule" } })] }))).toMatch(/must name one of the referenced policies/);
    expect(p(v2({ criteria: [crit({}), crit({ id: "AC2", trace: { source: "necessary", ref: "it is nice to have" } })] }))).toMatch(/AC2: a "necessary" trace must name the existing criterion/);
    expect(p(v2({ criteria: [crit({}), crit({ id: "AC2", trace: { source: "necessary", ref: "AC7: needed" } })] }))).toMatch(/AC2: a "necessary" trace/);
    expect(p(v2({ criteria: [crit({ trace: { source: "necessary", ref: "AC1: itself" } })] }))).toMatch(/AC1: a "necessary" trace/);
    expect(p(v2({ criteria: [crit({ trace: { source: "owner", ref: "x" } })] }))).toMatch(/schema/);
    expect(p(v2({ constraints: [{ id: "C1", kind: "security", statement: "s", verify: "static", trace: { source: "policy", ref: "elsewhere" } }] }))).toMatch(/C1: a policy trace/);
    expect(lint(v2({ criteria: [crit({}), crit({ id: "AC2", trace: { source: "necessary", ref: "AC1: cannot sort without a control" } }), crit({ id: "AC3", trace: { source: "policy", ref: "policy.json: protected paths" } })] })).ok).toBe(true);
    expect(p(v2({ intent_sha256: intentHash("another intent") }))).toMatch(/intent_sha256/);
    expect(p(v2({ policies: [] }))).toMatch(/policies must reference/);
  });

  it("verification classes are classes of proof, never tools, and must fit the criterion type", () => {
    expect(lint(v2({ criteria: [crit({ verify: "playwright" })] })).problems.join()).toMatch(/schema/);
    expect(lint(v2({ criteria: [crit({ verify: "static" })] })).problems.join()).toMatch(/verify "static" does not fit type behavior/);
    expect(lint(v2({ criteria: [crit({ type: "threshold", metric: "LCP", target: "2.5 s", verify: "measure" })] })).ok).toBe(true);
  });

  it("AT2 experience: needs an evidence requirement, may not disguise behaviour, and stays blocked as MUST until the gate can prove it", () => {
    const exp = (over: Record<string, unknown>) => v2({ criteria: [crit({}), { id: "AC2", type: "experience", priority: "should", tags: [], statement: "Feels calm", refs: ["DESIGN"], trace: { source: "intent", ref: "Let owners" }, ...over }] });
    expect(lint(exp({ verify: "judgment" })).problems.join()).toMatch(/AC2: a judgment-class criterion must state its evidence requirement/);
    expect(lint(exp({ verify: "judgment", evidence: "screenshots of the list at 3 widths" })).ok).toBe(true);
    expect(lint(exp({ given: "a", when: "b", then: "c" })).problems.join()).toMatch(/AC2: this is ordinary behaviour or a threshold/);
    expect(lint(exp({ target: "under 200 ms" })).problems.join()).toMatch(/do not label it "experience"/);
    // representable, but NOT activated: the current gate cannot verify it, so nothing is weakened (UNKNOWN can never satisfy a must)
    expect(lint(exp({ priority: "must", verify: "judgment", evidence: "e" })).problems.join()).toMatch(/AC2: the gate verifies must-criteria of type behavior, threshold and structural only/);
    expect(lint(v2({ criteria: [crit({}), { id: "AC2", type: "structural", priority: "must", tags: [], rule: "r", check: "c", verify: "static", trace: { source: "intent", ref: "Let owners" } }] })).problems.join()).toMatch(/AC2: a structural must-criterion needs a valid "fact"/); // Gate phase: a structural must is allowed with a repository fact
  });

  it("criterion ids are stable across versions: no reuse of a retired id, no id changing into another requirement", () => {
    const v1 = v2({ criteria: [crit({}), crit({ id: "AC2" })] });
    const v2b = v2({ criteria: [crit({})], version: 2 });
    expect(stableIdProblems([v1], Contract.parse(v2({ criteria: [crit({ then: "reworded, same requirement" }), crit({ id: "AC2" })] })))).toEqual([]);
    expect(stableIdProblems([v1, v2b], Contract.parse(v2({ criteria: [crit({}), crit({ id: "AC2" })] }))).join()).toMatch(/AC2: this id was retired/);
    expect(lint(v2({ criteria: [crit({ type: "threshold", metric: "m", target: "1 s", verify: "measure" })] }), [v1]).problems.join()).toMatch(/AC1: an existing id may not change into a different requirement \(behavior -> threshold\)/);
    expect(lint(v2({ criteria: [crit({}), crit({ id: "AC3" })] }), [v1, v2b]).ok).toBe(true); // a new requirement gets a new id
  });

  it("AT8 routine ambiguity is recorded as an assumption and escalates only past the calibration thresholds", () => {
    const facts = (body: unknown) => ({ taskTier: "standard" as const, body: Contract.parse(body), lintOk: true, oracleProblems: [], calibrated: true });
    const a = (n: number, reversible = true) => Array.from({ length: n }, (_, i) => ({ id: `A${i + 1}`, question: "q", chosen: "c", basis: "existing behaviour", reversible }));
    expect(contractEscalation(facts(v2({ assumptions: a(CALIBRATION.maxAssumptions) })))).toEqual([]);
    expect(contractEscalation(facts(v2({ assumptions: a(CALIBRATION.maxAssumptions + 1) }))).join()).toMatch(/4 assumptions were needed/);
    expect(contractEscalation(facts(v2({ assumptions: a(1, false) }))).join()).toMatch(/not reversible \(A1\)/);
    const nec = (k: number) => v2({ criteria: [crit({}), ...Array.from({ length: 3 }, (_, i) => crit({ id: `AC${i + 2}`, trace: i < k ? { source: "necessary", ref: "AC1: needed" } : { source: "intent", ref: "Let owners" } }))] });
    expect(contractEscalation(facts(nec(1)))).toEqual([]); // 1 of 4
    expect(contractEscalation(facts(nec(2))).join()).toMatch(/2 of 4 must-criteria were added by the drafter/);
  });

  it("AT7 a changed criterion is an outcome change; a corrected assumption or trace is not", () => {
    const base = Contract.parse(v2({ assumptions: [{ id: "A1", question: "q", chosen: "x", basis: "policy", reversible: true }] }));
    expect(outcomeChanged(base, Contract.parse(v2({ assumptions: [{ id: "A1", question: "q", chosen: "y", basis: "stated intent", reversible: true }] })))).toBe(false);
    expect(outcomeChanged(base, Contract.parse(v2({ criteria: [crit({ trace: { source: "intent", ref: "their lists alphabetically" } }), (CONTRACT("T9").criteria as unknown[])[1]] })))).toBe(true); // AC1 text differs from the fixture's
    const same = Contract.parse(v2({}));
    const retraced = Contract.parse(JSON.parse(JSON.stringify(v2({})).replace('"ref":"Let owners"', '"ref":"sort their lists"')));
    expect(outcomeChanged(same, retraced)).toBe(false);
    for (const change of [{ non_goals: ["No drag and drop"] }, { scope: { summary: "s", paths: ["src/**"] } }, { interface: { ui: "other" } }, { constraints: [{ id: "C1", kind: "prohibited", statement: "s", verify: "static", trace: { source: "intent", ref: "Let owners" } }] }])
      expect(outcomeChanged(same, Contract.parse(v2(change)))).toBe(true);
  });
});

describe("plan: shape, decomposition, coverage", () => {
  it("AT3 each shape rule classifies complex with its reason; a plain contract is atomic", () => {
    expect(classifyShape(Contract.parse(v2({})))).toEqual({ shape: "atomic", reasons: [] });
    expect(classifyShape(big(6)).shape).toBe("atomic");
    expect(classifyShape(big(7)).reasons.join()).toMatch(/rule 1: 7 must-criteria/);
    expect(classifyShape(big(4, (i) => ({ group: i < 2 ? "export" : "import" }))).reasons.join()).toMatch(/rule 2: 2 independent deliverables \(export, import\)/);
    expect(classifyShape(big(2, (i) => ({ tags: i === 0 ? ["migration"] : [] }))).reasons.join()).toMatch(/rule 3/);
    expect(classifyShape(big(2, (i) => ({ tags: i === 0 ? ["interface-change"] : [] }))).reasons.join()).toMatch(/rule 4/);
    expect(classifyShape(Contract.parse(v2({})), { budgetExhausted: true }).reasons.join()).toMatch(/rule 5/);
    // never complex merely because the tier is critical or one group is named
    expect(classifyShape({ ...big(3, () => ({ group: "one" })), tier: "critical" } as Contract).shape).toBe("atomic");
  });

  const c5 = { ...big(5), constraints: [{ id: "C1", kind: "regression", statement: "s", verify: "blackbox", trace: { source: "project", ref: "T2" } }] } as unknown as Contract;
  const T = (id: string, covers: string[], over: Record<string, unknown> = {}) => ({ id, purpose: "p", covers, ...over });
  const good = () => plan(c5, [T("T9.a", ["AC1", "AC2"]), T("T9.b", ["AC3"], { depends_on: ["T9.a"], contributes: ["AC5", "C1"] }), T("T9.c", ["AC4"], { contributes: ["AC5"] })], ["AC5", "C1"]);

  it("AT4 coverage invariant: every must-criterion and constraint is covered or integration-only; unknown ids are refused", () => {
    expect(validatePlan(c5, SHA, good())).toMatchObject({ ok: true, problems: [] });
    const p = (raw: unknown) => validatePlan(c5, SHA, raw).problems.join(" | ");
    expect(p(plan(c5, [T("T9.a", ["AC1", "AC2"]), T("T9.b", ["AC3", "AC4"])]))).toMatch(/AC5: not covered by any task and not marked integration-only \(requirement would be lost\).*C1: not covered/);
    expect(p(plan(c5, [T("T9.a", ["AC1", "AC2", "AC9"]), T("T9.b", ["AC3", "AC4", "AC5", "C1"])]))).toMatch(/T9.a: references AC9, which is not a criterion or constraint of the contract/);
    expect(p(plan(c5, [T("T9.a", ["AC1", "AC2", "AC3", "AC4", "C1"]), T("T9.b", ["AC1"])], ["AC5"]))).toMatch(/AC5: integration-only, but no task contributes to it/);
    expect(p(plan(c5, [T("T9.a", ["AC1", "AC2", "AC3", "AC4", "C1", "AC5"]), T("T9.b", ["AC1"], { contributes: ["AC5"] })], ["AC5"]))).toMatch(/AC5: either covered by a task or integration-only, not both/);
    expect(p(plan(c5, [T("T9.a", ["AC1", "AC2", "AC3", "AC4", "AC5", "C1"]), T("T9.b", ["AC1"])], ["AC77"]))).toMatch(/integration references AC77/);
    // a dropped task no longer covers anything
    const dropped = good();
    (dropped.tasks[2] as Record<string, unknown>).status = "dropped";
    expect(validatePlan(c5, SHA, dropped).problems.join()).toMatch(/AC4: not covered/);
    // coverage is by id, never by text: a task cannot carry criteria of its own
    expect(p(plan(c5, [{ ...T("T9.a", ["AC1"]), local_criteria: [{ id: "L1" }] }, T("T9.b", ["AC2"])]))).toMatch(/schema/);
  });

  it("decomposition is one level deep, a DAG, bound to the contract version and hash", () => {
    const p = (raw: unknown) => validatePlan(c5, SHA, raw).problems.join(" | ");
    expect(p(plan(c5, [{ ...T("T9.a", ["AC1"]), tasks: [T("T9.a.1", ["AC1"])] }, T("T9.b", ["AC2"])]))).toMatch(/schema/); // no nested task graph
    expect(p(plan(c5, [T("T9.a.1", ["AC1"]), T("T9.b", ["AC2"])]))).toMatch(/task ids are T9.a … T9.z/);
    const cyc = good();
    (cyc.tasks[0] as Record<string, unknown>).depends_on = ["T9.b"];
    expect(p(cyc)).toMatch(/must not form a cycle/);
    expect(p(plan(c5, [T("T9.a", ["AC1"], { depends_on: ["T9.z"] }), T("T9.b", ["AC2"])]))).toMatch(/depends on unknown task T9.z/);
    expect(p(plan(c5, [T("T9.a", ["AC1", "AC2", "AC3", "AC4", "AC5", "C1"])]))).toMatch(/at least two tasks/);
    expect(p(good() && { ...good(), contract_sha256: "b".repeat(64) })).toMatch(/not bound to this contract's hash/);
    expect(p({ ...good(), contract_version: 2 })).toMatch(/bound to contract version 2/);
    expect(p(plan(c5, [T("T9.a", ["AC1"])], [], { shape: "atomic" }))).toMatch(/an atomic plan has no tasks/);
  });

  it("per-task gating scope: only what the task and already-merged tasks cover; everything at integration", () => {
    const g = PlanBody.parse(good());
    expect(gateScope(g, "a", [], false)).toEqual(["AC1", "AC2"]); // AC3..AC5 may still be incomplete
    expect(gateScope(g, "b", ["a"], false)).toEqual(["AC1", "AC2", "AC3"]); // merged work is protected (regression)
    expect(gateScope(g, null, ["a"], false)).toEqual(["AC1", "AC2"]); // as regression for a later contract
    expect(gateScope(g, "integration", ["a", "b", "c"], false)).toBeNull(); // not a plan task: the full original contract
    expect(gateScope(g, null, ["a", "b", "c"], true)).toBeNull();
    expect(gateScope(PlanBody.parse(plan(c5, [], [], { shape: "atomic" })), "a", [], false)).toBeNull();
    // the committed plan file carries ids only - no criterion text is copied out of the contract
    expect(planFile(g)).not.toMatch(/given|when|then|statement/);
    expect(JSON.parse(planFile(g)).tasks[0]).toEqual({ id: "T9.a", covers: ["AC1", "AC2"], contributes: [], depends_on: [] });
  });

  it("AT5 all tasks passing is not sufficient: a decomposed contract needs integrated verification against the ORIGINAL contract", () => {
    const g = PlanBody.parse(good());
    const iv = integratedRequirement(g);
    expect(iv).toEqual({ required: true, status: "pending", head: null, contract_version: 1, contract_sha256: SHA });
    const done = { ...g, tasks: g.tasks.map((t) => ({ ...t, status: "done" as const })) };
    expect(fulfilmentBlockers(g, iv).join()).toMatch(/plan tasks not done: T9.a, T9.b, T9.c/);
    expect(fulfilmentBlockers(done, iv).join()).toMatch(/integrated verification against contract v1 is pending/);
    expect(fulfilmentBlockers(done, { ...iv, status: "failed" }).join()).toMatch(/is failed \(every task passing is not sufficient\)/);
    expect(fulfilmentBlockers(done, { ...iv, status: "passed" })).toEqual([]);
    expect(integratedRequirement(PlanBody.parse(plan(c5, [], [], { shape: "atomic" })))).toEqual({ required: false, status: "not_required" });
  });

  it("AT11 partially merged work: KEEP, REVERT, NEEDS OWNER", () => {
    const ok = { mergedTasksSelfContained: true, mainHealthy: true, conflictsWithRevisedContract: false, onlyServesAbandonedOutcome: false, revertPassesGate: null, laterWorkDependsOnIt: null };
    expect(partialMergeDecision(ok).decision).toBe("KEEP");
    expect(partialMergeDecision({ ...ok, onlyServesAbandonedOutcome: true, revertPassesGate: true, laterWorkDependsOnIt: false })).toMatchObject({ decision: "REVERT" });
    expect(partialMergeDecision({ ...ok, mergedTasksSelfContained: false, revertPassesGate: true, laterWorkDependsOnIt: false }).reasons.join()).toMatch(/half-delivered/);
    expect(partialMergeDecision({ ...ok, conflictsWithRevisedContract: true, revertPassesGate: false, laterWorkDependsOnIt: false }).decision).toBe("NEEDS_OWNER");
    expect(partialMergeDecision({ ...ok, mainHealthy: false, revertPassesGate: true, laterWorkDependsOnIt: true }).decision).toBe("NEEDS_OWNER");
    expect(partialMergeDecision({ ...ok, mainHealthy: null })).toMatchObject({ decision: "NEEDS_OWNER", reasons: ["cannot be established: mainHealthy"] });
  });
});

describe("contract v2 in the control loop", () => {
  const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario(opts);
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    return { db, clk, state, ex, id, project };
  };

  it("the atomic workflow is unchanged; lineage is set by the control plane; an atomic plan is recorded; AT10 Git bytes and DB row agree", async () => {
    const { db, clk, ex, id } = await start();
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const [c] = await contractRows(db, id);
    const body = Contract.parse(c!.body);
    expect(body.intent_sha256).toBe(intentHash(INTENT));
    expect(body.policies).toEqual(["policy.json", "project:reading-lists"]);
    expect(contractIntegrity(c!)).toEqual([]);
    const pr = ex.log.find((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_files")!;
    const files = (pr.params.ops as { files: Record<string, string> }[])[0]!.files;
    expect(Buffer.from(files["tasks/T9/contract.json"]!, "base64").toString()).toBe(c!.text); // committed bytes = stored bytes
    expect(sha256(c!.text)).toBe(c!.sha256);
    expect(Object.keys(files).some((f) => f.endsWith("plan.json"))).toBe(false); // atomic: nothing new reaches the gate
    const p = await activePlan(db, id);
    expect(PlanBody.parse(p!.body)).toMatchObject({ shape: "atomic", tasks: [], contract_version: 1, contract_sha256: c!.sha256, plan_version: 1 });
    expect(p!.integrated).toEqual({ required: false, status: "not_required" });
    expect((await openDecisions(db, id)).map((d) => d.kind)).toEqual(["acceptance"]);
  });

  it("AT10 a row that no longer matches its committed bytes is refused before anything is proposed to the repository", async () => {
    const { db, clk, ex, id } = await start();
    await runUntil(db, ex, clk, async () => (await contractRows(db, id)).some((c) => c.oracleJs !== null));
    const [c] = await contractRows(db, id);
    await db.update(contracts).set({ body: { ...c!.body, title: "tampered" } }).where(eq(contracts.id, c!.id));
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_EVIDENCE");
    expect((await taskRow(db, id)).stateReason).toMatch(/does not match its committed bytes/);
    expect(ex.log.some((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_files")).toBe(false);
  });

  it("a drafted contract without traceability never becomes authoritative (sent back to the drafter, then blocked)", async () => {
    const { db, clk, ex, id, state } = await start({ noTrace: true });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_EVIDENCE");
    expect(state.drafts).toBe(9); // 3 lint attempts x (1 + 2 automatic recoveries); never approved
    expect(await contractApproved(db, id)).toBe(false);
    expect((await contractRows(db, id)).every((c) => c.status === "lint_failed")).toBe(true);
    expect(state.builderPrompts.some((p) => p.includes("AC1: trace is required"))).toBe(true); // the mechanical finding goes back to the drafter
  });

  it("AT6 re-planning and re-classification never change the contract hash or version; AT9 a plan survives pause/resume intact", async () => {
    const { db, clk, ex, id } = await start();
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "IN_PROGRESS");
    const before = await contractRows(db, id);
    const c = before[0]!;
    const bodyC = Contract.parse(c.body);
    // re-classify (rule 5) and re-plan twice
    const r1 = await recordPlan(db, c, { facts: { budgetExhausted: true }, reason: "test: reclassify" });
    expect(r1.ok && PlanBody.parse(r1.plan.body)).toMatchObject({ shape: "complex", plan_version: 2, shape_reasons: [expect.stringMatching(/rule 5/)] });
    const bad = await recordPlan(db, c, { tasks: [{ id: "T9.a", purpose: "p", covers: ["AC9"] }, { id: "T9.b", purpose: "p", covers: [] }], reason: "test: bad plan" });
    expect(bad.ok).toBe(false); // a plan with a hole or an unknown id is refused and nothing is superseded
    expect((await activePlan(db, id))!.planVersion).toBe(2);
    const r2 = await recordPlan(db, c, { tasks: [{ id: "T9.a", purpose: "data", covers: ["AC1"], status: "done", evidence: ["gate_result:1"] }, { id: "T9.b", purpose: "ui", covers: [], contributes: ["AC1"], depends_on: ["T9.a"], status: "running" }], reason: "test: decompose" });
    expect(r2.ok).toBe(true);
    const all = await db.select().from(plans).where(eq(plans.taskId, id)).orderBy(plans.planVersion);
    expect(all.map((p) => [p.planVersion, p.status])).toEqual([[1, "superseded"], [2, "superseded"], [3, "active"]]);
    expect(all.every((p) => p.contractId === c.id)).toBe(true);
    const after = await contractRows(db, id);
    expect(after.map((x) => [x.id, x.version, x.sha256, x.text, x.status])).toEqual(before.map((x) => [x.id, x.version, x.sha256, x.text, x.status]));
    expect(bodyC.version).toBe(1);
    // pause / resume: nothing about the plan or the task's counters is lost
    const snap = async () => ({ plan: await activePlan(db, id), t: await db.select({ corrections: tasks.corrections, infraRetries: tasks.infraRetries, step: tasks.step, stepData: tasks.stepData, head: tasks.headSha, branch: tasks.branch, contract: tasks.currentContractId }).from(tasks).where(eq(tasks.id, id)) });
    const s0 = await snap();
    await runAdmin(db, "owner", { op: "pause", taskId: id, reason: "quota exhausted, pausing the job" });
    for (let i = 0; i < 5; i++) { await (await import("@/worker/orchestrator")).tick(db, clk.now); await ex.drain(); clk.advance(35); }
    expect(await snap()).toEqual(s0);
    await runAdmin(db, "owner", { op: "resume", taskId: id, reason: "quota is available again" });
    expect((await snap()).plan).toEqual(s0.plan);
    expect(PlanBody.parse(s0.plan!.body).tasks.map((t) => [t.id, t.status, t.evidence])).toEqual([["T9.a", "done", ["gate_result:1"]], ["T9.b", "running", []]]);
  });

  it("AT5 in the loop: a decomposed contract is not DONE while its integrated verification is outstanding", async () => {
    const { db, clk, ex, id } = await start();
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "IN_PROGRESS");
    const [c] = await contractRows(db, id);
    const r = await recordPlan(db, c!, { tasks: [{ id: "T9.a", purpose: "a", covers: ["AC1"], status: "done" }, { id: "T9.b", purpose: "b", contributes: ["AC1"], covers: [], status: "done" }], reason: "test" });
    expect(r.ok).toBe(true);
    await runUntil(db, ex, clk, async () => ["BLOCKED_EVIDENCE", "DONE"].includes((await taskRow(db, id)).state));
    const t = await taskRow(db, id);
    expect(t.state).toBe("BLOCKED_EVIDENCE");
    expect(t.stateReason).toMatch(/not fulfilled yet: integrated verification against contract v1 is pending/);
    await db.update(plans).set({ integrated: { required: true, status: "passed", head: t.headSha, contract_version: 1, contract_sha256: c!.sha256 } }).where(eq(plans.id, (r as { plan: { id: number } }).plan.id));
    const [d] = await openDecisions(db, id);
    expect(d!.recommendation).toBeNull();
    await decideBlock(db, { decisionId: d!.id, choice: "retry", note: "" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
  });

  it("AT7 in the loop: an outcome-unchanged revision is a new integer version approved by policy; an outcome change follows escalation; check-only revisions stay separate", async () => {
    // version 1 escalates (security tag) so the owner is involved once; the revision then only records an assumption
    const { db, clk, ex, id, state } = await start({ draftSequence: [{ tag: "security" }, { tag: "security", assumptions: 1 }, { tag: "security", then: "B is listed before A" }], oracleCrash: false });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_owner_contract");
    const { decideContract } = await import("@/server/owner");
    const [c1] = await contractRows(db, id);
    await decideContract(db, { taskId: id, contractId: c1!.id, choice: "approve", note: "", sha256: c1!.sha256 });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "IN_PROGRESS");
    // the Builder blocks; the owner answers; the drafter revises: same outcome, one more recorded assumption
    const revise = async () => {
      await db.update(tasks).set({ state: "PROPOSED", step: "draft_start", stepData: { revision: { previous: "", ownerNote: "clarify" }, attempt: 1 } }).where(eq(tasks.id, id));
    };
    await revise();
    await runUntil(db, ex, clk, async () => (await contractRows(db, id)).length === 2 && (await taskRow(db, id)).state === "CONTRACTED" || (await taskRow(db, id)).state === "IN_PROGRESS" && (await contractRows(db, id)).length === 2);
    const rows = await contractRows(db, id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1]!.sha256).not.toBe(rows[0]!.sha256); // any change to the contract file is a new version
    const pol = (await policyDecisions(db, id)).filter((d) => d.kind === "contract_approval");
    expect(pol.length).toBe(1);
    expect(pol[0]!.note).toMatch(/required outcome is unchanged/); // approved by policy although v1 needed the owner
    expect(rows.every((r) => r.kind === "contract")).toBe(true); // not a check-only revision
    // now the outcome itself changes: escalation rules apply again (security tag -> owner)
    await revise();
    await runUntil(db, ex, clk, async () => (await contractRows(db, id)).length === 3 && (await taskRow(db, id)).step === "await_owner_contract");
    expect((await openDecisions(db, id)).map((d) => d.kind)).toEqual(["contract_approval"]);
    expect(state.drafts).toBe(3);
    // every version is bound to a plan of its own contract row; plans never created a contract version
    const ps = await db.select().from(plans).where(eq(plans.taskId, id)).orderBy(plans.planVersion);
    expect(ps.map((p) => p.contractId)).toEqual([rows[0]!.id, rows[1]!.id]);
  });
});
