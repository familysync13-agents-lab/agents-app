import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualificationRecords } from "@/db/schema";
import { ALL_TASK_CLASSES, CANDIDATES, modelOf, qualification, route, ROUTES, WORKERS, type QualRecord } from "@/domain/router";
import { numbersIn, RESEARCH, RESEARCH_CLASSES, ungroundedNumbers } from "@/domain/research";
import { collectCandidates, finalStatus, loadCaseSet, PATCH_CLASSES, qualifyRun, qualifyStatus, routeTableAll, type CodeCase, type SemanticCase } from "@/worker/qualify";
import { createTask } from "@/server/owner";
import { clock, FakeExecutor, setup } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";

/* Evaluation candidates (qwen3.8:27b, devstral-small-2:24b), the research pack and the edit-based coding path: evidence only, never routing. */

const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
  const { db, project } = await setup();
  const clk = clock();
  const { state, h } = scenario(opts);
  const ex = new FakeExecutor(db, h);
  await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, clk, state, ex };
};
const settle = async (db: Awaited<ReturnType<typeof setup>>["db"], ex: FakeExecutor, clk: ReturnType<typeof clock>, n = 14) => {
  for (let i = 0; i < n; i++) { await ex.drain(); await collectCandidates(db, clk.now); clk.advance(25); }
};
const refs = JSON.parse(readFileSync("tests/fixtures/research-references.json", "utf8")) as Record<string, Record<string, Record<string, unknown>>>;

describe("EC1 candidates are evidence-only: no route can select them", () => {
  it("names the two models, and keeps them out of every route", () => {
    expect(CANDIDATES["cand-qwen38"]!.model).toBe("qwen3.8:27b");
    expect(CANDIDATES["cand-devstral"]!.model).toBe("devstral-small-2:24b");
    expect(modelOf("cand-devstral")).toBe("devstral-small-2:24b");
    for (const c of ALL_TASK_CLASSES) expect([ROUTES[c].trusted, ...ROUTES[c].alternatives].some((w) => w in CANDIDATES)).toBe(false);
    expect(Object.keys(CANDIDATES).some((c) => c in WORKERS)).toBe(false);
  });
  it("a perfect candidate record changes no routing decision; existing routing is unchanged", () => {
    const perfect: QualRecord[] = ALL_TASK_CLASSES.flatMap((c) => Array.from({ length: 40 }, () => ({ worker: c === "small_code" || c === "bounded_repair" ? "cand-devstral" : "cand-qwen38", taskClass: c, valid: true, agree: true, model: c === "small_code" || c === "bounded_repair" ? "devstral-small-2:24b" : "qwen3.8:27b" })));
    for (const c of ALL_TASK_CLASSES) expect(route({ taskClass: c, risk: "standard", records: perfect }).worker).toBe(ROUTES[c].trusted);
    expect(qualification(perfect, "cand-qwen38", "summarization").status).toBe("qualified"); // the evidence itself is still read correctly
    const cls14: QualRecord[] = Array.from({ length: 20 }, (_, i) => ({ worker: "local-llm", taskClass: "classification", valid: true, agree: i < 19, model: "qwen3:14b" }));
    expect(route({ taskClass: "classification", risk: "standard", records: [...perfect, ...cls14] }).worker).toBe("local-llm");
  });
});

describe("EC2 final status: gate and Verifier are separate, the threshold is 95%", () => {
  const f = (o: Partial<Parameters<typeof finalStatus>[0]>) => finalStatus({ enabled: true, cls: "summarization", samples: 20, gatePass: 20, verifierPending: 0, agree: 20, ...o });
  it("maps recorded evidence to exactly one status", () => {
    expect(f({})).toBe("QUALIFIED_CANDIDATE");
    expect(f({ agree: 19, gatePass: 19 })).toBe("QUALIFIED_CANDIDATE"); // 95%
    expect(f({ gatePass: 18, agree: 18 })).toBe("FAILED_GATE"); // 90% at the gate
    expect(f({ gatePass: 20, agree: 18 })).toBe("REJECTED_BY_VERIFIER"); // passed the gate, the Verifier rejected two
    expect(f({ gatePass: 20, agree: 12, verifierPending: 8 })).toBe("PENDING_VERIFICATION");
    expect(f({ gatePass: 17, agree: 10, verifierPending: 7 })).toBe("FAILED_GATE"); // cannot recover, whatever is pending
    expect(f({ samples: 12, gatePass: 12, agree: 12 })).toBe("PENDING_VERIFICATION"); // fewer than 20 samples never qualify
    expect(f({ samples: 0, gatePass: 0, agree: 0 })).toBe("NOT_RUN");
    expect(f({ enabled: false })).toBe("DISABLED");
    expect(f({ cls: "patch_repair" })).toBe("PATCH_BASED_LOCAL_CODING");
    expect(f({ cls: "patch_small_code", gatePass: 20, agree: 18 })).toBe("REJECTED_BY_VERIFIER");
  });
});

