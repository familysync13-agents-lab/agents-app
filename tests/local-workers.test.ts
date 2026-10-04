import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activity, artifacts, executorJobs, plans, qualificationBatches, qualificationRecords, runs } from "@/db/schema";
import { PlanBody } from "@/domain/plan";
import { ALL_TASK_CLASSES, EMBEDDING_ONLY_MODELS, qualification, route, ROUTES, TASK_CLASSES, WORKERS, type QualRecord } from "@/domain/router";
import { isSmallCode, repairScope, SEMANTIC, semanticGate, ungrounded } from "@/domain/semantic";
import { createTask } from "@/server/owner";
import { collectCandidates, loadCaseSet, qualifyRun, qualifyStatus, routeTableAll, submitSemantic, type CodeCase, type SemanticCase } from "@/worker/qualify";
import { routeTable } from "@/worker/shadow";
import { clock, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";

/* Local-worker extension: two local models behind the existing Router, qualified per task class from recorded evidence. */

const CODER = "qwen3-coder:30b";
const GENERAL = "qwen3:14b";
const recs = (worker: string, taskClass: string, n: number, agreeing: number, extra: Partial<QualRecord> = {}): QualRecord[] => Array.from({ length: n }, (_, i) => ({ worker, taskClass, valid: true, agree: i < agreeing, ...extra }));
const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
  const { db, project } = await setup();
  const clk = clock();
  const { state, h } = scenario(opts);
  const ex = new FakeExecutor(db, h);
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, clk, state, ex, id };
};
const settle = async (db: Awaited<ReturnType<typeof setup>>["db"], ex: FakeExecutor, clk: ReturnType<typeof clock>, n = 14) => {
  for (let i = 0; i < n; i++) { await ex.drain(); await collectCandidates(db, clk.now); clk.advance(25); }
};
const qualify = (db: Awaited<ReturnType<typeof setup>>["db"], worker: string, taskClass: string, model: string) =>
  db.insert(qualificationRecords).values(Array.from({ length: 20 }, (_, i) => ({ worker, taskClass, mode: "harness" as const, inputSha256: `x${i}`, valid: true, agree: true, gate: true, model })));

describe("LW1 Router: two local workers, per-class qualification, Claude Code as the fallback", () => {
  it("defines the two local models as workers with bounded envelopes and never an embedding model", () => {
    expect(WORKERS["local-llm"]).toMatchObject({ model: GENERAL, provider: "ollama-host", meteredCost: false, envelope: { filesystem: "none", repository: "none", credentials: "none" } });
    expect(WORKERS["local-coder"]).toMatchObject({ model: CODER, provider: "ollama-host", meteredCost: false, envelope: { credentials: "none", tools: expect.stringMatching(/one bounded structured request/) } });
    expect(Object.values(WORKERS).some((w) => EMBEDDING_ONLY_MODELS.some((m) => w.model.includes(m)))).toBe(false);
    for (const c of ["summarization", "structured_extraction", "log_summary"] as const) expect(ROUTES[c]).toEqual({ trusted: "claude-code", alternatives: ["local-llm"] });
    expect(ROUTES.classification).toEqual({ trusted: "claude-code", alternatives: ["local-qwen38", "local-llm"] });
    for (const c of ["small_code", "bounded_repair"] as const) expect(ROUTES[c]).toEqual({ trusted: "claude-code", alternatives: ["local-coder"] });
    // complex, architecture- or security-sensitive work has no local alternative at all
    for (const c of ["contract_draft", "plan", "mutants", "check_author", "acceptance_check", "attribution"] as const) expect(ROUTES[c].alternatives).toEqual([]);
    expect(ROUTES.build.alternatives.every((w) => !WORKERS[w]!.enabled)).toBe(true);
    expect(TASK_CLASSES.length).toBe(10); // the primary table is unchanged (the System page lists exactly these)
    expect(ALL_TASK_CLASSES.length).toBe(15);
  });
  it("NO QUALIFIED LOCAL PATH = CLAUDE; qualification is per class, per model, and never from voided or production records", () => {
    for (const c of ["small_code", "bounded_repair", "summarization"] as const) expect(route({ taskClass: c, risk: "standard", records: [] }).worker).toBe("claude-code");
    const q = recs("local-coder", "small_code", 20, 20, { model: CODER });
    expect(route({ taskClass: "small_code", risk: "standard", records: q })).toMatchObject({ worker: "local-coder", model: CODER });
    expect(route({ taskClass: "bounded_repair", risk: "standard", records: q }).worker).toBe("claude-code"); // another class: not qualified
    expect(route({ taskClass: "small_code", risk: "critical", records: q }).worker).toBe("claude-code"); // critical tier: trusted worker
    expect(route({ taskClass: "build", risk: "standard", records: recs("local-coder", "build", 50, 50, { model: CODER }) }).worker).toBe("claude-code"); // not an alternative for build
    expect(qualification(recs("local-coder", "small_code", 20, 20, { model: "some-other-model:7b" }), "local-coder", "small_code").status).toBe("unqualified");
    expect(qualification(recs("local-coder", "small_code", 20, 20, { model: CODER, voided: true }), "local-coder", "small_code").status).toBe("unqualified");
    expect(qualification(recs("local-coder", "small_code", 20, 20, { model: CODER, mode: "production" }), "local-coder", "small_code").status).toBe("unqualified");
    expect(qualification(recs("local-coder", "small_code", 20, 18, { model: CODER }), "local-coder", "small_code").status).toBe("shadow"); // 90% is not enough
    expect(qualification(recs("local-coder", "small_code", 20, 15, { model: CODER }), "local-coder", "small_code").status).toBe("rejected");
  });
});

