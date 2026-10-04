import type { EvidenceStatus } from "@/db/schema";

/** Shape of the project gate's evidence JSON (gate/gate.py, published as check-run annotations). */
export interface GateEvidence {
  verdict?: string;
  reasons?: string[];
  head_sha?: string;
  base_sha?: string;
  task?: string;
  contract_sha256?: string;
  criteria?: Record<string, { status?: string; check?: string | null; detail?: string; oracle_sha256?: string; class?: string | null; kind?: string }>;
  regression?: Record<string, { status?: string; check?: string | null; detail?: string; class?: string | null; kind?: string }>;
  checks?: Record<string, unknown>;
}

export interface CriterionEvidence {
  subject: string;
  status: EvidenceStatus;
  oracle: "deterministic" | "threshold" | "agent_judgment" | "human_judgment";
  persistence: "regression" | "baseline" | "point_in_time";
  detail: string;
  check: string;
  regression: boolean;
  /**
   * Does this record decide the verdict? Not when the gate reported it without judging it: "Deferred" (not yet required at this
   * plan task), "Judgment" (the independent Verifier's part) or "Unbound" (a constraint of a task record older than gate v3).
   */
  deciding: boolean;
  /** "criterion" | "constraint" (gate v3) */
  requirement: string;
  verifyClass: string | null;
}
const NON_DECIDING = ["deferred", "judgment", "unbound"];

/** The gate reports Verified / Not verified / Unknown; anything else is Unknown (never guessed). */
export function mapStatus(s: string | undefined): EvidenceStatus {
  switch ((s ?? "").toLowerCase()) {
    case "verified":
      return "verified";
    case "not verified":
    case "not_verified":
      return "not_verified";
    case "partially verified":
    case "partially_verified":
      return "partially_verified";
    case "waived":
      return "waived";
    default:
      return "unknown";
  }
}

function oracleOf(check: string): CriterionEvidence["oracle"] {
  if (check.startsWith("probe:lcp")) return "threshold";
  if (check.startsWith("baseline:")) return "human_judgment";
  return "deterministic";
}
function persistenceOf(check: string): CriterionEvidence["persistence"] {
  if (check.startsWith("baseline:")) return "baseline";
  return "regression";
}

export function criteriaFromGate(ev: GateEvidence): CriterionEvidence[] {
  const out: CriterionEvidence[] = [];
  for (const [regression, rec] of [
    [false, ev.criteria ?? {}],
    [true, ev.regression ?? {}],
  ] as const) {
    for (const [subject, v] of Object.entries(rec)) {
      const check = v.check ?? "unmapped";
      const raw = (v.status ?? "").toLowerCase();
      out.push({
        deciding: !NON_DECIDING.includes(raw),
        requirement: v.kind ?? "criterion",
        verifyClass: v.class ?? null,
        subject,
        status: mapStatus(v.status),
        oracle: oracleOf(check),
        persistence: persistenceOf(check),
        detail: (v.detail ?? "").slice(0, 2000),
        check,
        regression,
      });
    }
  }
  return out;
}

export interface ScanEvidence { subject: string; status: EvidenceStatus; detail: string; severity: string }
/**
 * The gate's scanners as evidence (Gate phase). Policy today: a secret finding fails the gate (FAIL:SECRET); dependency and static
 * analysis findings are recorded with their ids and never decide the verdict - they are shown as Partially verified, not hidden.
 */
export function scansFromGate(ev: GateEvidence): ScanEvidence[] {
  const out: ScanEvidence[] = [];
  const ch = ev.checks ?? {};
  if (typeof ch.secret_scan_findings === "number") {
    const n = ch.secret_scan_findings;
    out.push({ subject: "scan:secrets", status: n === 0 ? "verified" : "not_verified", severity: n === 0 ? "info" : "critical", detail: n === 0 ? "gitleaks: no secret in the head tree" : `gitleaks: ${n} secret(s): ${JSON.stringify(ch.secret_scan_detail ?? []).slice(0, 600)}` });
  }
  const osv = ch.osv as { vulnerabilities?: number; ids?: string[]; error?: string } | undefined;
  if (osv) out.push(osv.error ? { subject: "scan:dependencies", status: "unknown", severity: "info", detail: `OSV-Scanner did not complete: ${String(osv.error).slice(0, 200)}` } : { subject: "scan:dependencies", status: (osv.vulnerabilities ?? 0) === 0 ? "verified" : "partially_verified", severity: "info", detail: (osv.vulnerabilities ?? 0) === 0 ? "OSV-Scanner: no known vulnerability in the dependency set" : `OSV-Scanner: ${osv.vulnerabilities} known vulnerabilit${osv.vulnerabilities === 1 ? "y" : "ies"} recorded (not gate-deciding): ${(osv.ids ?? []).slice(0, 20).join(", ")}` });
  const og = ch.opengrep as { findings?: number; rules?: string[]; where?: string[]; error?: string } | undefined;
  if (og) out.push(og.error ? { subject: "scan:static-analysis", status: "unknown", severity: "info", detail: `Opengrep did not complete: ${String(og.error).slice(0, 200)}` } : { subject: "scan:static-analysis", status: (og.findings ?? 0) === 0 ? "verified" : "partially_verified", severity: "info", detail: (og.findings ?? 0) === 0 ? "Opengrep: no finding" : `Opengrep: ${og.findings} finding(s) recorded (not gate-deciding): ${(og.rules ?? []).join(", ")} at ${(og.where ?? []).slice(0, 10).join(", ")}` });
  return out;
}

/** Details handed to the Builder for a correction: only what failed, verbatim from the gate (never the oracle source). */
export function correctionDetails(ev: GateEvidence): string {
  const lines: string[] = [];
  for (const r of ev.reasons ?? []) lines.push(`- ${r}`);
  for (const c of criteriaFromGate(ev)) {
    if (c.status === "verified" || !c.deciding) continue;
    lines.push(`- ${c.subject} (${c.regression ? "regression of an earlier task" : c.check}): ${c.status.replace("_", " ")}${c.detail ? ` - ${c.detail.trim().slice(0, 600)}` : ""}`);
  }
  const checkStage = (ev.checks?.check_stage as string | undefined) ?? "";
  if (ev.verdict === "FAIL:CHECK" && checkStage) lines.push(`Check stage output (tail):\n${stripAnsi(String(checkStage)).slice(-3000)}`);
  const build = ev.checks?.build as { log_tail?: string } | undefined;
  if (ev.verdict === "FAIL:BUILD" && build?.log_tail) lines.push(`Build output (tail):\n${stripAnsi(build.log_tail).slice(-3000)}`);
  return lines.join("\n") || "(the gate gave no further detail)";
}

export const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

export { ORACLE_DEFECT } from "./oracle-check";
import { isOracleDefect } from "./oracle-check";

/** Failing criteria of the task itself that are oracle defects (all of them, or null when any failure may be the implementation's). */
export function oracleDefects(ev: GateEvidence): CriterionEvidence[] | null {
  const failing = criteriaFromGate(ev).filter((c) => !c.regression && c.deciding && c.status !== "verified");
  if (failing.length === 0) return null;
  const defects = failing.filter((c) => c.check.startsWith("oracle:") && isOracleDefect(c.detail));
  return defects.length === failing.length ? defects : null;
}