describe("EC3 research pack: 8 classes x 20 pinned cases, deterministic gates, every passing output goes to the Verifier", () => {
  it("every pinned case is satisfiable: its reference output passes the gate", () => {
    for (const c of RESEARCH_CLASSES) {
      const set = loadCaseSet<SemanticCase>(c);
      expect(set.cases.length).toBe(20);
      expect(RESEARCH[c].verifier).toBe(true);
      for (const k of set.cases) {
        const o = refs[c]![k.id]!;
        expect([c, k.id, RESEARCH[c].structural(k.input, o)]).toEqual([c, k.id, []]);
        expect([c, k.id, RESEARCH[c].agree(o, k.expect)]).toEqual([c, k.id, []]);
      }
    }
  });
  it("invented figures, guessed values, dropped qualifiers and forced resolutions fail the gate", () => {
    expect(numbersIn("S3 says 18,400 searches at $4.50 in 2 of 5 cases")).toEqual(["18400", "4.5"]);
    expect(ungroundedNumbers("Prices range from $4.50 to $14.00.", "between 4.5 and 14 dollars, about 9,000 sales")).toEqual(["9000"]);
    const card = loadCaseSet<SemanticCase>("opportunity_card").cases[0]!;
    const good = refs.opportunity_card![card.id]!;
    expect(RESEARCH.opportunity_card.agree({ ...good, monthly_sales_estimate: 120 }, card.expect)[0]).toMatch(/\[hallucination\] monthly_sales_estimate 120/);
    expect(RESEARCH.opportunity_card.structural(card.input, { ...good, monthly_sales_estimate: 120 })[0]).toMatch(/\[hallucination\] number not in the file: 120/);
    expect(RESEARCH.opportunity_card.structural(card.input, { ...good, extra: 1 })[0]).toMatch(/\[schema\]/);
    const ex = loadCaseSet<SemanticCase>("evidence_extraction").cases[0]!;
    const facts = (refs.evidence_extraction![ex.id]!.facts as Record<string, unknown>[]).map((f) => ({ ...f, qualifier: null, claim: String(f.claim).replace("An estimated ", ""), quote: String(f.quote).replace("An estimated ", "") }));
    expect(RESEARCH.evidence_extraction.agree({ facts }, ex.expect).join(" ")).toMatch(/\[omission\] qualifier "estimated" dropped/);
    expect(RESEARCH.evidence_extraction.structural(ex.input, { facts: [{ claim: "Demand grew by 43%.", quote: "Demand grew by 43%.", value: "43%", date: null, qualifier: null }] }).join(" ")).toMatch(/\[hallucination\]/);
    const cd = loadCaseSet<SemanticCase>("contradiction_detection").cases.find((k) => (k.expect.pairs as unknown[]).length === 1 && k.expect.resolvable === false)!;
    const cref = refs.contradiction_detection![cd.id]!;
    expect(RESEARCH.contradiction_detection.agree({ ...cref, resolvable: true, resolution: "The first source is right." }, cd.expect)[0]).toMatch(/\[reference\] resolvable true/);
    expect(RESEARCH.contradiction_detection.structural(cd.input, { ...cref, resolution: "The first source is right." })[0]).toMatch(/\[instruction\] a resolution is given/);
    const sa = loadCaseSet<SemanticCase>("source_assessment").cases[0]!;
    const sref = refs.source_assessment![sa.id]! as { sources: Record<string, unknown>[]; independent_count: number };
    expect(RESEARCH.source_assessment.agree({ sources: sref.sources.map((s) => ({ ...s, duplicate_of: null })), independent_count: 5 }, sa.expect).join(" ")).toMatch(/duplicate_of null \(reference "S3"\)[\s\S]*independent_count 5 \(reference 4\)/);
    const oa = loadCaseSet<SemanticCase>("opportunity_analysis").cases[0]!;
    const oref = refs.opportunity_analysis![oa.id]!;
    expect(RESEARCH.opportunity_analysis.agree({ ...oref, feasibility: { finding: "Digital goods are cheap to make.", evidence: ["S1"], status: "supported" } }, oa.expect)[0]).toMatch(/\[hallucination\] feasibility: the file has nothing on it/);
  });
  it("a candidate's research run is recorded under the candidate, gate first, then one Verifier batch with the class rubric", async () => {
    const set = loadCaseSet<SemanticCase>("opportunity_card");
    const { db, ex, clk, state } = await start({
      localLlm: (p) => {
        const c = set.cases.find((k) => p.prompt === k.input)!;
        const o = refs.opportunity_card![c.id]!;
        return { ok: true, available: true, model: "qwen3.8:27b", digest: "abc", ms: 5000, usage: { prompt_tokens: 600, output_tokens: 200 }, output: c.id === "oc-02" ? { ...o, monthly_sales_estimate: 999 } : o };
      },
      verdicts: (items) => items.map((x, i) => ({ id: x.id, pass: i !== 0, reason: i === 0 ? "target customer is guessed" : "supported" })),
    });
    expect(await qualifyRun(db, "opportunity_card", { worker: "cand-qwen38" })).toMatchObject({ submitted: 20, worker: "cand-qwen38", model: "qwen3.8:27b" });
    await settle(db, ex, clk, 16);
    expect(ex.log.find((l) => l.op === "local_llm")!.params.model).toBe("qwen3.8:27b");
    expect(state.verifierPrompts.at(-1)).toMatch(/independent reviewer of research work/);
    const st = (await qualifyStatus(db)).find((s) => s.taskClass === "opportunity_card" && s.worker === "cand-qwen38")!;
    expect(st).toMatchObject({ candidateOnly: true, samples: 20, gatePass: 19, gateFail: 1, verifierPass: 18, verifierFail: 1, agreement: 0.9, finalStatus: "REJECTED_BY_VERIFIER", routedTo: null });
    expect(st.failures.map((f) => [f.case, f.gate, f.verifier]).sort()).toEqual([["oc-01", true, "fail"], ["oc-02", false, null]]);
    expect((await routeTableAll(db)).every((r) => !(r.worker in CANDIDATES))).toBe(true);
  });
});

