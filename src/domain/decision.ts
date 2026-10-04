import { createHash } from "node:crypto";
import { stable, type EvidencePackage } from "./evidence";

/*
 * Decision (Architecture Baseline section 9; Contract spec v2 section 11): what the owner's acceptance rests on.
 *
 * The decision record is COMPUTED from the final evidence package of the exact head - never written by a worker and never from
 * prose. It answers three questions and nothing else:
 *   1. May this head be offered for acceptance?           (readiness: mechanical, precedence gate > evidence integrity > Verifier)
 *   2. What is the acceptance based on?                   (the proof, by id, bound to head / contract / package hash)
 *   3. What is accepted WITHOUT proof if the owner approves?  (the residual: every item listed, none silently dropped)
 * A requirement that nobody proved and that is not explicitly advisory is "not proven": it is never a normal final state, so it
 * stops the offer for contracts written under the current rules and is shown first for older contracts.
 */

export type ResidualKind = "not_proven" | "advisory_constraint" | "finding" | "unconfirmed_finding" | "should" | "verifier" | "scan" | "waiver";
export interface Residual { kind: ResidualKind; id: string | null; text: string }

export interface DecisionRecord {
  schema: "agents-app/decision-record@1";
  task: string;
  head: string;
  contract: { version: number; sha256: string } | null;
  evidence_package: { sha256: string; status: string };
  /** ready: may be offered to the owner. not_ready: must not be offered; `blockers` say why. */
  outcome: "ready" | "not_ready";
  blockers: string[];
  basis: { must_verified: number; must_total: number; constraints_proven: string[]; regressions_verified: number; gate: string | null; verifier: string; verifier_coverage: string };
  residual: Residual[];
  /** clean: nothing is accepted without proof. review: the owner accepts the listed residual with the result. */
  attention: "clean" | "review";
}

type Body = EvidencePackage["body"];

/** strict: the contract was written under the rule that a judgment constraint is provable or advisory (unproven = blocker). */
export function decide(body: Body, pkgSha256: string, opts: { strict: boolean } = { strict: false }): DecisionRecord {
  const blockers: string[] = [];
  const residual: Residual[] = [];
  const must = body.criteria.filter((c) => c.in_scope && c.priority === "must");
  // 1. precedence: deterministic failures decide first; nothing below can outvote them
  if (body.status !== "complete") blockers.push(`the evidence package is ${body.status}${body.inconsistencies[0] ?? body.gaps[0] ? `: ${body.inconsistencies[0] ?? body.gaps[0]}` : ""}`);
  if (!body.integrity.chain_ok) blockers.push("evidence integrity does not verify");
  if (!body.gate || body.gate.kind !== "pass") blockers.push(`no passing gate verdict for this head${body.gate ? ` (${body.gate.verdict})` : ""}`);
  if (body.stage !== "done" && body.scope === "plan_task") blockers.push("a plan task alone never fulfils the contract");
  const v = body.verifier;
  if (v.status === "defects" || v.findings.blocking > 0) blockers.push(`the independent Verifier confirmed ${v.findings.blocking || "a"} blocking defect(s)`);
  if (v.findings.unconfirmed > 0) residual.push({ kind: "unconfirmed_finding", id: null, text: `${v.findings.unconfirmed} material finding(s) the control system could not reproduce` });
  // a judgment decides only for a required requirement: a must-criterion or a constraint that is not advisory
  for (const j of v.judgments) {
    if (j.verdict !== "not_satisfied") continue;
    const k = body.criteria.find((c) => c.id === j.id);
    const x = body.constraints.find((c) => c.id === j.id);
    if ((k && k.priority === "must") || (x && !x.advisory)) blockers.push(`${j.id}: independent judgment says not satisfied`);
  }

  // 2. requirements nobody proved
  for (const c of body.constraints.filter((x) => x.in_scope)) {
    if (c.counted || c.status === "waived") continue;
    if (c.advisory) residual.push({ kind: "advisory_constraint", id: c.id, text: `advisory (non-blocking by contract): ${c.status === "verified" ? "judged satisfied" : c.status === "not_verified" ? "judged NOT satisfied" : "not judged"} - ${c.reason}` });
    else {
      residual.push({ kind: "not_proven", id: c.id, text: `${c.kind} constraint was not proven by anyone: ${c.reason}` });
      if (opts.strict) blockers.push(`${c.id}: a requirement that is neither proven nor advisory`);
    }
  }
  // 3. what else is accepted without proof
  // a should-criterion the gate did not verify: say exactly what the independent Verifier made of it (four distinct states)
  for (const c of body.criteria.filter((x) => x.in_scope && x.priority === "should" && x.status !== "verified")) {
    const j = v.judgments.find((y) => y.id === c.id)?.verdict ?? null;
    const state = j === "satisfied" || c.independent === "conforms" ? "Verifier satisfied" : j === "not_satisfied" || c.independent === "violated" ? "Verifier NOT satisfied" : j === "cannot_judge" ? "Verifier could not judge" : "Verifier did not check";
    residual.push({ kind: "should", id: c.id, text: `should-criterion, not gated - ${state}` });
  }
  for (const c of must.filter((x) => x.status === "waived")) residual.push({ kind: "waiver", id: c.id, text: "must-criterion waived by the owner" });
  for (const f of body.findings.filter((x) => ["medium", "low"].includes(x.severity))) residual.push({ kind: "finding", id: f.criterion, text: `[${f.severity}] ${f.title}` });
  if (v.status === "not_run" || v.status === "unknown") residual.push({ kind: "verifier", id: null, text: `the independent Verifier gave no result${v.failure_class ? ` (${v.failure_class})` : ""}${v.reason ? `: ${v.reason}` : ""}` });
  else if (v.coverage.not_checked.length) residual.push({ kind: "verifier", id: null, text: `the independent Verifier did not check ${v.coverage.not_checked.join(", ")} (the gate did)` });
  for (const s of body.scans.filter((x) => x.status !== "verified")) residual.push({ kind: "scan", id: s.scanner, text: `scanner ${s.scanner}: ${s.detail}` });

  const order: ResidualKind[] = ["not_proven", "unconfirmed_finding", "finding", "verifier", "scan", "waiver", "advisory_constraint", "should"];
  residual.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(a.id).localeCompare(String(b.id)));
  return {
    schema: "agents-app/decision-record@1",
    task: body.task.key,
    head: body.head,
    contract: body.contract ? { version: body.contract.version, sha256: body.contract.sha256 } : null,
    evidence_package: { sha256: pkgSha256, status: body.status },
    outcome: blockers.length ? "not_ready" : "ready",
    blockers,
    basis: {
      must_verified: must.filter((c) => c.status === "verified").length,
      must_total: must.length,
      constraints_proven: body.constraints.filter((c) => c.counted && c.status === "verified").map((c) => c.id),
      regressions_verified: body.regressions.filter((r) => r.status === "verified").length,
      gate: body.gate?.verdict ?? null,
      verifier: v.status,
      verifier_coverage: `${v.coverage.checked}/${v.coverage.required}`,
    },
    residual,
    attention: residual.some((r) => r.kind !== "should" && r.kind !== "advisory_constraint") ? "review" : "clean",
  };
}

