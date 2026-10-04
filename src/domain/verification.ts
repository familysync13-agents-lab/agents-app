/*
 * VERIFIER (modernization phase 5). Pure rules, no I/O.
 *
 * The independent Verifier stays what it was: a different vendor, blind to the code and to the Builder's narrative, checking a
 * preview of the exact head after the gate passed. This module makes its result STRUCTURED and its consequences deterministic:
 *   - coverage: one verdict per requirement the Verifier can observe (must-criteria and observable constraints), by id;
 *   - judgment: one verdict, with captured evidence, per requirement whose proof is judgment;
 *   - findings: tied to a criterion id (or none), with a failure CLASS - only an implementation defect is the Builder's;
 *   - materiality: which findings send the work back is computed here, never taken from the Verifier's wording;
 *   - false-positive control: a blocking finding must be reproduced by the control plane running the Verifier's own reproduction
 *     script against the same preview; a reproduction that runs and does not show the defect makes the finding unconfirmed;
 *   - precedence: nothing here can turn a gate failure or an evidence-integrity failure into a pass. The Verifier runs only on a
 *     head whose gate verdict passed and whose evidence package is complete, and its "conforms" never changes a criterion status.
 */
import { z } from "zod";
import type { Contract } from "./contract";

export const FINDING_CLASSES = ["implementation", "check", "infrastructure", "evidence", "control_plane"] as const;
export type FindingClass = (typeof FINDING_CLASSES)[number];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

const Str = z.string().max(4000);
const Finding = z
  .object({
    id: z.string().regex(/^F[0-9]+$/).optional(),
    severity: z.string().optional(),
    class: z.string().optional(),
    criterion: z.string().max(80).optional(),
    title: Str.optional(),
    expected: Str.optional(),
    observed: Str.optional(),
    repro: z.array(Str).max(30).optional(),
    reproduced: z.number().int().min(0).max(99).optional(),
  })
  .loose();
export const VerifierOutput = z
  .object({
    schema: z.number().optional(),
    coverage: z.array(z.object({ criterion: z.string().max(40), verdict: z.string().max(40), how: Str.optional() }).loose()).max(200).optional(),
    judgments: z.array(z.object({ id: z.string().max(40), verdict: z.string().max(40), evidence: Str.optional(), reason: Str.optional() }).loose()).max(100).optional(),
    findings: z.array(Finding).max(50).optional(),
    blocked: z.object({ class: z.string(), reason: Str }).loose().nullable().optional(),
    checked: z.unknown().optional(),
    unknown: z.unknown().optional(),
  })
  .loose();
export type VerifierOutput = z.infer<typeof VerifierOutput>;

/** What the Verifier is asked to cover, by id: observable requirements, and requirements whose proof is judgment. */
export function verificationScope(c: Contract): { observe: { id: string; text: string }[]; judge: { id: string; text: string; requirement: string | null }[] } {
  const text = (k: Contract["criteria"][number]) => (k.type === "behavior" ? `Given ${k.given ?? ""}, when ${k.when ?? ""}, then ${k.then ?? ""}` : k.type === "threshold" ? `${k.metric ?? ""}: ${k.target ?? ""}${k.conditions ? ` (${k.conditions})` : ""}` : (k.statement ?? ""));
  const observe = [
    ...c.criteria.filter((k) => k.priority === "must" && (k.type === "behavior" || k.type === "threshold")).map((k) => ({ id: k.id, text: text(k) })),
    ...(c.constraints ?? []).filter((x) => x.verify === "blackbox" || x.verify === "measure").map((x) => ({ id: x.id, text: x.statement })),
  ];
  const judge = [
    ...c.criteria.filter((k) => (k.verify ?? (k.type === "experience" ? "judgment" : "")) === "judgment").map((k) => ({ id: k.id, text: text(k), requirement: k.evidence ?? null })),
    ...(c.constraints ?? []).filter((x) => x.verify === "judgment").map((x) => ({ id: x.id, text: x.statement, requirement: null })),
  ];
  return { observe, judge };
}

