import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOLDOUT, PROMOTABLE, promotion, qualification, ROUTES, route, TASK_CLASSES, WORKERS, type QualRecord } from "@/domain/router";
import { boundInput, semanticGate } from "@/domain/semantic";
import { qualificationRecords } from "@/db/schema";
import { collectCandidates, holdoutDecide, holdoutReference, holdoutStatus, loadCaseSet, qualifyRun, routeTableAll, type SemanticCase } from "@/worker/qualify";
import { createTask } from "@/server/owner";
import { clock, FakeExecutor, setup } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";

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

const M = "qwen3.8:27b";
const recs = (worker: string, taskClass: string, n: number, ok: number, mode = "harness", model = M): QualRecord[] => Array.from({ length: n }, (_, i) => ({ worker, taskClass, valid: true, agree: i < ok, model, mode }));

describe("PR1 qwen3.8:27b in production for classification only", () => {
  it("the candidate's recorded evidence counts for the worker, and classification routes to it", () => {
    const ev = recs("cand-qwen38", "classification", 20, 20);
    expect(qualification(ev, "local-qwen38", "classification")).toEqual({ status: "qualified", samples: 20, agreement: 1 });
    expect(route({ taskClass: "classification", risk: "standard", records: ev })).toMatchObject({ worker: "local-qwen38", model: M });
    // without its evidence the earlier qualified model still takes the class; with neither, the trusted worker
    expect(route({ taskClass: "classification", risk: "standard", records: recs("local-llm", "classification", 20, 19, "harness", "qwen3:14b") }).worker).toBe("local-llm");
    expect(route({ taskClass: "classification", risk: "standard", records: [] }).worker).toBe("claude-code");
    expect(route({ taskClass: "classification", risk: "critical", records: ev }).worker).toBe("claude-code");
  });
  it("is an alternative of no other class, and no local coding route changed", () => {
    for (const [cls, r] of Object.entries(ROUTES)) expect(r.alternatives.includes("local-qwen38")).toBe(cls === "classification");
    expect(ROUTES.small_code.alternatives).toEqual(["local-coder"]);
    expect(ROUTES.bounded_repair.alternatives).toEqual(["local-coder"]);
    expect(Object.keys(PROMOTABLE).sort()).toEqual(["failure_triage", "structured_extraction"]);
    // the ten primary classes keep exactly their alternatives (the System page's table)
    expect(TASK_CLASSES.map((c) => ROUTES[c].alternatives.join(","))).toEqual(["", "", "codex-builder,opencode-local", "codex-builder,opencode-local", "", "", "", "", "local-llm", "local-llm"]);
    expect(WORKERS["local-qwen38"]!.envelope).toEqual(WORKERS["local-llm"]!.envelope);
  });
});

describe("PR2 promotion by holdout", () => {
  for (const cls of ["structured_extraction", "failure_triage"] as const) {
    const trusted = ROUTES[cls].trusted;
    const pinned = recs("cand-qwen38", cls, 20, 19);
    it(`${cls}: the pinned 95% alone never routes; the trusted path stays`, () => {
      expect(route({ taskClass: cls, risk: "standard", records: pinned }).worker).toBe(trusted);
      expect(promotion(pinned, "local-qwen38", cls)).toMatchObject({ status: "holdout_pending", samples: 0 });
    });
    it(`${cls}: a complete holdout without a recorded decision does not route; with one it does`, () => {
      const h = [...pinned, ...recs("local-qwen38", cls, 50, 48, "holdout")];
      expect(promotion(h, "local-qwen38", cls)).toMatchObject({ status: "awaiting_decision", samples: 50, agree: 48 });
      expect(route({ taskClass: cls, risk: "standard", records: h }).worker).toBe(trusted);
      const d: QualRecord = { worker: "local-qwen38", taskClass: cls, valid: null, agree: null, model: M, mode: "promoted" };
      expect(promotion([...h, d], "local-qwen38", cls).status).toBe("promoted");
      expect(route({ taskClass: cls, risk: "standard", records: [...h, d] })).toMatchObject({ worker: "local-qwen38", reason: expect.stringMatching(/promoted .* 48 of 50 unseen cases agreed \(96%\)/) });
      expect(route({ taskClass: cls, risk: "critical", records: [...h, d] }).worker).toBe(trusted);
    });
    it(`${cls}: below 95%, incomplete, or rejected never routes, even with a "promoted" record`, () => {
      const d: QualRecord = { worker: "local-qwen38", taskClass: cls, valid: null, agree: null, model: M, mode: "promoted" };
      for (const h of [recs("local-qwen38", cls, 50, 47, "holdout"), recs("local-qwen38", cls, 49, 49, "holdout"), recs("local-qwen38", cls, 50, 50, "holdout", "other-model")]) {
        expect(route({ taskClass: cls, risk: "standard", records: [...pinned, ...h, d] }).worker).toBe(trusted);
      }
      const rej: QualRecord = { ...d, mode: "promotion_rejected" };
      const all = [...pinned, ...recs("local-qwen38", cls, 50, 50, "holdout"), d, rej];
      expect(promotion(all, "local-qwen38", cls).status).toBe("rejected");
      expect(route({ taskClass: cls, risk: "standard", records: all }).worker).toBe(trusted);
    });
    it(`${cls}: holdout samples are not pinned-set qualification samples`, () => {
      expect(qualification([...pinned, ...recs("local-qwen38", cls, 50, 0, "holdout")], "local-qwen38", cls)).toMatchObject({ samples: 20, agreement: 0.95 });
    });
    it(`${cls}: the holdout set has at least ${HOLDOUT.size} cases, none of them pinned, and every reference passes the class gate`, () => {
      const load = (dir: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "qualification", dir, `${cls}.json`), "utf8")) as { cases: { id: string; input: string; expect: Record<string, unknown> }[] };
      const hold = load("holdout").cases;
      const pin = new Set(load("cases").cases.map((c) => c.input));
      expect(hold.length).toBeGreaterThanOrEqual(HOLDOUT.size); // 50 plus spares for references the Verifier does not accept
      expect(new Set(hold.map((c) => c.input)).size).toBe(hold.length);
      expect(hold.filter((c) => pin.has(c.input))).toEqual([]);
      for (const c of hold) expect([c.id, semanticGate(cls, boundInput(cls, c.input), c.expect, c.expect).problems]).toEqual([c.id, []]);
    });
  }
});