/** Strict = the contract follows the rule "a judgment constraint is advisory": then an unproven non-advisory constraint is a provable one nobody proved. */
export const strictFor = (constraints: { verify: string; advisory?: boolean }[]) => constraints.every((c) => c.verify !== "judgment" || c.advisory === true);
export const recordText = (r: DecisionRecord) => stable(r);
export const recordSha = (r: DecisionRecord) => createHash("sha256").update(recordText(r)).digest("hex");

/** The owner-facing reason: short, plain, facts only. */
export function ownerSummary(r: DecisionRecord): { why: string; lines: string[] } {
  const b = r.basis;
  const proven = `${b.must_verified} of ${b.must_total} required criteria verified by the gate${b.constraints_proven.length ? `, ${b.constraints_proven.length} constraint(s) proven` : ""}; independent Verifier: ${b.verifier.replaceAll("_", " ")} (${b.verifier_coverage} checked).`;
  const lines = r.residual.map((x) => `${x.id ? `${x.id}: ` : ""}${x.text}`.slice(0, 300));
  const why = r.attention === "clean" ? `${proven} Nothing is accepted without proof. Merging needs your approval of the exact head on GitHub.` : `${proven} ${r.residual.filter((x) => x.kind !== "should" && x.kind !== "advisory_constraint").length} item(s) would be accepted without proof - listed below. Merging needs your approval of the exact head on GitHub.`;
  return { why, lines };
}

/**
 * What a recorded decision record says is accepted without proof, as one plain statement (Decisions page): the residual items that
 * are neither unverified should-criteria nor advisory constraints - the same count ownerSummary writes. Null when the stored text is
 * not a decision record (nothing recorded, nothing shown). Read-only: counts the recorded residual, never recomputes the record.
 */
export function withoutProofStatement(content: string): string | null {
  let r: unknown;
  try {
    r = JSON.parse(content);
  } catch {
    return null;
  }
  const rec = r as Partial<DecisionRecord> | null;
  if (!rec || rec.schema !== "agents-app/decision-record@1" || !Array.isArray(rec.residual)) return null;
  const n = rec.residual.filter((x) => x && x.kind !== "should" && x.kind !== "advisory_constraint").length;
  return n === 0 ? "Nothing is accepted without proof" : n === 1 ? "1 item would be accepted without proof" : `${n} items would be accepted without proof`;
}