export type Disposition = "blocking" | "unconfirmed" | "advisory" | "not_implementation";
export interface AssessedFinding {
  id: string;
  severity: (typeof SEVERITIES)[number];
  class: FindingClass;
  /** normalized link: "AC2" / "C1" of this contract, "T4:AC3" of an earlier one, or null */
  criterion: string | null;
  regression: boolean;
  security: boolean;
  title: string;
  expected: string;
  observed: string;
  repro: string[];
  /** would send the work back if it is real: an implementation defect, critical or high, against a requirement */
  material: boolean;
  /** what the control plane's own run of the reproduction showed */
  reproduction: "reproduced" | "not_reproduced" | "no_result" | "not_run";
  disposition: Disposition;
  why: string;
}
export interface Assessment {
  schema: "agents-app/verifier-assessment@1";
  valid: boolean;
  problems: string[];
  coverage: { required: string[]; conforms: string[]; violated: string[]; not_checked: string[]; ratio: number };
  judgments: { id: string; verdict: "satisfied" | "not_satisfied" | "cannot_judge"; evidence: string; reason: string }[];
  findings: AssessedFinding[];
  /** the Verifier itself could not verify, and why (never an implementation defect) */
  blocked: { class: FindingClass; reason: string } | null;
  verdict: "no_blocking_defect" | "defects_confirmed" | "unverified";
  /** what goes back to the Builder: confirmed blocking findings and requirements judged not satisfied */
  blocking: { finding: string | null; criterion: string | null; text: string }[];
}

const sev = (s: unknown): (typeof SEVERITIES)[number] => ((SEVERITIES as readonly string[]).includes(String(s ?? "").toLowerCase()) ? (String(s).toLowerCase() as (typeof SEVERITIES)[number]) : "low");
const cls = (s: unknown): FindingClass => ((FINDING_CLASSES as readonly string[]).includes(String(s ?? "implementation").toLowerCase()) ? (String(s ?? "implementation").toLowerCase() as FindingClass) : "implementation");
const LINK = /^(?:(T[0-9]+):)?((?:AC|C)[0-9]+)$/i;

/** One result line of the reproduction run ({criterion: "F1", result: "fail" = the defect was observed}). */
export interface ReproResult { criterion: string; result: string; detail?: string }

/**
 * Assess one Verifier output for a contract. `repro` = result lines of the control plane's run of the Verifier's reproduction
 * script, or null when it was not run (no script, or it failed its static validation).
 */
