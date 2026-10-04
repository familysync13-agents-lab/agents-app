/*
 * EVIDENCE (modernization phase 3). Pure rules, no I/O.
 *
 * Evidence stays in the existing `evidence` table (Architecture Baseline v0.1 section 9: typed, attributable, bound to a commit
 * and a contract version). This module adds what the free-form rows lacked:
 *   - structure: what a row is evidence OF (kind) and which criterion of which contract it belongs to (linkage by id, never by text);
 *   - provenance: who observed it and by which recorded act (gate check run, worker run);
 *   - integrity: a hash chain per task over the canonical row, including the hash of the stored artifact it points to;
 *   - status: the criterion status is COMPUTED from the rows bound to the judged head and contract - never self-reported;
 *   - packaging: one deterministic evidence package per judged head (plan task / atomic task / integrated result), which is what
 *     Gate, Verifier and Decision are handed.
 * Everything here is deterministic; no model is involved in collecting, linking, sealing or judging evidence.
 */
import { createHash } from "node:crypto";
import type { EvidenceKind, EvidenceScope, EvidenceStatus } from "@/db/schema";
import type { Contract, Criterion } from "./contract";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------- structure and provenance ---------------------------------------
export interface Linkage {
  kind: EvidenceKind;
  criterionTask: string | null;
  criterionId: string | null;
  collector: string;
  runId: number | null;
  /** the gate check-run id named by the source ("gate:<id>"), resolved to a gate_results row by the caller */
  checkRun: number | null;
  checkName: string | null;
}

const CRIT = /^(T[0-9]+):((?:AC|C)[0-9]+)$/;
const LOOSE = /^(?:(T[0-9]+):)?((?:AC|C)[0-9]+)$/i;

/**
 * What a row is evidence of, from its subject, source and detail - the conventions every writer already follows. Used for new rows
 * (so writers need no change) and to backfill rows written before the Evidence phase. Unrecognised subjects are "other": never guessed.
 */
export function linkage(i: { subject: string; source: string; detail?: string | null; taskKey: string | null }): Linkage {
  const subject = i.subject.trim();
  const src = i.source.trim();
  const colon = src.indexOf(":");
  const head = colon < 0 ? src : src.slice(0, colon);
  const tail = colon < 0 ? "" : src.slice(colon + 1);
  const num = /^[0-9]+$/.test(tail) ? Number(tail) : null;
  const collector = head === "gate" ? "gate" : head === "verifier" ? "verifier" : head === "builder" || head === "mutation" ? "builder" : head === "owner" ? "owner" : "control-plane";
  const base = { collector, runId: head === "verifier" || head === "builder" || head === "mutation" ? num : null, checkRun: head === "gate" ? num : null, checkName: null as string | null };
  let m = CRIT.exec(subject);
  if (m) {
    // gate rows: detail is "[regression · ]<check>[ · <detail>]"
    const d = String(i.detail ?? "");
    const regression = d.startsWith("regression") || (i.taskKey !== null && m[1] !== i.taskKey);
    const parts = d.split(" · ");
    const checkName = head === "gate" ? (parts[0] === "regression" ? parts[1] : parts[0])?.trim() || null : null;
    return { ...base, kind: regression ? "regression" : "criterion", criterionTask: m[1]!, criterionId: m[2]!, checkName };
  }
  const pre = (p: string) => (subject.startsWith(p) ? subject.slice(p.length) : null);
  let rest: string | null;
  if ((rest = pre("attribution:")) !== null) {
    m = CRIT.exec(rest);
    return { ...base, kind: "attribution", criterionTask: m?.[1] ?? null, criterionId: m?.[2] ?? null };
  }
  if ((rest = pre("finding:")) !== null) {
    // the Verifier names the criterion it tested when it can ("AC3", "T9:AC3"); anything else stays unlinked
    const l = LOOSE.exec(rest.trim());
    return { ...base, kind: "finding", criterionTask: l ? (l[1]?.toUpperCase() ?? i.taskKey) : null, criterionId: l ? l[2]!.toUpperCase() : null };
  }
  if (subject === "independent-verifier") return { ...base, kind: "verifier_run", criterionTask: null, criterionId: null };
  if ((rest = pre("oracle-mutation:")) !== null) {
    m = CRIT.exec(rest);
    return { ...base, kind: "oracle_mutation", criterionTask: m?.[1] ?? (/^T[0-9]+$/.test(rest) ? rest : null), criterionId: m?.[2] ?? null };
  }
  for (const [p, kind] of [["oracle-calibration:", "oracle_calibration"], ["oracle-validation:", "oracle_validation"], ["regression-oracle:", "regression_oracle"]] as const) {
    if ((rest = pre(p)) !== null) return { ...base, kind, criterionTask: /^T[0-9]+$/.test(rest) ? rest : null, criterionId: null };
  }
  return { ...base, kind: "other", criterionTask: null, criterionId: null };
}

