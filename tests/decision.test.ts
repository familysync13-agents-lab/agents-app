import { describe, expect, it } from "vitest";
import { decide, ownerSummary, recordSha, strictFor } from "@/domain/decision";
import type { EvidencePackage } from "@/domain/evidence";

type Body = EvidencePackage["body"];
const body = (o: Record<string, unknown> = {}): Body =>
  ({
    task: { key: "T9", title: "t", tier: "standard" }, scope: "task", stage: "done", head: "h2", status: "complete",
    contract: { version: 1, sha256: "c".repeat(64), intent_sha256: null },
    gate: { result: 1, verdict: "DONE", kind: "pass" },
    criteria: [{ id: "AC1", priority: "must", in_scope: true, status: "verified" }, { id: "AC2", priority: "should", in_scope: true, status: "not_verified" }],
    constraints: [{ id: "C1", kind: "regression", verify: "blackbox", advisory: false, in_scope: true, counted: true, status: "verified", reason: "" }],
    regressions: [{ subject: "T1:AC1", status: "verified" }], scans: [], findings: [], gaps: [], inconsistencies: [],
    integrity: { chain_ok: true },
    verifier: { status: "no_defect_found", failure_class: null, reason: "", coverage: { checked: 2, required: 2, not_checked: [] }, findings: { blocking: 0, unconfirmed: 0, not_implementation: 0, advisory: 0 }, judgments: [] },
    ...o,
  }) as unknown as Body;
const C = (o: Record<string, unknown>) => ({ id: "C2", kind: "design", verify: "judgment", advisory: false, in_scope: true, counted: false, status: "unknown", reason: "no independent judgment", ...o });

describe("DC1 readiness: deterministic failures decide first", () => {
  it("a complete package with a passing gate is ready; an unverified should is residual and does not need review", () => {
    const r = decide(body(), "p".repeat(64));
    expect(r).toMatchObject({ outcome: "ready", blockers: [], attention: "clean", basis: { must_verified: 1, must_total: 1, constraints_proven: ["C1"], gate: "DONE" }, residual: [{ kind: "should", id: "AC2" }] });
    expect(ownerSummary(r).why).toMatch(/1 of 1 required criteria verified by the gate, 1 constraint\(s\) proven.*Nothing is accepted without proof/);
  });
  it("an incomplete package, a failed gate, broken integrity or a confirmed defect is never ready - whatever the Verifier wrote", () => {
    expect(decide(body({ status: "incomplete", gaps: ["T9:AC1 is not verified"] }), "p").blockers[0]).toMatch(/evidence package is incomplete: T9:AC1/);
    expect(decide(body({ gate: { verdict: "FAIL:ORACLE", kind: "candidate_failure" } }), "p").blockers.join()).toMatch(/no passing gate verdict for this head \(FAIL:ORACLE\)/);
    expect(decide(body({ integrity: { chain_ok: false } }), "p").outcome).toBe("not_ready");
    const v = body().verifier;
    expect(decide(body({ verifier: { ...v, status: "defects", findings: { ...v.findings, blocking: 1 } } }), "p").blockers.join()).toMatch(/confirmed 1 blocking defect/);
    expect(decide(body({ verifier: { ...v, judgments: [{ id: "AC1", verdict: "not_satisfied", evidence: 1 }] } }), "p").blockers.join()).toMatch(/AC1: independent judgment says not satisfied/);
    // T8 (live): a SHOULD-criterion judged not satisfied never blocks; it is listed for the owner
    const sh = decide(body({ verifier: { ...v, judgments: [{ id: "AC2", verdict: "not_satisfied", evidence: 1 }] } }), "p");
    expect(sh).toMatchObject({ outcome: "ready", residual: [{ kind: "should", id: "AC2", text: "should-criterion, not gated - Verifier NOT satisfied" }] });
    // T9 (live): a should the Verifier judged satisfied was shown as "not verified". Four distinct states, never that label.
    const st = (j: unknown[], independent: string | null = null) => decide(body({ criteria: [{ id: "AC1", priority: "must", in_scope: true, status: "verified" }, { id: "AC2", priority: "should", in_scope: true, status: "not_verified", independent }], verifier: { ...v, judgments: j } }), "p").residual.find((r) => r.id === "AC2")!.text;
    expect(st([{ id: "AC2", verdict: "satisfied" }])).toBe("should-criterion, not gated - Verifier satisfied");
    expect(st([{ id: "AC2", verdict: "cannot_judge" }])).toBe("should-criterion, not gated - Verifier could not judge");
    expect(st([])).toBe("should-criterion, not gated - Verifier did not check");
    expect(st([], "conforms")).toBe("should-criterion, not gated - Verifier satisfied");
    expect(st([], "violated")).toBe("should-criterion, not gated - Verifier NOT satisfied");
    for (const j of [[{ id: "AC2", verdict: "satisfied" }], [{ id: "AC2", verdict: "cannot_judge" }], []]) expect(st(j)).not.toMatch(/not verified/);
  });
});