export function assessVerifier(c: Contract, taskKey: string, raw: unknown, repro: ReproResult[] | null): Assessment {
  const scope = verificationScope(c);
  const required = scope.observe.map((x) => x.id);
  const known = new Set([...c.criteria.map((k) => k.id), ...(c.constraints ?? []).map((x) => x.id)]);
  const must = new Set([...c.criteria.filter((k) => k.priority === "must").map((k) => k.id), ...(c.constraints ?? []).map((x) => x.id)]);
  const advisory = new Set((c.constraints ?? []).filter((x) => x.advisory === true).map((x) => x.id));
  const problems: string[] = [];
  const parsed = VerifierOutput.safeParse(raw);
  const empty: Assessment = { schema: "agents-app/verifier-assessment@1", valid: false, problems, coverage: { required, conforms: [], violated: [], not_checked: required, ratio: required.length ? 0 : 1 }, judgments: scope.judge.map((j) => ({ id: j.id, verdict: "cannot_judge", evidence: "", reason: "no usable Verifier output" })), findings: [], blocked: null, verdict: "unverified", blocking: [] };
  if (!parsed.success || raw === null || typeof raw !== "object") {
    problems.push(`the findings file is not valid: ${parsed.success ? "not an object" : (parsed.error.issues[0]?.message ?? "schema")}`);
    return empty;
  }
  const o = parsed.data;
  // ---- findings
  const findings: AssessedFinding[] = (o.findings ?? []).map((f, i) => {
    const id = f.id ?? `F${i + 1}`;
    const rawLink = String(f.criterion ?? "none").trim();
    const m = LINK.exec(rawLink);
    const other = m?.[1] && m[1].toUpperCase() !== taskKey ? `${m[1].toUpperCase()}:${m[2]!.toUpperCase()}` : null;
    const own = m && !other ? m[2]!.toUpperCase() : null;
    if (own && !known.has(own)) problems.push(`${id}: names criterion ${own}, which the contract does not have (kept as unlinked)`);
    const criterion = other ?? (own && known.has(own) ? own : null);
    const security = /^security$/i.test(rawLink);
    const severity = sev(f.severity);
    const klass = cls(f.class);
    const steps = (f.repro ?? []).filter((s) => s.trim());
    const material = klass === "implementation" && (severity === "critical" || severity === "high") && (other !== null || security || (criterion !== null && must.has(criterion)));
    const line = repro?.find((r) => r.criterion === id);
    const reproduction: AssessedFinding["reproduction"] = !material ? "not_run" : repro === null ? "not_run" : !line ? "no_result" : line.result === "fail" ? "reproduced" : line.result === "pass" ? "not_reproduced" : "no_result";
    let disposition: Disposition;
    let why: string;
    if (klass !== "implementation") { disposition = "not_implementation"; why = `class ${klass}: not a defect of the implementation, never sent to the Builder`; }
    else if (!material) { disposition = "advisory"; why = severity === "critical" || severity === "high" ? "not tied to a requirement of the contract, a regression or a security defect" : `severity ${severity}`; }
    else if (reproduction === "not_reproduced") { disposition = "unconfirmed"; why = "the control plane ran the Verifier's reproduction against the same build and the defect did not occur"; }
    else if (reproduction === "reproduced") { disposition = "blocking"; why = "reproduced by the control plane"; }
    // no working reproduction: the finding is neither confirmed nor refuted. It keeps its effect (the work goes back), so a missing script can never hide a real defect.
    else { disposition = "blocking"; why = reproduction === "no_result" ? "the reproduction gave no result for this finding; treated as reported" : "no reproduction script was run; treated as reported"; }
    return { id, severity, class: klass, criterion, regression: other !== null, security, title: String(f.title ?? "").slice(0, 300), expected: String(f.expected ?? "").slice(0, 1000), observed: String(f.observed ?? "").slice(0, 1000), repro: steps.slice(0, 20), material, reproduction, disposition, why };
  });
  // ---- coverage (by id; a requirement the Verifier does not mention is not checked - never assumed)
  const cov = new Map<string, string>();
  for (const e of o.coverage ?? []) {
    const m = LINK.exec(String(e.criterion).trim());
    const id = m && (!m[1] || m[1].toUpperCase() === taskKey) ? m[2]!.toUpperCase() : null;
    if (!id || !required.includes(id)) continue;
    const v = String(e.verdict).toLowerCase();
    cov.set(id, v === "conforms" || v === "violated" ? v : "not_checked");
  }
  // a criterion with a blocking-class finding against it is violated, whatever the coverage list says
  for (const f of findings) if (f.criterion && required.includes(f.criterion) && f.class === "implementation" && f.disposition !== "unconfirmed") cov.set(f.criterion, "violated");
  for (const id of required) if (cov.get(id) === "violated" && !findings.some((f) => f.criterion === id && f.class === "implementation")) { problems.push(`${id}: reported as violated without a finding that says how`); cov.set(id, "not_checked"); }
  const conforms = required.filter((id) => cov.get(id) === "conforms");
  const violated = required.filter((id) => cov.get(id) === "violated");
  const notChecked = required.filter((id) => !cov.has(id) || cov.get(id) === "not_checked");
  // ---- judgments (a verdict without captured evidence is not a judgment)
  const judgments = scope.judge.map((j) => {
    const e = (o.judgments ?? []).find((x) => String(x.id).toUpperCase().replace(/^.*:/, "") === j.id);
    const v = String(e?.verdict ?? "").toLowerCase();
    const evidence = String(e?.evidence ?? "").trim();
    if (!e) return { id: j.id, verdict: "cannot_judge" as const, evidence: "", reason: "the Verifier gave no judgment" };
    if ((v === "satisfied" || v === "not_satisfied") && evidence.length < 20) return { id: j.id, verdict: "cannot_judge" as const, evidence, reason: "a judgment needs the evidence it rests on" };
    return { id: j.id, verdict: v === "satisfied" ? ("satisfied" as const) : v === "not_satisfied" ? ("not_satisfied" as const) : ("cannot_judge" as const), evidence: evidence.slice(0, 2000), reason: String(e.reason ?? "").slice(0, 1000) };
  });
  const blocked = o.blocked && typeof o.blocked.reason === "string" ? { class: cls(o.blocked.class) === "implementation" ? ("infrastructure" as const) : cls(o.blocked.class), reason: o.blocked.reason.slice(0, 600) } : null;
  const blocking = [
    ...findings.filter((f) => f.disposition === "blocking").map((f) => ({ finding: f.id, criterion: f.criterion, text: `[${f.severity}] ${f.criterion ?? (f.security ? "security" : "")} - ${f.title}\n   expected: ${f.expected}\n   observed: ${f.observed}\n   steps: ${f.repro.join(" | ")}${f.reproduction === "reproduced" ? "\n   (reproduced by the control system against this build)" : ""}` })),
    // an advisory constraint is explicitly non-blocking: its judgment is reported, never sent back
    ...judgments.filter((j) => j.verdict === "not_satisfied" && !advisory.has(j.id)).map((j) => ({ finding: null, criterion: j.id, text: `[judgment] ${j.id} is not satisfied: ${j.reason || "(no reason given)"}\n   observed: ${j.evidence}` })),
  ];
  const verdict: Assessment["verdict"] = blocking.length ? "defects_confirmed" : blocked ? "unverified" : "no_blocking_defect";
  return { schema: "agents-app/verifier-assessment@1", valid: true, problems, coverage: { required, conforms, violated, not_checked: notChecked, ratio: required.length ? (conforms.length + violated.length) / required.length : 1 }, judgments, findings, blocked, verdict, blocking };
}