describe("LW2 deterministic gates of the semantic classes", () => {
  it("failure triage: vocabulary and a verbatim quote (modulo JSON escaping); agreement with the reference", () => {
    const input = 'merge failed: {"status":405,"message":"Repository rule violations found\\n\\nRequired status check \\"gate\\" is expected."}';
    expect(semanticGate("failure_triage", input, { class: "infrastructure", evidence: 'Required status check "gate" is expected.' }, { class: "infrastructure" })).toMatchObject({ pass: true });
    expect(semanticGate("failure_triage", input, { class: "quota", evidence: "Repository rule violations found" }, { class: "infrastructure" })).toMatchObject({ pass: false, valid: true });
    expect(semanticGate("failure_triage", input, { class: "infrastructure", evidence: "the merge queue was full" }, { class: "infrastructure" })).toMatchObject({ pass: false, valid: false });
    expect(semanticGate("failure_triage", input, { class: "weather", evidence: "405" }).valid).toBe(false);
    expect(semanticGate("failure_triage", input, null).valid).toBe(false);
  });
  it("summaries are grounded: an identifier that is not in the input fails the gate", () => {
    const input = "Task T6\n- Gate verdict for 380e37ef: DONE\n- VERIFYING → DONE: All must-criteria verified by the gate for 380e37ef";
    expect(ungrounded(input, "T6 passed the gate at 380e37ef")).toEqual([]);
    expect(ungrounded(input, "T7 passed with PR #99 after 4000 ms")).toEqual(["T7", "#99", "4000"]);
    const ok = { final_state: "DONE", summary: "The gate verified all must-criteria of T6 for head 380e37ef and the task moved from VERIFYING to DONE.", incidents: [] };
    expect(semanticGate("summarization", input, ok, { final_state: "DONE", must_mention: [], clean: true }).pass).toBe(true);
    expect(semanticGate("summarization", input, { ...ok, summary: `${ok.summary} PR #24 was merged.` }, null)).toMatchObject({ valid: false });
    expect(semanticGate("summarization", input, { ...ok, final_state: "ACCEPTED" }, { final_state: "DONE", must_mention: [] })).toMatchObject({ valid: true, pass: false });
    expect(semanticGate("summarization", input, { ...ok, incidents: ["a block"] }, { final_state: "DONE", must_mention: [], clean: true }).pass).toBe(false);
  });
  it("extraction and classification compare every field with the reference", () => {
    const f = "T4:AC1 · regression · locator.waitFor: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByRole('heading', { name: 'Project Capabilities', exact: true })";
    const ref = { task: "T4", criterion: "AC1", error_kind: "timeout", timeout_ms: 15000, target_role: "heading", target_name: "Project Capabilities" };
    expect(semanticGate("structured_extraction", f, ref, ref).pass).toBe(true);
    expect(semanticGate("structured_extraction", f, { ...ref, timeout_ms: 1500 }, ref).valid).toBe(false); // not stated in the input
    expect(semanticGate("structured_extraction", f, { ...ref, target_name: null, target_role: null }, ref)).toMatchObject({ valid: true, pass: false });
    expect(semanticGate("classification", "x", { tags: ["authz"] }, { tags: ["authz"] }).pass).toBe(true);
    expect(semanticGate("classification", "x", { tags: [] }, { tags: ["authz"] }).pass).toBe(false);
    expect(semanticGate("classification", "x", { tags: ["secret"] }).valid).toBe(false);
  });
});