describe("DC2 requirements nobody proved are never a normal final state", () => {
  it("an advisory constraint is listed as non-blocking; an unproven non-advisory one is shown first, and blocks under the current rule", () => {
    const adv = decide(body({ constraints: [C({ advisory: true, status: "not_verified" })] }), "p", { strict: true });
    expect(adv).toMatchObject({ outcome: "ready", attention: "clean", residual: [{ kind: "advisory_constraint", id: "C2", text: expect.stringMatching(/non-blocking by contract\): judged NOT satisfied/) }, { kind: "should" }] });
    const legacy = decide(body({ constraints: [C({})] }), "p", { strict: false });
    expect(legacy).toMatchObject({ outcome: "ready", attention: "review", residual: [{ kind: "not_proven", id: "C2" }, { kind: "should" }] });
    expect(ownerSummary(legacy).why).toMatch(/1 item\(s\) would be accepted without proof/);
    const strict = decide(body({ constraints: [C({ verify: "static", reason: "the gate reported nothing" })] }), "p", { strict: true });
    expect(strict).toMatchObject({ outcome: "not_ready", blockers: ["C2: a requirement that is neither proven nor advisory"] });
    expect(strictFor([{ verify: "judgment" }])).toBe(false);
    expect(strictFor([{ verify: "judgment", advisory: true }, { verify: "static" }])).toBe(true);
  });
});

describe("DC3 what is accepted without proof is always listed", () => {
  it("lists advisory and unconfirmed findings, partial Verifier coverage, a Verifier that gave no result, unclean scans and waivers", () => {
    const v = body().verifier;
    const r = decide(body({
      findings: [{ evidence: 9, criterion: null, severity: "low", title: "overflows at 375px", linked: false }],
      scans: [{ scanner: "dependencies", status: "partially_verified", detail: "2 known vulnerabilities" }],
      criteria: [{ id: "AC1", priority: "must", in_scope: true, status: "waived" }],
      verifier: { ...v, status: "no_defect_found_partial_coverage", coverage: { checked: 1, required: 2, not_checked: ["C1"] }, findings: { ...v.findings, unconfirmed: 1, advisory: 1 } },
    }), "p");
    expect(r.outcome).toBe("ready");
    expect(r.attention).toBe("review");
    expect(r.residual.map((x) => x.kind)).toEqual(["unconfirmed_finding", "finding", "verifier", "scan", "waiver"]);
    expect(decide(body({ verifier: { ...v, status: "unknown", failure_class: "evidence", reason: "cannot observe" } }), "p").residual[0]).toMatchObject({ kind: "verifier", text: expect.stringMatching(/gave no result \(evidence\): cannot observe/) });
  });
  it("the same package gives the same record and hash", () => {
    expect(recordSha(decide(body(), "p"))).toBe(recordSha(decide(body(), "p")));
    expect(recordSha(decide(body(), "p"))).not.toBe(recordSha(decide(body(), "q")));
  });
});
