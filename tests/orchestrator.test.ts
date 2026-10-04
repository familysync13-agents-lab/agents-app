import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { decisions, evidence, gateResults, runs, tasks, transitions } from "@/db/schema";
import { canonicalJson, intentHash } from "@/domain/contract";
import { createTask, decideBlock } from "@/server/owner";
import { clock, contractRows, FakeExecutor, contractApproved, openDecisions, policyDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario } from "./support/fixture-handlers";

describe("control loop (scripted executor)", () => {
  it("runs intent -> contract -> build -> gate failure -> automatic correction -> independent check -> DONE -> ACCEPTED", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ failFirstGate: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });

    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    const t1 = await taskRow(db, id);
    expect(t1.key).toBe("T9");
    expect(t1.state).toBe("PROPOSED");
    const [c] = await contractRows(db, id);
    expect(c!.lint.ok).toBe(true);
    // the drafter's contract plus the lineage the control plane sets itself (intent hash, policy references)
    expect(c!.text).toBe(canonicalJson({ ...CONTRACT("T9"), intent_sha256: intentHash("Sort lists\nLet owners sort their lists alphabetically on the list index."), policies: ["policy.json", "project:reading-lists"] }));
    expect(c!.oracleJs).toContain("criterion");
    expect(state.builderPrompts[0]).toContain("Sort lists");
    expect(await openDecisions(db, id)).toEqual([]); // a contract within the intent is not an owner decision
    expect((await policyDecisions(db, id)).map((d) => [d.kind, d.choice])).toEqual([["contract_approval", "approve"]]);

    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "IN_PROGRESS");
    // the mutation test is critical-tier depth: raise the tier of the built task to exercise it in this end-to-end run
    await db.update(tasks).set({ tier: "critical" }).where(eq(tasks.id, id));
    const cc = (await contractRows(db, id))[0]!;
    expect(cc.status).toBe("merged");
    expect(cc.mergeCommit).toBe("m1");
    const prFiles = ex.log.find((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_files")!;
    const files = ((prFiles.params.ops as Record<string, unknown>[])[0]!.files ?? {}) as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual(["oracle/T9/check.mjs", "tasks/T9/contract.json", "tasks/T9/task.json"]);
    const tj = JSON.parse(Buffer.from(files["tasks/T9/task.json"]!, "base64").toString());
    expect(tj.approval.contract_sha256).toBe(cc.sha256);
    expect(tj.checks).toEqual({ AC1: "oracle:oracle/T9/check.mjs" }); // should-criteria are not gated
    expect(tj.amendments.at(-1).files["oracle/T9/check.mjs"]).toBe(cc.oracleSha256);

    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    const done = await taskRow(db, id);
    expect(done.corrections).toBe(1);
    expect(done.headSha).toBe("h2");
    const gates = await db.select().from(gateResults).where(eq(gateResults.taskId, id)).orderBy(gateResults.id);
    expect(gates.map((g) => [g.headSha, g.verdict, g.kind])).toEqual([
      ["h1", "FAIL:ORACLE", "candidate_failure"],
      ["h2", "DONE", "pass"],
    ]);
    const correction = state.builderPrompts.find((p) => p.includes("VERDICT: FAIL:ORACLE"))!;
    expect(correction).toContain("T9:AC1");
    expect(correction).not.toContain("chromium"); // the oracle source is never given to the Builder
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id));
    expect(ev.filter((e) => e.subject === "T9:AC1").map((e) => [e.commitSha, e.status])).toEqual([
      ["h1", "not_verified"],
      ["h2", "verified"],
    ]);
    expect(ev.some((e) => e.subject === "independent-verifier" && e.status === "verified" && e.oracle === "agent_judgment")).toBe(true);
    const mut = ev.filter((e) => e.subject === "oracle-mutation:T9:AC1").map((e) => [e.commitSha, e.status]);
    expect(mut).toEqual([
      ["h2", "verified"],
      ["h2", "partially_verified"],
    ]);
    const mutAuthor = state.builderPrompts.find((p) => p.includes("mutation tester"))!;
    expect(mutAuthor).not.toContain("chromium"); // the mutant author never sees the oracle
    expect(ex.log.some((l) => l.op === "strip_oracles")).toBe(true);
    expect((await openDecisions(db, id)).map((d) => d.kind)).toEqual(["acceptance"]);

    state.ownerApprovedTask = true;
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "ACCEPTED");
    const acc = await taskRow(db, id);
    expect(acc.mergeCommit).toBe("mt");
    const path = (await db.select().from(transitions).where(eq(transitions.taskId, id)).orderBy(transitions.id)).map((t) => t.toState);
    expect(path).toEqual(["PROPOSED", "CONTRACTED", "IN_PROGRESS", "VERIFYING", "IN_PROGRESS", "VERIFYING", "DONE", "ACCEPTED"]);
    const allRuns = await db.select().from(runs).where(eq(runs.taskId, id));
    expect(allRuns.map((r) => `${r.role}:${r.purpose}`).sort()).toEqual(
      ["builder:build", "builder:correction", "builder:draft_contract", "builder:mutants", "verifier:acceptance_check", "verifier:attribution", "verifier:author_oracle"].sort(),
    );
    expect(allRuns.every((r) => r.status === "finished")).toBe(true);
  });

  it("surfaces an owner decision when the intent is ambiguous, and continues with the owner's answer", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario({ draftBlocked: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists somehow, whatever makes sense.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const [d] = await openDecisions(db, id);
    expect(d!.kind).toBe("block");
    expect(d!.title).toBe("Sort by title or by date?");
    expect(d!.options.map((o) => o.label)).toEqual(["By title", "By date", "Abandon the task"]);
    await decideBlock(db, { decisionId: d!.id, choice: "o1", note: "Alphabetical by list name." });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    expect((await taskRow(db, id)).state).toBe("PROPOSED");
    const prompts = ex.log.filter((l) => l.op === "builder").map((l) => String(l.params.prompt_text));
    expect(prompts[1]).toContain("Owner decision: By title");
    expect(prompts[1]).toContain("Alphabetical by list name.");
  });

  it("never applies an earlier decision to a later block (F-V0-1)", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario({ draftBlockedTwice: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists somehow.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const [d1] = await openDecisions(db, id);
    await decideBlock(db, { decisionId: d1!.id, choice: "o1", note: "" });
    // the revised draft blocks again: the task must wait for the NEW decision, not re-apply the first one
    await runUntil(db, ex, clk, async () => (await openDecisions(db, id)).some((d) => d.id !== d1!.id));
    await expect(runUntil(db, ex, clk, async () => (await taskRow(db, id)).state !== "BLOCKED_DECISION", 15)).rejects.toThrow("condition not reached");
    const t = await taskRow(db, id);
    expect(t.state).toBe("BLOCKED_DECISION");
    const [d2] = await openDecisions(db, id);
    expect(d2!.status).toBe("open");
    await decideBlock(db, { decisionId: d2!.id, choice: "o2", note: "" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    const prompts = ex.log.filter((l) => l.op === "builder").map((l) => String(l.params.prompt_text));
    expect(prompts[2]).toContain("Owner decision: By date");
  });

  it("smoke-runs a new oracle against main and sends a crashing check back to the Verifier before the owner sees it", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ smokeDefectOnce: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    expect(state.smokeRuns).toBe(2);
    expect(state.verifierPrompts.length).toBe(2);
    expect(state.verifierPrompts[1]).toContain("ReferenceError: text is not defined");
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id));
    expect(ev.filter((e) => e.subject === "oracle-validation:T9").map((e) => [e.status, e.source])).toEqual([["not_verified", "oracle-calibration against main"]]);
    expect(ev.filter((e) => e.subject === "oracle-calibration:T9").map((e) => e.status)).toEqual(["verified"]);
    const [c] = await contractRows(db, id);
    expect(c!.calibration?.failsOnMain).toEqual(["AC1"]);
  });

  it("rejects an oracle that imports a module the environment does not provide, before calibration or review", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ badImport: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    expect(state.oraclesAuthored).toBe(2);
    expect(state.smokeRuns).toBe(1); // the defective version never reached a preview
    expect(state.verifierPrompts[1]).toContain('imports "lodash"');
  });

  it("repairs a crashing oracle without the Builder: oracle-only amendment, Builder work kept, nothing charged", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ failFirstGate: true, oracleCrash: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    const [c] = await contractRows(db, id);
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    const t = await taskRow(db, id);
    expect(t.corrections).toBe(0);
    expect(t.headSha).toBe("h3"); // the SAME Builder work, brought up to date with the repaired oracle
    expect(state.updatedBranch).toBe(1);
    const builds = ex.log.filter((l) => l.op === "builder").map((l) => String(l.params.prompt_text));
    expect(builds.filter((p) => p.includes("VERDICT:")).length).toBe(0); // no correction was sent to the Builder
    const repairPr = [...state.contractPrs.values()][1]!;
    expect(repairPr.files).toEqual(["oracle/T9/check.mjs", "tasks/T9/task.json"]); // contract.json untouched
    const rows = await contractRows(db, id);
    const rev = rows.find((r) => r.kind === "oracle_revision")!;
    expect(rev.sha256).toBe(c!.sha256);
    expect(state.verifierPrompts.some((p) => p.includes("previous oracle") && p.includes("ReferenceError"))).toBe(true);
    const kinds = (await db.select().from(decisions).where(eq(decisions.taskId, id))).map((d) => d.kind);
    expect(kinds.filter((k) => k === "block")).toEqual([]); // the owner was not asked to decide anything
  });

  it("routes an arbiter-confirmed oracle defect to the Verifier, not the Builder", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ failFirstGate: true, arbiter: "oracle" });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    expect((await taskRow(db, id)).corrections).toBe(0);
    expect(state.updatedBranch).toBe(1);
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id));
    expect(ev.find((e) => e.subject === "attribution:T9:AC1")!.detail).toContain("ORACLE");
  });

  it("a repair that returns the defective check unchanged is refused, and the next attempt still sees the original defect (T9, live)", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ failFirstGate: true, arbiter: "oracle", repairUnchangedOnce: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    expect(state.oraclesAuthored).toBe(3); // the original, the unchanged "repair" (refused), the real repair
    const ev = await db.select().from(evidence).where(eq(evidence.taskId, id));
    expect(ev.some((e) => e.subject === "oracle-validation:T9" && /identical to the defective check it replaces/.test(e.detail ?? ""))).toBe(true);
    const last = state.verifierPrompts.filter((p) => p.includes("Your previous repair attempt")).at(-1)!;
    expect(last).toMatch(/observed in the app/); // the arbiter's finding is still in front of the Verifier
    expect(last).toMatch(/identical to the defective check/);
    expect((await taskRow(db, id)).corrections).toBe(0);
  });

  it("a check that keeps failing after three repairs goes to the owner instead of a further repair (T9, live: six rounds)", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ gateAlwaysFails: true, arbiter: "oracle" });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const [dec] = (await openDecisions(db, id)).filter((d) => d.kind === "block");
    expect(dec).toMatchObject({ title: "The check of T9 cannot be repaired automatically", recommendation: null });
    expect(dec!.why).toMatch(/repaired 3 times/);
    expect(state.oraclesAuthored).toBe(4); // the original and exactly three repairs
    expect((await taskRow(db, id)).corrections).toBe(0);
  });

  it("a quota pause of the arbiter repeats the arbiter with its inputs; nothing falls through without them (T9, live)", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario({ failFirstGate: true, arbiter: "oracle", arbiterQuotaOnce: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_quota");
    expect(((await taskRow(db, id)).stepData as { restartStep: string; restartData: { failure?: unknown } })).toMatchObject({ restartStep: "attribute_start", restartData: { failure: expect.anything() } });
    clk.advance(Math.ceil((((await taskRow(db, id)).stepData as { until: number }).until - clk.now().getTime()) / 1000) + 5);
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    expect((await taskRow(db, id)).corrections).toBe(0);
  });

  it("updates a stale regression check of an earlier task (owner approves on GitHub) instead of blaming the Builder", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ failFirstGate: true, regressFail: true, arbiter: "oracle" });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    expect((await taskRow(db, id)).corrections).toBe(0);
    expect(state.updatedBranch).toBe(1);
    const prs = [...state.contractPrs.values()];
    expect(prs[1]!.files).toEqual(["oracle/T2/check.mjs", "tasks/T2/task.json"]);
    const pf = ex.log.filter((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_files")[1]!;
    expect(String((pf.params.ops as { branch: string }[])[0]!.branch)).toMatch(/^amend\/T2\/regress-/);
    expect(state.verifierPrompts.some((p) => p.includes("EARLIER task T2"))).toBe(true);
    expect((await contractRows(db, id)).length).toBe(1); // this task's own contract and oracle were not touched
  });

  it("sends a critical/high finding of the independent Verifier back to the Builder automatically", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario({ verifierHigh: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "DONE");
    const t = await taskRow(db, id);
    expect(t.corrections).toBe(1);
    const prompts = ex.log.filter((l) => l.op === "builder").map((l) => String(l.params.prompt_text));
    expect(prompts.some((p) => p.includes("VERIFIER:DEFECT") && p.includes("Sort ignores case"))).toBe(true);
  });

  it("retries executor (harness) failures and then blocks on evidence without blaming the work", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario();
    h.pub = () => new Error("docker: connection refused");
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_EVIDENCE");
    const t = await taskRow(db, id);
    expect(t.corrections).toBe(0);
    const [d] = await db.select().from(decisions).where(and(eq(decisions.taskId, id), eq(decisions.status, "open")));
    expect(d!.why).toContain("infrastructure, not the work");
    // before anyone was asked, the control system repeated the step by itself twice (audited), with growing delays
    const auto = (await policyDecisions(db, id)).filter((x) => (x.context as { stage?: string }).stage === "recovery");
    expect(auto.map((x) => x.choice)).toEqual(["retry", "retry"]);
    expect(d!.title).toMatch(/automatic recovery did not succeed/);
    expect(ex.log.filter((l) => l.op === "pub").length).toBe(12); // (1 + 3 immediate retries) x 3 rounds
    // the owner retries once the infrastructure is back
    h.pub = () => ({ "ls:bakeoff-c1": { "refs/heads/main": "m0" } });
    await decideBlock(db, { decisionId: d!.id, choice: "retry", note: "" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
  });

  it("recovers from a temporary executor outage without the owner (no Retry button)", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario();
    const ok = h.pub!;
    let calls = 0;
    h.pub = (p, j) => (++calls <= 5 ? new Error("docker: connection refused") : ok(p, j));
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    const seen = new Set<string>();
    await runUntil(db, ex, clk, async () => {
      const t = await taskRow(db, id);
      seen.add(t.state);
      for (const d of await openDecisions(db, id)) seen.add(`asked:${d.kind}`);
      return await contractApproved(db, id);
    });
    expect([...seen]).toEqual(["PROPOSED"]); // never blocked, nobody asked
    expect((await policyDecisions(db, id)).filter((x) => (x.context as { stage?: string }).stage === "recovery").length).toBe(1);
    expect((await taskRow(db, id)).corrections).toBe(0);
  });

  it("asks the owner when the correction budget is exhausted", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario({ failFirstGate: true });
    const origEvidence = h.gate_evidence!;
    h.gate_evidence = (p, j) => {
      const r = origEvidence(p, j) as Record<string, unknown>;
      return { ...r, verdict: "FAIL:CHECK", evidence: { ...(r.evidence as object), verdict: "FAIL:CHECK", checks: { check_stage: "vitest: 1 failed" } } };
    };
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const t = await taskRow(db, id);
    expect(t.corrections).toBe(2); // project budget
    const [d] = await openDecisions(db, id);
    expect(d!.kind).toBe("budget");
    void state;
  });
});