// ---------------------------------------------------------------- integrity -------------------------------------------------------
/** The fields of a row that are sealed. Timestamps and database ids are not part of the content. */
export interface SealedRow {
  taskId: number;
  seq: number;
  subject: string;
  status: string;
  oracle: string;
  persistence: string;
  source: string;
  commitSha: string | null;
  contractSha256: string | null;
  detail: string | null;
  severity: string | null;
  kind: string | null;
  criterionTask: string | null;
  criterionId: string | null;
  contractVersion: number | null;
  planTask: string | null;
  scope: string | null;
  collector: string | null;
  runId: number | null;
  gateResultId: number | null;
  checkName: string | null;
  /** sha256 of the artifact body the row points to (null when it has none) */
  artifactSha256: string | null;
}
const SEALED_FIELDS: (keyof SealedRow)[] = ["taskId", "seq", "subject", "status", "oracle", "persistence", "source", "commitSha", "contractSha256", "detail", "severity", "kind", "criterionTask", "criterionId", "contractVersion", "planTask", "scope", "collector", "runId", "gateResultId", "checkName", "artifactSha256"];

export const canonicalRow = (r: SealedRow): string => JSON.stringify(SEALED_FIELDS.map((k) => [k, r[k] ?? null]));
/** Hash of a row in its task's chain: the previous record hash followed by the canonical row. */
export const recordHash = (prev: string | null, r: SealedRow): string => sha256(`${prev ?? ""}\n${canonicalRow(r)}`);

export interface ChainRow extends SealedRow {
  id: number;
  prevSha256: string | null;
  recordSha256: string | null;
}
export interface ChainResult {
  ok: boolean;
  rows: number;
  sealed: number;
  /** hash of the last sealed row: one value that stands for the whole evidence history of the task */
  head: string | null;
  problems: string[];
}
/** Verify a task's chain (rows in seq order). Any edited, removed, reordered or inserted row is reported with its position. */
export function verifyChain(rows: ChainRow[]): ChainResult {
  const problems: string[] = [];
  const sorted = [...rows].sort((a, b) => a.seq - b.seq || a.id - b.id);
  let prev: string | null = null;
  let expectSeq = 1;
  for (const r of sorted) {
    if (r.recordSha256 === null) { problems.push(`evidence ${r.id}: not sealed`); continue; }
    if (r.seq !== expectSeq) problems.push(`evidence ${r.id}: position ${r.seq} where ${expectSeq} was expected (a row is missing or was inserted)`);
    if ((r.prevSha256 ?? null) !== prev) problems.push(`evidence ${r.id}: does not follow the previous record`);
    if (recordHash(r.prevSha256 ?? null, r) !== r.recordSha256) problems.push(`evidence ${r.id}: content does not match its seal`);
    prev = r.recordSha256;
    expectSeq = r.seq + 1;
  }
  return { ok: problems.length === 0, rows: rows.length, sealed: sorted.filter((r) => r.recordSha256 !== null).length, head: prev, problems: problems.slice(0, 20) };
}

// ---------------------------------------------------------------- computed status -------------------------------------------------
export interface EvRow {
  id: number;
  seq: number | null;
  subject: string;
  status: EvidenceStatus;
  oracle: "deterministic" | "threshold" | "agent_judgment" | "human_judgment";
  persistence: string;
  source: string;
  commitSha: string | null;
  contractSha256: string | null;
  detail: string | null;
  severity: string | null;
  artifactId: number | null;
  kind: EvidenceKind | null;
  criterionTask: string | null;
  criterionId: string | null;
  collector: string | null;
  runId: number | null;
  gateResultId: number | null;
  checkName: string | null;
  recordSha256: string | null;
}

/** The class of proof a criterion requires (Contract v2 `verify`; V1 contracts: by type). */
export function requiredProof(c: Criterion): "deterministic" | "judgment" {
  if (c.verify) return c.verify === "judgment" ? "judgment" : "deterministic";
  return c.type === "experience" ? "judgment" : "deterministic";
}