describe("PR3 the holdout flow end to end (reference calibration, 50 unseen cases, independent review, recorded decision)", () => {
  it("calibrates the references first, runs only accepted cases, reviews every gate-passing output and routes only after the recorded decision", async () => {
    const cls = "structured_extraction";
    const set = loadCaseSet<SemanticCase>(cls, true);
    // the Verifier rejects the reference of the 2nd case in calibration, and one model output later; the model gets one case wrong at the gate
    let calibrating = true;
    const { db, ex, clk, state } = await start({
      localLlm: (p) => {
        const c = set.cases.find((k) => p.prompt === k.input)!;
        return { ok: true, available: true, model: M, digest: "d38", ms: 900, usage: { prompt_tokens: 300, output_tokens: 60 }, output: c.id === "sh-05" ? { ...c.expect, error_kind: "other" } : c.expect };
      },
      verdicts: (items) => items.map((x, i) => ({ id: x.id, pass: !(i === 1 && (calibrating ? items.length === 20 && x.id === items[1]!.id : false)) && !(!calibrating && i === 3 && items.length === 20), reason: "checked" })),
    });
    await expect(qualifyRun(db, cls, { worker: "local-qwen38", holdout: true })).rejects.toThrow(/not calibrated/);
    await expect(qualifyRun(db, cls, { worker: "local-llm", holdout: true })).rejects.toThrow(/not a promotion candidate/);
    expect(await holdoutReference(db, cls)).toMatchObject({ inserted: set.cases.length });
    expect(await holdoutReference(db, cls)).toMatchObject({ inserted: 0 });
    await settle(db, ex, clk, 30);
    expect(state.verifierPrompts.at(-1)).toMatch(/CORRECT for its input/);
    const refs = (await db.select().from(qualificationRecords)).filter((r) => r.worker === "reference");
    expect(refs.every((r) => r.verifier !== null)).toBe(true);
    const rejected = refs.filter((r) => r.verifier === "fail").map((r) => r.caseId);
    expect(rejected.length).toBeGreaterThan(0);
    calibrating = false;
    expect(await qualifyRun(db, cls, { worker: "local-qwen38", holdout: true })).toMatchObject({ submitted: 50, worker: "local-qwen38", model: M });
    await settle(db, ex, clk, 40);
    const hs = (await db.select().from(qualificationRecords)).filter((r) => r.worker === "local-qwen38" && r.mode === "holdout");
    expect(hs).toHaveLength(50);
    expect(hs.some((r) => rejected.includes(r.caseId))).toBe(false); // a case whose reference was not accepted is never run
    expect(hs.every((r) => r.agree !== null)).toBe(true);
    const st = (await holdoutStatus(db)).find((x) => x.taskClass === cls && x.worker === "local-qwen38")!;
    expect(st).toMatchObject({ samples: 50, gatePass: 49, verifierPending: 0, routedTo: "claude-code", promotion: { status: "awaiting_decision" } });
    expect(st.gatePass - st.verifierFail).toBe(st.agree);
    expect(st.failures.length).toBe(50 - st.agree);
    // the pinned evidence plus a complete holdout still does not route: the decision must be recorded
    expect((await routeTableAll(db)).find((r) => r.taskClass === cls)).toMatchObject({ worker: "claude-code", promotable: [{ worker: "local-qwen38", status: "awaiting_decision", samples: 50 }] });
    const d = await holdoutDecide(db, { cls, worker: "local-qwen38", decision: st.agree >= 48 ? "promoted" : "rejected", note: "test" });
    expect(d).toMatchObject({ samples: 50, routedTo: st.agree >= 48 ? "local-qwen38" : "claude-code" });
    await expect(holdoutDecide(db, { cls, worker: "local-qwen38", decision: "rejected", note: "again" })).rejects.toThrow(/already recorded/);
    const rec = (await db.select().from(qualificationRecords)).find((r) => r.mode === "promoted" || r.mode === "promotion_rejected")!;
    expect(rec.note).toMatch(/holdout \d+\/50 agreed/);
  });
  it("refuses to promote below the threshold and before the holdout is complete", async () => {
    const { db } = await start();
    await expect(holdoutDecide(db, { cls: "failure_triage", worker: "local-qwen38", decision: "promoted", note: "" })).rejects.toThrow(/not complete/);
    await db.insert(qualificationRecords).values(Array.from({ length: 50 }, (_, i) => ({ worker: "local-qwen38", taskClass: "failure_triage", mode: "holdout" as const, inputSha256: `x${i}`, model: M, valid: true, gate: i < 47, agree: i < 47, caseId: `fh-${i}` })));
    await expect(holdoutDecide(db, { cls: "failure_triage", worker: "local-qwen38", decision: "promoted", note: "" })).rejects.toThrow(/cannot promote: 47 of 50/);
    expect(await holdoutDecide(db, { cls: "failure_triage", worker: "local-qwen38", decision: "rejected", note: "47/50" })).toMatchObject({ promotion: { status: "rejected" }, routedTo: "codex-verifier" });
  });
});