describe("LW3 deterministic classification of coding work", () => {
  const criteria = [{ id: "AC1", tags: [] }, { id: "AC2", tags: ["authz"] }];
  const t = (o: object) => ({ scope_paths: ["src/lib/sort.ts", "tests/sort.test.ts"], covers: ["AC1"], contributes: [], requires: [], ...o });
  it("SMALL_CODE is a plan task confined to at most three named source files, standard tier, nothing sensitive", () => {
    expect(isSmallCode({ tier: "standard", task: t({}), criteria }).small).toBe(true);
    expect(isSmallCode({ tier: "standard", task: null, criteria }).small).toBe(false); // an atomic contract has no declared file scope
    expect(isSmallCode({ tier: "critical", task: t({}), criteria }).small).toBe(false);
    expect(isSmallCode({ tier: "standard", task: t({ scope_paths: [] }), criteria }).small).toBe(false);
    expect(isSmallCode({ tier: "standard", task: t({ scope_paths: ["src/**"] }), criteria }).small).toBe(false);
    expect(isSmallCode({ tier: "standard", task: t({ scope_paths: ["a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] }), criteria }).small).toBe(false);
    expect(isSmallCode({ tier: "standard", task: t({ scope_paths: ["src/db/schema.ts"] }), criteria }).small).toBe(false);
    expect(isSmallCode({ tier: "standard", task: t({ scope_paths: ["gate/gate.py"] }), criteria }).small).toBe(false);
    expect(isSmallCode({ tier: "standard", task: t({ covers: ["AC2"] }), criteria })).toMatchObject({ small: false, why: expect.stringMatching(/authz/) });
  });
  it("a bounded repair is scoped to the source files the failed check names", () => {
    expect(repairScope("src/components/worker-runs.tsx(41,17): error TS2322: x\n FAIL  tests/sort.test.ts > sorts\n at src/components/worker-runs.tsx:41")).toEqual(["src/components/worker-runs.tsx", "tests/sort.test.ts"]);
    expect(repairScope("the preview did not start")).toEqual([]);
  });
});

describe("LW4 the pinned case sets", () => {
  it("every class has 20 cases with unique ids; code cases stay inside the allowed source tree and are pinned to a commit", () => {
    const files = readdirSync("src/qualification/cases").filter((f) => f.endsWith(".json")).sort();
    const research = ["contradiction_detection.json", "evidence_extraction.json", "evidence_summary.json", "opportunity_analysis.json", "opportunity_card.json", "query_planning.json", "research_planning.json", "source_assessment.json", "finding_association.json"]; // evaluation packs (research; Evidence roles) have their own set shapes
    expect(files.filter((f) => !research.includes(f))).toEqual(["bounded_repair.json", "classification.json", "failure_triage.json", "log_summary.json", "small_code.json", "structured_extraction.json", "summarization.json"]);
    for (const f of files.filter((x) => !research.includes(x))) {
      const set = JSON.parse(readFileSync(`src/qualification/cases/${f}`, "utf8")) as { class: string; base?: string; cases: (SemanticCase & CodeCase)[] };
      expect(set.cases.length).toBe(20);
      expect(new Set(set.cases.map((c) => c.id)).size).toBe(20);
      if (set.class === "small_code" || set.class === "bounded_repair") {
        expect(set.base).toMatch(/^[0-9a-f]{40}$/);
        for (const c of set.cases) {
          expect(c.scope.length).toBeGreaterThan(0);
          expect(c.scope.length).toBeLessThanOrEqual(3);
          expect([...c.scope, ...(c.context ?? [])].every((p) => /^(src|tests)\//.test(p))).toBe(true);
        }
      } else {
        const cls = set.class as keyof typeof SEMANTIC;
        for (const c of set.cases) expect(c.input.length).toBeLessThanOrEqual(SEMANTIC[cls].maxInput);
      }
    }
  });
});

describe("LW5 qualification harness", () => {
  it("semantic class without free text: each pinned case is one bounded, schema-bound request to the named model; the gate decides", async () => {
    const set = loadCaseSet<SemanticCase>("failure_triage");
    const { db, ex, clk } = await start({ localLlm: (p) => {
      const c = set.cases.find((k) => p.prompt === k.input)!;
      const wrong = c.id === "ft-03";
      return { ok: true, available: true, model: GENERAL, digest: "bdbd181c33f2", ms: 800, usage: { prompt_tokens: 300, output_tokens: 30 }, output: { class: wrong ? "quota" : c.expect.class, evidence: c.input.slice(0, 30) } };
    } });
    expect(await qualifyRun(db, "failure_triage")).toMatchObject({ submitted: 20, skipped: 0, worker: "local-llm", model: GENERAL });
    expect(await qualifyRun(db, "failure_triage")).toMatchObject({ submitted: 0, skipped: 20 }); // pinned cases are never counted twice
    await settle(db, ex, clk, 3);
    const sent = ex.log.find((l) => l.op === "local_llm")!.params;
    expect(Object.keys(sent).sort()).toEqual(["max_tokens", "model", "prompt", "schema", "system"]); // no tools, no files, no repository
    expect(sent.model).toBe(GENERAL);
    const rs = await db.select().from(qualificationRecords);
    expect(rs.filter((r) => r.agree === true).length).toBe(19);
    expect(rs.find((r) => r.caseId === "ft-03")).toMatchObject({ gate: false, agree: false, valid: true, verifier: null });
    expect(rs[0]).toMatchObject({ mode: "harness", model: GENERAL, modelDigest: "bdbd181c33f2", caseSetSha256: set.sha, verifier: "not_applicable", promptTokens: 300, durationMs: 800 });
    const st = (await qualifyStatus(db)).find((s) => s.taskClass === "failure_triage")!;
    expect(st).toMatchObject({ status: "qualified", samples: 20, agreement: 0.95, gatePass: 19, gateFail: 1, routedTo: "local-llm" });
    expect(ex.log.some((l) => l.op === "verifier")).toBe(false);
  });
  it("free-text class: gate-passing outputs go to the independent Verifier in one batch; agreement needs both", async () => {
    const set = loadCaseSet<SemanticCase>("summarization");
    const { db, ex, clk, state } = await start({
      localLlm: (p) => {
        const c = set.cases.find((k) => p.prompt === k.input)!;
        const words = (c.expect.must_mention as string[][]).map((g) => g[0]).join(" ");
        return { ok: true, available: true, model: GENERAL, ms: 3000, output: { final_state: c.id === "su-02" ? "REJECTED" : c.expect.final_state, summary: `The recorded events of this task were processed in order and the task reached its final state as recorded. ${words}`, incidents: c.expect.clean ? [] : ["one recorded problem"] } };
      },
      verdicts: (items) => items.map((x, i) => ({ id: x.id, pass: i !== 0, reason: i === 0 ? "states a cause the input does not contain" : "faithful" })),
    });
    await qualifyRun(db, "summarization");
    await settle(db, ex, clk, 16);
    const rs = await db.select().from(qualificationRecords).orderBy(qualificationRecords.id);
    expect(rs.find((r) => r.caseId === "su-02")).toMatchObject({ gate: false, agree: false, verifier: null }); // failed the gate: never shown to the Verifier
    expect(rs.filter((r) => r.verifier === "pass").length).toBe(18);
    expect(rs.filter((r) => r.verifier === "fail")).toMatchObject([{ agree: false, verifierNote: "states a cause the input does not contain" }]);
    expect(ex.log.filter((l) => l.op === "verifier").length).toBe(1); // one session for the batch, not one per sample
    expect(state.verifierPrompts.at(-1)).toMatch(/FAITHFUL to the input/);
    const [b] = await db.select().from(qualificationBatches);
    expect(b).toMatchObject({ state: "done", taskClass: "summarization" });
    expect((await qualifyStatus(db)).find((s) => s.taskClass === "summarization")).toMatchObject({ status: "shadow", samples: 20, agreement: 0.9, routedTo: "claude-code" });
  });
  it("code class: a pinned commit, the model named, in-scope files only, the project's checks as the gate, then the Verifier; a harness failure is no verdict", async () => {
    const set = loadCaseSet<CodeCase>("bounded_repair");
    const { db, ex, clk, state } = await start({ localCode: (p) => {
      const n = set.cases.findIndex((k) => k.scope[0] === (p.scope as string[])[0] && k.setup![0]!.find === (p.setup as { find: string }[])[0]!.find);
      if (n === 0) return { ok: false, stage: "install", reason: "npm error ENOSPC" };
      const pass = n !== 1;
      return { ok: true, model: CODER, digest: "06c1097efce0", ms: 20000, prompt_chars: 9000, usage: { prompt_tokens: 2500, output_tokens: 2000 }, diff: "diff --git a/x b/x", diffstat: "1 file changed", gate: { pass, stage: "checks", checks: [{ name: "tests", rc: pass ? 0 : 1, ms: 4000, tail: pass ? "" : "1 failed" }] } };
    } });
    expect(await qualifyRun(db, "bounded_repair")).toMatchObject({ submitted: 20, worker: "local-coder", model: CODER });
    await settle(db, ex, clk, 30);
    expect(ex.log[0]).toMatchObject({ op: "worktree", params: { vol: "agents-qf-1", ref: set.base } }); // commit-pinned
    expect(state.localCode[0]).toMatchObject({ vol: "agents-qf-1", model: CODER, reset: true, checks: { typecheck: true, lint: true } });
    const rs = await db.select().from(qualificationRecords).orderBy(qualificationRecords.id);
    expect(rs[0]).toMatchObject({ valid: false, agree: null, gate: null, note: expect.stringMatching(/candidate unavailable/) });
    expect(rs[1]).toMatchObject({ gate: false, agree: false, verifier: null });
    expect(rs.slice(2).every((r) => r.gate === true && r.verifier === "pass" && r.agree === true)).toBe(true);
    expect(ex.log.filter((l) => l.op === "verifier").length).toBe(3); // 18 gate-passing diffs in batches of 7
    expect(state.verifierPrompts.at(-1)).toMatch(/independent code reviewer/);
    expect((await qualifyStatus(db)).find((s) => s.taskClass === "bounded_repair")).toMatchObject({ status: "shadow", samples: 19, unavailable: 1, routedTo: "claude-code" });
  });
});

describe("LW6 bounded semantic jobs in production", () => {
  it("nothing is started while the class is unqualified; a qualified job is gated, recorded in the ledger and attached to the task", async () => {
    const { db, ex, clk, id } = await start({ localLlm: () => ({ ok: true, available: true, model: GENERAL, ms: 2500, usage: { prompt_tokens: 400, output_tokens: 90 }, output: { final_state: "PROPOSED", summary: "The task was recorded and the contract drafter was started for it; nothing has gone wrong so far in this timeline.", incidents: [] } }) });
    const input = "Task T9\n- Contract drafter started (Builder slot, isolated container, no GitHub access).";
    expect(await submitSemantic(db, { taskId: id, cls: "summarization", input })).toMatchObject({ routed: false, worker: "claude-code" });
    expect(await db.select().from(executorJobs)).toEqual([]);
    await qualify(db, "local-llm", "summarization", GENERAL);
    expect(await submitSemantic(db, { taskId: id, cls: "summarization", input })).toMatchObject({ routed: true, worker: "local-llm" });
    await settle(db, ex, clk, 3);
    const [run] = await db.select().from(runs).where(eq(runs.taskId, id));
    expect(run).toMatchObject({ purpose: "semantic", taskClass: "summarization", worker: "local-llm", model: GENERAL, provider: "ollama-host", status: "finished", outcome: "output", durationMs: 2500, contextBytes: input.length, routeReason: expect.stringMatching(/qualified for summarization: 20 samples/) });
    const [art] = await db.select().from(artifacts).where(eq(artifacts.taskId, id));
    expect(art).toMatchObject({ kind: "local-semantic", workerAuthored: true });
    const prod = (await db.select().from(qualificationRecords)).find((r) => r.mode === "production")!;
    expect(prod).toMatchObject({ gate: true, agree: null, taskId: id }); // production output is checked, but is not qualification evidence
    expect((await qualifyStatus(db)).find((s) => s.taskClass === "summarization")).toMatchObject({ samples: 20, production: 1 });
  });
  it("a production output that fails its gate is discarded and nothing is retried locally", async () => {
    const { db, ex, clk, id } = await start({ localLlm: () => ({ ok: true, available: true, model: GENERAL, ms: 900, output: { final_state: "DONE", summary: "PR #77 was merged after the gate passed at 0123abcd and the owner accepted it.", incidents: [] } }) });
    await qualify(db, "local-llm", "summarization", GENERAL);
    await submitSemantic(db, { taskId: id, cls: "summarization", input: "Task T9\n- Contract drafter started." });
    await settle(db, ex, clk, 3);
    expect(await db.select().from(artifacts).where(eq(artifacts.taskId, id))).toEqual([]);
    expect((await db.select().from(runs).where(eq(runs.taskId, id)))[0]).toMatchObject({ outcome: "aborted" });
    expect((await db.select().from(activity).where(eq(activity.taskId, id))).at(-1)!.message).toMatch(/discarded - the output failed its gate/);
    expect(ex.log.filter((l) => l.op === "local_llm").length).toBe(1);
  });
});

const A = { id: "T9.a", purpose: "sorting", covers: ["AC1", "AC2"], scope_paths: ["src/lib/sort.ts", "tests/sort.test.ts"] };
const B = { id: "T9.b", purpose: "filtering", covers: ["AC3"] };
const passing = () => ({ ok: true, model: CODER, ms: 21000, prompt_chars: 7000, notes: "Added sortLists.", diffstat: "2 files changed", changed: A.scope_paths, gate: { pass: true, stage: "checks", checks: [{ name: "typecheck", rc: 0, ms: 1 }, { name: "tests", rc: 0, ms: 1 }] } });

describe("LW7 the local coder in production", () => {
  it("unqualified: Claude Code builds the small task and the local coder is only shadowed (recorded, verified, controls nothing)", async () => {
    const { db, clk, ex, id, state } = await start({ complex: { plans: [{ tasks: [A, B] }] }, localCode: passing });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance", 900);
    await settle(db, ex, clk, 14);
    const rs = await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(runs.id);
    expect(rs.filter((r) => r.purpose === "build").map((r) => [r.worker, r.planTask])).toEqual([["claude-code", "T9.a"], ["claude-code", "T9.b"]]);
    expect(state.localCode.length).toBe(1); // only the small task (T9.a) was shadowed; T9.b has no declared file scope
    expect(state.localCode[0]).toMatchObject({ vol: expect.stringMatching(/^agents-qf-1\d{5}$/), model: CODER, scope: A.scope_paths });
    expect(String(state.localCode[0]!.instruction)).toMatch(/Step T9\.a[\s\S]*AC1: given alice with lists B, A/);
    const [q] = await db.select().from(qualificationRecords);
    expect(q).toMatchObject({ worker: "local-coder", taskClass: "small_code", mode: "shadow", gate: true, verifier: "pass", agree: true, taskId: id });
    expect(ex.log.some((l) => l.op === "vol_rm" && (l.params.names as string[])[0]!.startsWith("agents-qf-"))).toBe(true);
  }, 120000);
  it("qualified: the small plan task is built by the local coder in one bounded request and continues on the normal path (PR, gate, Verifier)", async () => {
    const { db, clk, ex, id, state } = await start({ complex: { plans: [{ tasks: [A, B] }] }, localCode: passing });
    await qualify(db, "local-coder", "small_code", CODER);
    const seen: string[] = [];
    await runUntil(db, ex, clk, async () => {
      for (const d of await openDecisions(db, id)) if (!seen.includes(d.kind)) seen.push(d.kind);
      return (await taskRow(db, id)).step === "await_acceptance";
    }, 900);
    expect(seen).toEqual(["acceptance"]);
    const rs = (await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(runs.id)).filter((r) => r.purpose === "build");
    expect(rs.map((r) => [r.worker, r.model, r.taskClass, r.planTask, r.outcome])).toEqual([["local-coder", CODER, "small_code", "T9.a", "report"], ["claude-code", "opus", "build", "T9.b", "report"]]);
    expect(rs[0]).toMatchObject({ provider: "ollama-host", routeReason: expect.stringMatching(/qualified for small_code: 20 samples, 100% agreement/), contextBytes: 7000, durationMs: 21000 });
    expect(state.localCode[0]).toMatchObject({ vol: `agents-wt-${id}`, model: CODER, scope: A.scope_paths, checks: { typecheck: true, lint: true, tests: "all" } });
    expect(state.localCode[0]!.setup).toBeUndefined(); // harness-only inputs never reach a production worktree
    expect(state.buildSessions).toBe(1); // Claude Code built only the task that is not small
    const plan = PlanBody.parse((await db.select().from(plans).where(eq(plans.taskId, id)).orderBy(plans.planVersion)).at(-1)!.body);
    expect(plan.tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect((await db.select().from(qualificationRecords)).filter((r) => r.mode === "shadow")).toEqual([]); // qualified: no shadow
  }, 120000);
  it("one local attempt only: a local result that fails the project's checks goes straight to Claude Code", async () => {
    const { db, clk, ex, id, state } = await start({ complex: { plans: [{ tasks: [A, B] }] }, localCode: () => ({ ...passing(), gate: { pass: false, stage: "checks", checks: [{ name: "tests", rc: 1, ms: 1, tail: "1 failed" }] } }) });
    await qualify(db, "local-coder", "small_code", CODER);
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance", 900);
    const rs = (await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(runs.id)).filter((r) => r.purpose === "build");
    expect(rs.map((r) => [r.worker, r.planTask, r.outcome])).toEqual([["local-coder", "T9.a", "aborted"], ["claude-code", "T9.a", "report"], ["claude-code", "T9.b", "report"]]);
    expect(state.localCode.length).toBe(1);
    expect(await openDecisions(db, id)).toMatchObject([{ kind: "acceptance" }]); // nobody was asked about the local failure
    expect((await db.select().from(activity).where(eq(activity.taskId, id))).some((a) => /No second local attempt: Claude Code builds this step/.test(a.message))).toBe(true);
  }, 120000);
  it("a production gate failure after a local build is corrected by Claude Code with its full instructions", async () => {
    const { db, clk, ex, id, state } = await start({ complex: { plans: [{ tasks: [A, B] }], failFirstHeadOf: "a" }, localCode: passing });
    await qualify(db, "local-coder", "small_code", CODER);
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance", 900);
    const rs = await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(runs.id);
    expect(rs.filter((r) => ["build", "correction"].includes(r.purpose)).map((r) => [r.purpose, r.worker, r.planTask ?? null])).toEqual([["build", "local-coder", "T9.a"], ["correction", "claude-code", null], ["build", "claude-code", "T9.b"]]);
    expect(state.localCode.length).toBe(1);
    expect(state.builderPrompts.find((p) => p.includes("AN EARLIER ATTEMPT IS ALREADY IN THIS WORKSPACE"))).toMatch(/You are the Builder[\s\S]*VERDICT: FAIL/);
  }, 120000);
});

describe("LW8 the System page's routing table is unchanged; the full table is available to the operator", () => {
  it("lists the ten primary classes on the page and all fifteen, with models, for the operator", async () => {
    const { db } = await setup();
    expect((await routeTable(db)).map((r) => r.taskClass)).toEqual([...TASK_CLASSES]);
    const all = await routeTableAll(db);
    expect(all.length).toBe(15);
    expect(all.find((r) => r.taskClass === "small_code")).toMatchObject({ worker: "claude-code", alternatives: [{ worker: "local-coder", model: CODER, status: "unqualified", samples: 0 }] });
  });
});