export interface CriterionState {
  id: string;
  priority: "must" | "should";
  type: string;
  required_proof: "deterministic" | "judgment";
  in_scope: boolean;
  status: EvidenceStatus;
  reason: string;
  /** ids of the evidence rows the status rests on (latest observation first) */
  evidence: number[];
  /** blocking independent findings against a criterion the deterministic evidence verifies */
  contradicted_by: number[];
  findings: number[];
  /** rows for this criterion that do not count: bound to another head or another contract version */
  not_counted: number;
}

const first = (s: string | null | undefined) => String(s ?? "").split("\n")[0]!.slice(0, 240);
const blocking = (r: EvRow) => ["critical", "high"].includes(String(r.severity ?? "").toLowerCase());
const order = (a: EvRow, b: EvRow) => (b.seq ?? b.id) - (a.seq ?? a.id) || b.id - a.id;

/**
 * Status of one criterion at one head (Baseline section 9; computed, never self-reported):
 *  - only rows bound to this exact head count, and a row bound to another contract hash never counts;
 *  - the latest qualifying observation decides (a later gate run replaces an earlier one for the same head);
 *  - a criterion whose proof is judgment is at most Partially verified on deterministic or agent evidence alone when it is a must
 *    (agent judgment alone never satisfies a must-criterion); a human judgment or an owner waiver completes it;
 *  - a blocking independent finding against a criterion the gate verifies makes it Partially verified (the evidence disagrees);
 *  - no qualifying row = Not verified with the reason recorded; an indeterminate observation = Unknown.
 */
export function criterionState(c: Criterion, taskKey: string, rows: EvRow[], bind: { head: string; contractSha256: string | null }, inScope: boolean): CriterionState {
  const mine = rows.filter((r) => r.criterionTask === taskKey && r.criterionId === c.id);
  const bound = (r: EvRow) => r.commitSha === bind.head && (r.contractSha256 === null || bind.contractSha256 === null || r.contractSha256 === bind.contractSha256);
  const obs = mine.filter((r) => (r.kind === "criterion" || r.kind === "regression") && bound(r)).sort(order);
  const findings = mine.filter((r) => r.kind === "finding" && r.commitSha === bind.head).sort(order);
  const base = { id: c.id, priority: c.priority, type: c.type, required_proof: requiredProof(c), in_scope: inScope, findings: findings.map((r) => r.id), not_counted: mine.filter((r) => (r.kind === "criterion" || r.kind === "regression") && !bound(r)).length };
  const done = (status: EvidenceStatus, reason: string, contradicted: number[] = []): CriterionState => ({ ...base, status, reason, evidence: obs.map((r) => r.id), contradicted_by: contradicted });
  const waived = obs.find((r) => r.status === "waived");
  if (waived) return done("waived", `waived: ${first(waived.detail) || waived.source}`);
  const latest = obs[0];
  if (!latest) return done("not_verified", base.not_counted ? `no evidence bound to ${bind.head.slice(0, 8)} and this contract version (${base.not_counted} observation(s) for another head or version do not count)` : `no evidence bound to ${bind.head.slice(0, 8)}`);
  if (latest.status === "unknown") return done("unknown", first(latest.detail) || "the observation was indeterminate");
  if (latest.status === "not_verified") return done("not_verified", first(latest.detail) || "the check did not pass");
  if (latest.status === "partially_verified") return done("partially_verified", first(latest.detail) || "only part of the required evidence is present");
  // the latest observation says Verified
  const contra = findings.filter(blocking).map((r) => r.id);
  if (contra.length) return done("partially_verified", `the gate verifies it, but ${contra.length} blocking independent finding(s) against it are open on this head`, contra);
  if (base.required_proof === "judgment" && c.priority === "must") {
    const human = obs.some((r) => r.oracle === "human_judgment" && r.status === "verified");
    if (!human) return done("partially_verified", "deterministic or agent evidence is present; the required judgment (human, or an owner waiver) is not");
  } else if (latest.oracle === "agent_judgment" && c.priority === "must") {
    return done("partially_verified", "agent judgment alone never satisfies a must-criterion");
  }
  return done("verified", `${latest.oracle} evidence${latest.checkName ? ` (${latest.checkName})` : ""}, ${latest.source}`);
}

// ---------------------------------------------------------------- the package -----------------------------------------------------
export interface PackageInput {
  task: { id: number; key: string; title: string; tier: string };
  scope: EvidenceScope;
  planTask: string | null;
  /** criterion / constraint ids the judged head must satisfy; null = every criterion of the contract */
  inScope: string[] | null;
  head: string;
  contract: { version: number; sha256: string; body: Contract } | null;
  plan: { version: number; tasks: { id: string; status: string; covers: string[] }[]; integration: string[] } | null;
  gate: { id: number; checkRunId: number; verdict: string; kind: string; headSha: string; contractSha256: string | null; evidenceArtifactId: number | null } | null;
  rows: EvRow[];
  /** id -> stored hash and whether the stored body still has that hash */
  artifacts: Record<number, { sha256: string; intact: boolean; kind: string; name: string }>;
  chain: ChainResult;
  stage: string;
}
export type PackageStatus = "complete" | "incomplete" | "blocked" | "inconsistent";