describe("EC4 the same pinned cases for a second model, and the edit-based coding path as a separate class", () => {
  it("runs the existing classes for a candidate without touching the first model's records", async () => {
    const { db, ex, clk } = await start({ localLlm: (p) => ({ ok: true, available: true, model: String(p.model), ms: 700, output: { tags: [] } }) });
    await qualifyRun(db, "classification");
    await qualifyRun(db, "classification", { worker: "cand-qwen38" });
    await settle(db, ex, clk, 4);
    const rs = await db.select().from(qualificationRecords);
    expect(rs.filter((r) => r.worker === "local-llm").length).toBe(20);
    expect(rs.filter((r) => r.worker === "cand-qwen38").map((r) => r.model)).toEqual(Array(20).fill("qwen3.8:27b"));
    expect(new Set(rs.map((r) => r.caseSetSha256)).size).toBe(1); // the same pinned file
    const sent = ex.log.filter((l) => l.op === "local_llm");
    expect(sent[0]!.params.system).toBe(sent[20]!.params.system); // the same instruction for both models
    expect(sent[0]!.params.prompt).toBe(sent[20]!.params.prompt);
  });
  it("patch classes reuse the pinned coding tasks with the edit interface and the outside-must-not-change rule", async () => {
    expect([...PATCH_CLASSES]).toEqual(["patch_repair", "patch_small_code"]);
    const whole = loadCaseSet<CodeCase>("bounded_repair");
    expect(loadCaseSet<CodeCase>("patch_repair").sha).toBe(whole.sha);
    const { db, ex, clk, state } = await start({ localCode: (p) => ({ ok: true, model: String(p.model), ms: 9000, prompt_chars: 5000, edits: 1, diff: "d", diffstat: "1 file changed", numstat: "1\t1\tsrc/x.ts", gate: state.localCode.length === 1 ? { pass: false, stage: "preserve", reason: "the change reaches outside the place the task is about" } : state.localCode.length === 2 ? { pass: false, stage: "edit", reason: "the search text occurs 0 times" } : { pass: true, stage: "checks", checks: [] } }) });
    expect(await qualifyRun(db, "patch_repair", { worker: "cand-devstral" })).toMatchObject({ submitted: 20, worker: "cand-devstral", model: "devstral-small-2:24b" });
    await settle(db, ex, clk, 40);
    const p0 = state.localCode[0]!;
    expect(p0).toMatchObject({ mode: "patch", model: "devstral-small-2:24b", scope: whole.cases[0]!.scope, pretest: whole.cases[0]!.pretest });
    expect(String(p0.system)).toMatch(/"search" must be copied EXACTLY/);
    expect(p0.preserve).toEqual([{ path: whole.cases[0]!.setup![0]!.path, anchor: whole.cases[0]!.setup![0]!.replace }]);
    const st = (await qualifyStatus(db)).find((s) => s.taskClass === "patch_repair")!;
    expect(st).toMatchObject({ worker: "cand-devstral", candidateOnly: true, samples: 20, gatePass: 18, verifierPass: 18, finalStatus: "FAILED_GATE" });
    expect(st.failures.map((f) => f.stage).sort()).toEqual(["edit", "preserve"]);
    // the whole-file classes are separate records and separate statuses
    expect((await qualifyStatus(db)).find((s) => s.taskClass === "bounded_repair" && s.worker === "cand-devstral")).toBeUndefined();
  });
});
