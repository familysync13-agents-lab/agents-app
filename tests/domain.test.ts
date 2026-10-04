import { describe, expect, it } from "vitest";
import { canonicalJson, lintContract, oracleCriteria, sha256, type Contract } from "@/domain/contract";
import { correctionDetails, criteriaFromGate, mapStatus } from "@/domain/gate";
import { canTransition, classifyVerdict } from "@/domain/lifecycle";
import { buildPrompt, correctionPrompt, draftPrompt } from "@/domain/prompts";
import { CONTRACT } from "./support/fixture-handlers";

describe("contract lint (Architecture Baseline section 7)", () => {
  it("accepts a well-formed contract", () => {
    expect(lintContract(CONTRACT("T9"), { id: "T9", tier: "standard" })).toEqual({ ok: true, problems: [] });
  });
  it("rejects missing given/when/then, open questions, wrong id and gated experience criteria", () => {
    const c = structuredClone(CONTRACT("T9")) as Record<string, unknown> & { criteria: Record<string, unknown>[] };
    c.criteria[0]!.then = "";
    c.open_questions = ["Which order?"];
    c.criteria.push({ id: "AC3", type: "experience", priority: "must", statement: "nice" });
    const r = lintContract(c, { id: "T10", tier: "standard" });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/id must be T10/);
    expect(r.problems.join("\n")).toMatch(/AC1: behavior criteria need given\/when\/then/);
    expect(r.problems.join("\n")).toMatch(/open_questions must be empty/);
    expect(r.problems.join("\n")).toMatch(/AC3: experience criteria need at least one reference/);
    expect(r.problems.join("\n")).toMatch(/AC3: the gate verifies must-criteria of type behavior, threshold and structural only/);
  });
  it("forces the critical tier for authz / data-loss / money / pii tags", () => {
    const c = structuredClone(CONTRACT("T9")) as { criteria: { tags: string[] }[] };
    c.criteria[0]!.tags = ["authz"];
    expect(lintContract(c, { id: "T9", tier: "standard" }).problems).toContain('criteria tagged authz/data-loss/money/pii require tier "critical"');
  });
  it("rejects malformed JSON shapes without throwing", () => {
    expect(lintContract(null, { id: "T9", tier: "standard" }).ok).toBe(false);
    expect(lintContract({ id: "T9" }, { id: "T9", tier: "standard" }).ok).toBe(false);
  });
  it("canonical bytes are stable and hash-bound", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    expect(a).toBe('{\n "a": {\n  "c": 3,\n  "d": 2\n },\n "b": 1\n}\n');
    expect(sha256(a)).toBe(sha256(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })));
  });
  it("maps only must-criteria of black-box types to the oracle", () => {
    expect(oracleCriteria(CONTRACT("T9") as unknown as Contract)).toEqual(["AC1"]);
  });
});

describe("gate evidence", () => {
  const ev = {
    verdict: "FAIL:ORACLE",
    reasons: ["a must-criterion of T9 failed"],
    criteria: { "T9:AC1": { status: "Not verified", check: "oracle:oracle/T9/check.mjs", detail: "B before A" }, "T9:AC2": { status: "Unknown", check: "probe:lcp" } },
    regression: { "T2:AC1": { status: "Verified", check: "oracle:oracle/T2/check.mjs" } },
  };
  it("keeps Unknown explicit and never upgrades an unrecognised status", () => {
    expect(mapStatus("Verified")).toBe("verified");
    expect(mapStatus("Not verified")).toBe("not_verified");
    expect(mapStatus("weird")).toBe("unknown");
    expect(mapStatus(undefined)).toBe("unknown");
    const rows = criteriaFromGate(ev);
    expect(rows.map((r) => [r.subject, r.status, r.oracle, r.regression])).toEqual([
      ["T9:AC1", "not_verified", "deterministic", false],
      ["T9:AC2", "unknown", "threshold", false],
      ["T2:AC1", "verified", "deterministic", true],
    ]);
  });
  it("gives the Builder only failing criteria and reasons, verbatim", () => {
    const d = correctionDetails(ev);
    expect(d).toContain("T9:AC1");
    expect(d).toContain("B before A");
    expect(d).not.toContain("T2:AC1");
  });
  it("classifies verdicts for the correction loop", () => {
    expect(classifyVerdict("DONE")).toBe("pass");
    expect(classifyVerdict("FAIL:CHECK")).toBe("candidate_failure");
    expect(classifyVerdict("FAIL:TAMPER")).toBe("tamper");
    expect(classifyVerdict("BLOCKED:EVIDENCE")).toBe("blocked");
    expect(classifyVerdict("AMENDMENT-OK")).toBe("harness");
  });
});

describe("lifecycle", () => {
  it("allows only the frozen transitions", () => {
    expect(canTransition("PROPOSED", "CONTRACTED")).toBe(true);
    expect(canTransition("PROPOSED", "DONE")).toBe(false);
    expect(canTransition("IN_PROGRESS", "DONE")).toBe(false); // DONE only after VERIFYING (gate evidence)
    expect(canTransition("VERIFYING", "DONE")).toBe(true);
    expect(canTransition("DONE", "ACCEPTED")).toBe(true);
    expect(canTransition("ACCEPTED", "IN_PROGRESS")).toBe(false);
    expect(canTransition("ABANDONED", "PROPOSED")).toBe(false);
  });
});

describe("worker instructions", () => {
  const p = { name: "P", description: "D", stack: "S" };
  it("state the structured-outcome rule and forbid pattern-based process killing", () => {
    const b = buildPrompt(p, { key: "T9", title: "X" });
    expect(b).toContain("Your final chat message is NOT read by the control system");
    expect(b).toContain("Never kill processes by matching names or command lines");
    expect(b).toMatch(/Never create, modify or delete tasks\/\*\*/);
  });
  it("carry the owner's decision verbatim into a revision", () => {
    const d = draftPrompt(p, { key: "T9", title: "X", intent: "I", tier: "standard" }, { previous: "PREV", ownerNote: "By title" });
    expect(d).toContain("PREV");
    expect(d).toContain("By title");
  });
  it("correction prompts carry the verdict, never an oracle", () => {
    expect(correctionPrompt({ key: "T9" }, "abc", "FAIL:ORACLE", "T9:AC1 failed")).toContain("VERDICT: FAIL:ORACLE");
  });
});