/** Stable JSON: keys sorted, so the same evidence always gives the same bytes and the same hash. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function buildPackage(i: PackageInput) {
  const atHead = i.rows.filter((r) => r.commitSha === i.head);
  const bind = { head: i.head, contractSha256: i.contract?.sha256 ?? null };
  const key = i.task.key;
  const criteria = (i.contract?.body.criteria ?? []).map((c) => criterionState(c, key, i.rows, bind, i.inScope === null || i.inScope.includes(c.id)));
  // constraints (Contract v2) are requirements too; their verification paths arrive with the Gate phase. They are listed with
  // whatever evidence exists and never silently counted as satisfied.
  const constraints = (i.contract?.body.constraints ?? []).map((c) => {
    const ev = i.rows.filter((r) => r.criterionTask === key && r.criterionId === c.id && r.commitSha === i.head).sort(order);
    return { id: c.id, kind: c.kind, verify: c.verify, in_scope: i.inScope === null || i.inScope.includes(c.id), status: (ev[0]?.status ?? "not_verified") as EvidenceStatus, reason: ev[0] ? first(ev[0].detail) : "no verification path produces evidence for constraints yet (Gate phase)", evidence: ev.map((r) => r.id) };
  });
  // criteria of EARLIER tasks judged at this head (regression): latest observation per subject
  const reg = new Map<string, EvRow>();
  for (const r of [...atHead].sort(order)) if (r.kind === "regression" && r.criterionTask && r.criterionTask !== key && !reg.has(r.subject)) reg.set(r.subject, r);
  const regressions = [...reg.values()].sort((a, b) => a.subject.localeCompare(b.subject)).map((r) => ({ subject: r.subject, status: r.status, evidence: r.id, reason: r.status === "verified" ? "" : first(r.detail) }));
  const findings = atHead.filter((r) => r.kind === "finding").sort((a, b) => a.id - b.id).map((r) => ({ evidence: r.id, criterion: r.criterionId, severity: String(r.severity ?? "low").toLowerCase(), title: first(r.detail), linked: r.criterionId !== null }));
  const vr = atHead.filter((r) => r.kind === "verifier_run").sort(order)[0];
  const verifier = { status: vr ? (vr.status === "verified" ? "no_defect_found" : "unknown") : findings.length ? "findings" : "not_run", run: vr?.runId ?? null, evidence: vr?.id ?? null, reason: vr && vr.status !== "verified" ? first(vr.detail) : "" };

  const must = criteria.filter((c) => c.in_scope && c.priority === "must");
  const gaps: string[] = [];
  const inconsistent: string[] = [];
  if (!i.contract) inconsistent.push("no approved contract is recorded for this task");
  if (!i.chain.ok) inconsistent.push(`evidence integrity: ${i.chain.problems[0] ?? "the chain does not verify"}`);
  const used = new Set([...atHead.map((r) => r.artifactId), i.gate?.evidenceArtifactId ?? null].filter((x): x is number => typeof x === "number"));
  const badArtifacts = [...used].filter((a) => i.artifacts[a] && !i.artifacts[a]!.intact);
  const missingArtifacts = [...used].filter((a) => !i.artifacts[a]);
  if (badArtifacts.length) inconsistent.push(`stored artifact(s) ${badArtifacts.join(", ")} no longer match their recorded hash`);
  if (missingArtifacts.length) inconsistent.push(`artifact(s) ${missingArtifacts.join(", ")} referenced by evidence are missing`);
  if (i.gate && i.gate.headSha !== i.head) inconsistent.push(`the gate result is for ${i.gate.headSha.slice(0, 8)}, not for the judged head ${i.head.slice(0, 8)}`);
  if (i.gate && i.contract && i.gate.contractSha256 && i.gate.contractSha256 !== i.contract.sha256) inconsistent.push("the gate evaluated a different contract version than the approved one");
  for (const c of must) if (c.status !== "verified" && c.status !== "waived") gaps.push(`${key}:${c.id} is ${c.status.replace("_", " ")}: ${c.reason}`);
  for (const r of regressions) if (r.status !== "verified" && r.status !== "waived") gaps.push(`${r.subject} (earlier task) is ${String(r.status).replace("_", " ")}: ${r.reason}`);
  // a passing gate verdict that the criterion evidence of the same head does not carry is a contradiction, never a pass
  if (i.gate?.kind === "pass" && gaps.length) inconsistent.push(`the gate verdict is ${i.gate.verdict}, but the evidence bound to this head does not verify every required criterion`);
  const status: PackageStatus = inconsistent.length ? "inconsistent" : must.some((c) => c.status === "unknown") ? "blocked" : gaps.length ? "incomplete" : "complete";

  const counts = (xs: { status: string }[]) => Object.fromEntries(["verified", "partially_verified", "not_verified", "unknown", "waived"].map((s) => [s, xs.filter((x) => x.status === s).length]));
  const evidenceIndex = atHead.filter((r) => r.kind !== "other" || r.artifactId !== null).sort((a, b) => a.id - b.id).map((r) => ({
    id: r.id, seq: r.seq, kind: r.kind, subject: r.subject, status: r.status, oracle: r.oracle, persistence: r.persistence, collector: r.collector, source: r.source, run: r.runId, gate_result: r.gateResultId, check: r.checkName,
    record_sha256: r.recordSha256, artifact: r.artifactId === null ? null : { id: r.artifactId, sha256: i.artifacts[r.artifactId]?.sha256 ?? null },
  }));
  const body = {
    schema: "agents-app/evidence-package@1",
    task: { key, title: i.task.title, tier: i.task.tier },
    scope: i.scope,
    plan_task: i.planTask,
    head: i.head,
    stage: i.stage,
    contract: i.contract ? { version: i.contract.version, sha256: i.contract.sha256, intent_sha256: i.contract.body.intent_sha256 ?? null } : null,
    plan: i.plan ? { version: i.plan.version, tasks: i.plan.tasks.map((t) => ({ id: t.id, status: t.status, covers: t.covers })), integration_only: i.plan.integration } : null,
    gate: i.gate ? { result: i.gate.id, check_run: i.gate.checkRunId, verdict: i.gate.verdict, kind: i.gate.kind, contract_sha256: i.gate.contractSha256, evidence_artifact: i.gate.evidenceArtifactId === null ? null : { id: i.gate.evidenceArtifactId, sha256: i.artifacts[i.gate.evidenceArtifactId]?.sha256 ?? null } } : null,
    status,
    criteria,
    constraints,
    regressions,
    findings,
    verifier,
    evidence: evidenceIndex,
    gaps,
    inconsistencies: inconsistent,
    integrity: { chain_ok: i.chain.ok, rows: i.chain.rows, sealed: i.chain.sealed, chain_head: i.chain.head, artifacts_checked: used.size, artifacts_bad: badArtifacts, artifacts_missing: missingArtifacts },
    /** what each downstream stage needs, and nothing else */
    handoff: {
      gate: { must_in_scope: must.map((c) => c.id), unknown: must.filter((c) => c.status === "unknown").map((c) => c.id), missing: must.filter((c) => c.status === "not_verified" && c.evidence.length === 0).map((c) => c.id), failing: must.filter((c) => c.status === "not_verified" && c.evidence.length > 0).map((c) => c.id), regressions_failing: regressions.filter((r) => r.status !== "verified").map((r) => r.subject) },
      // the Verifier is blind to the code and to the Builder's narrative: it gets criterion ids and evidence REQUIREMENTS only
      verifier: { head: i.head, contract_sha256: i.contract?.sha256 ?? null, judgment_required: criteria.filter((c) => c.required_proof === "judgment").map((c) => ({ id: c.id, priority: c.priority, requirement: (i.contract?.body.criteria.find((k) => k.id === c.id)?.evidence as string | undefined) ?? null })), unlinked_findings: findings.filter((f) => !f.linked).map((f) => f.evidence) },
      decision: { status, must_total: must.length, must: counts(must), should: counts(criteria.filter((c) => c.in_scope && c.priority === "should")), waived: must.filter((c) => c.status === "waived").map((c) => c.id), blocking: [...inconsistent, ...gaps].slice(0, 20), contradicted: criteria.filter((c) => c.contradicted_by.length).map((c) => c.id) },
    },
  };
  const text = stable(body);
  return { body, text, sha256: sha256(text), status, summary: { must_total: must.length, must: counts(must), regressions: regressions.length, findings: findings.length, gaps: gaps.length, inconsistencies: inconsistent.length, verifier: verifier.status, chain_head: i.chain.head } };
}
export type EvidencePackage = ReturnType<typeof buildPackage>;