/** Findings whose reproduction the control plane should run before deciding (material implementation findings). */
export const needsReproduction = (a: Assessment): string[] => a.findings.filter((f) => f.material).map((f) => f.id);

/** Calibration figures of the Verifier from recorded assessments: how often its blocking findings stood up, and how much it covered. */
export function calibration(as: Assessment[]) {
  const fs = as.flatMap((a) => a.findings);
  const material = fs.filter((f) => f.material);
  const n = (d: AssessedFinding["reproduction"]) => material.filter((f) => f.reproduction === d).length;
  const tested = n("reproduced") + n("not_reproduced");
  return {
    runs: as.length, unusable: as.filter((a) => !a.valid).length, blocked: as.filter((a) => a.blocked).length,
    coverage: as.length ? as.reduce((s, a) => s + a.coverage.ratio, 0) / as.length : null,
    findings: fs.length, material: material.length, reproduced: n("reproduced"), not_reproduced: n("not_reproduced"), no_reproduction: n("no_result") + n("not_run"),
    /** share of material findings with a working reproduction that the control plane could NOT reproduce */
    false_positive_rate: tested ? n("not_reproduced") / tested : null,
    by_class: Object.fromEntries(FINDING_CLASSES.map((k) => [k, fs.filter((f) => f.class === k).length])),
  };
}
