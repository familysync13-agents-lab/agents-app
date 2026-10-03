import { z } from "zod";
import type { Contract } from "./contract";

/*
 * The PLAN (Contract spec v2, section 6): how the work for ONE authoritative contract is shaped and split. It is a control-plane
 * record, never a contract: its entries reference the contract's criteria by stable id and never copy or reword them, and
 * re-planning or re-classifying never changes the contract or its version. Everything here is pure and deterministic.
 */

/** Initial calibration values (to be validated or changed from execution data; not architectural constants). */
export const CALIBRATION = {
  maxMustCriteriaAtomic: 6,
  maxAssumptions: 3,
  maxNecessaryShare: 1 / 3,
};

export type Shape = "atomic" | "complex";

export interface ShapeFacts {
  /** an atomic attempt at this contract exhausted its correction budget */
  budgetExhausted?: boolean;
}

/**
 * Atomic vs complex. Complex if ANY rule fires. Never complex merely because many files change, the intent is long or the tier is
 * critical. Rules 2-4 read what the contract itself declares (criterion `group`, tags "migration" / "interface-change").
 */
export function classifyShape(c: Contract, f: ShapeFacts = {}): { shape: Shape; reasons: string[] } {
  const reasons: string[] = [];
  const must = c.criteria.filter((k) => k.priority === "must");
  if (must.length > CALIBRATION.maxMustCriteriaAtomic) reasons.push(`rule 1: ${must.length} must-criteria (more than ${CALIBRATION.maxMustCriteriaAtomic})`);
  const groups = new Set(must.map((k) => k.group).filter((g): g is string => !!g && g.trim().length > 0));
  if (groups.size >= 2 && must.every((k) => !!k.group)) reasons.push(`rule 2: ${groups.size} independent deliverables (${[...groups].sort().join(", ")})`);
  const tagged = (t: string) => must.filter((k) => k.tags.includes(t));
  if (tagged("migration").length > 0 && must.some((k) => k.type === "behavior" && !k.tags.includes("migration")))
    reasons.push("rule 3: a data migration and user-visible behaviour that depends on it");
  if (tagged("interface-change").length > 0 && must.some((k) => !k.tags.includes("interface-change")))
    reasons.push("rule 4: changes an interface accepted contracts depend on and adds new behaviour on top");
  if (f.budgetExhausted) reasons.push("rule 5: an atomic attempt exhausted its correction budget");
  return { shape: reasons.length ? "complex" : "atomic", reasons };
}

export const PlanTask = z
  .object({
    id: z.string(),
    purpose: z.string().trim().min(1),
    depends_on: z.array(z.string()).default([]),
    /** contract criterion / constraint ids fully provable when this task is merged */
    covers: z.array(z.string()).default([]),
    /** ids this task works towards but that are judged only on the integrated result */
    contributes: z.array(z.string()).default([]),
    scope_paths: z.array(z.string()).default([]),
    requires: z.array(z.string()).default([]),
    status: z.enum(["pending", "running", "done", "blocked", "dropped"]).default("pending"),
    evidence: z.array(z.string()).default([]),
  })
  .strict(); // no nested `tasks`, no criteria of its own: depth is one and a task is not a contract
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanBody = z
  .object({
    contract: z.string().regex(/^T[0-9]+$/),
    contract_version: z.number().int().min(1),
    contract_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    plan_version: z.number().int().min(1),
    shape: z.enum(["atomic", "complex"]),
    shape_reasons: z.array(z.string()).default([]),
    tasks: z.array(PlanTask).default([]),
    /** ids that can only be proven on the integrated result */
    integration: z.array(z.string()).default([]),
  })
  .strict();
export type PlanBody = z.infer<typeof PlanBody>;

/** Everything a plan may reference: must-criteria and constraints of the authoritative contract, by stable id. */
export function requirementIds(c: Contract): { required: string[]; all: string[] } {
  const required = [...c.criteria.filter((k) => k.priority === "must").map((k) => k.id), ...(c.constraints ?? []).map((x) => x.id)];
  const all = [...c.criteria.map((k) => k.id), ...(c.constraints ?? []).map((x) => x.id)];
  return { required, all };
}

/**
 * Plan validity, including the COVERAGE INVARIANT: every must-criterion and every constraint of the contract is covered by a task
 * or is integration-only with at least one contributing task. Checked by id - never by matching criterion text.
 */
export function validatePlan(c: Contract, contractSha256: string, raw: unknown): { ok: boolean; problems: string[]; plan?: PlanBody } {
  const problems: string[] = [];
  const parsed = PlanBody.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 20).map((i) => `schema: ${i.path.join(".") || "(root)"}: ${i.message}`) };
  const p = parsed.data;
  if (p.contract !== c.id) problems.push(`the plan belongs to ${p.contract}, not ${c.id}`);
  if (p.contract_version !== c.version) problems.push(`the plan is bound to contract version ${p.contract_version}, the contract is version ${c.version}`);
  if (p.contract_sha256 !== contractSha256) problems.push("the plan is not bound to this contract's hash");
  if (p.shape === "atomic") {
    if (p.tasks.length || p.integration.length) problems.push("an atomic plan has no tasks: the contract is built as one job");
    return { ok: problems.length === 0, problems, plan: p };
  }
  if (p.tasks.length < 2) problems.push("a decomposed plan needs at least two tasks");
  const { required, all } = requirementIds(c);
  const known = new Set(all);
  const ids = new Set<string>();
  for (const t of p.tasks) {
    if (!new RegExp(`^${c.id}\\.[a-z]$`).test(t.id)) problems.push(`${t.id}: task ids are ${c.id}.a … ${c.id}.z`);
    if (ids.has(t.id)) problems.push(`${t.id}: duplicate task id`);
    ids.add(t.id);
    for (const r of [...t.covers, ...t.contributes]) if (!known.has(r)) problems.push(`${t.id}: references ${r}, which is not a criterion or constraint of the contract`);
    if (t.covers.length + t.contributes.length === 0) problems.push(`${t.id}: a task must cover or contribute to at least one contract requirement`);
  }
  for (const t of p.tasks) for (const d of t.depends_on) if (!ids.has(d) || d === t.id) problems.push(`${t.id}: depends on unknown task ${d}`);
  if (hasCycle(p.tasks)) problems.push("task dependencies must not form a cycle");
  for (const r of p.integration) if (!known.has(r)) problems.push(`integration references ${r}, which is not a criterion or constraint of the contract`);
  const covered = new Set(p.tasks.filter((t) => t.status !== "dropped").flatMap((t) => t.covers));
  const contributed = new Set(p.tasks.filter((t) => t.status !== "dropped").flatMap((t) => t.contributes));
  const integration = new Set(p.integration);
  for (const r of required) {
    if (covered.has(r) && integration.has(r)) problems.push(`${r}: either covered by a task or integration-only, not both`);
    else if (covered.has(r)) continue;
    else if (integration.has(r)) {
      if (!contributed.has(r)) problems.push(`${r}: integration-only, but no task contributes to it`);
    } else problems.push(`${r}: not covered by any task and not marked integration-only (requirement would be lost)`);
  }
  return { ok: problems.length === 0, problems, plan: p };
}

function hasCycle(tasks: PlanTask[]): boolean {
  const deps = new Map(tasks.map((t) => [t.id, t.depends_on]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

export interface IntegratedVerification {
  /** true for every decomposed plan: all tasks passing is never sufficient */
  required: boolean;
  status: "not_required" | "pending" | "passed" | "failed";
  head?: string | null;
  /** the ORIGINAL contract the integrated result is judged against */
  contract_version?: number;
  contract_sha256?: string;
}

export function integratedRequirement(p: PlanBody): IntegratedVerification {
  return p.tasks.length > 0
    ? { required: true, status: "pending", head: null, contract_version: p.contract_version, contract_sha256: p.contract_sha256 }
    : { required: false, status: "not_required" };
}

/** Why a contract with this plan is NOT yet fulfilled (empty = nothing in the plan stands in the way). */
export function fulfilmentBlockers(p: PlanBody, iv: IntegratedVerification): string[] {
  if (p.tasks.length === 0) return [];
  const why: string[] = [];
  const open = p.tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
  if (open.length) why.push(`plan tasks not done: ${open.map((t) => t.id).join(", ")}`);
  if (iv.status !== "passed") why.push(`integrated verification against contract v${p.contract_version} is ${iv.status} (every task passing is not sufficient)`);
  return why;
}

/**
 * Which contract criteria the gate must require for a decomposed contract at a given point (mirror of gate/gate.py plan_scope; the
 * gate decides, this is for the control plane and tests). null = every criterion (no plan, atomic, or the integrated result).
 */
export function gateScope(p: Pick<PlanBody, "contract" | "tasks"> | null, entry: string | null, mergedEntries: string[], integrated: boolean): string[] | null {
  if (!p || p.tasks.length === 0 || integrated) return null;
  const by = new Map(p.tasks.map((t) => [t.id.split(".")[1]!, t]));
  if (entry !== null && !by.has(entry)) return null;
  const req = new Set<string>();
  for (const k of [...mergedEntries, ...(entry ? [entry] : [])]) for (const r of by.get(k)?.covers ?? []) req.add(r);
  return [...req].sort();
}

/** Canonical bytes of the plan file the gate reads from the repository (tasks/<T>/plan.json; only decomposed plans are committed). */
export function planFile(p: PlanBody): string {
  return (
    JSON.stringify({ contract: p.contract, contract_version: p.contract_version, contract_sha256: p.contract_sha256, plan_version: p.plan_version, tasks: p.tasks.map((t) => ({ id: t.id, covers: [...t.covers].sort(), contributes: [...t.contributes].sort(), depends_on: [...t.depends_on].sort() })), integration: [...p.integration].sort() }, null, 1) + "\n"
  );
}

/*
 * Partially merged work after a contract is abandoned or revised (section 10). This is the POLICY as a pure function over facts the
 * control plane establishes from the contract, repository state, evidence and deterministic checks. Executing a revert belongs to
 * the Decision phase; nothing here changes a repository.
 */
export interface PartialMergeFacts {
  /** every merged task fully covers its criteria (nothing merged only "contributes") */
  mergedTasksSelfContained: boolean | null;
  /** main passes the project suite and every accepted check */
  mainHealthy: boolean | null;
  /** merged work contradicts the revised contract (false when abandoned with no revision) */
  conflictsWithRevisedContract: boolean | null;
  /** merged work exists only to support the abandoned outcome */
  onlyServesAbandonedOutcome: boolean | null;
  /** a revert of the merged work passes the gate */
  revertPassesGate: boolean | null;
  /** later accepted work depends on the merged work */
  laterWorkDependsOnIt: boolean | null;
}
export type PartialMergeDecision = { decision: "KEEP" | "REVERT" | "NEEDS_OWNER"; reasons: string[] };

export function partialMergeDecision(f: PartialMergeFacts): PartialMergeDecision {
  const unknown = (["mergedTasksSelfContained", "mainHealthy", "conflictsWithRevisedContract", "onlyServesAbandonedOutcome"] as const).filter((k) => f[k] === null);
  if (unknown.length) return { decision: "NEEDS_OWNER", reasons: unknown.map((k) => `cannot be established: ${k}`) };
  const bad: string[] = [];
  if (!f.mergedTasksSelfContained) bad.push("a requirement is left half-delivered");
  if (!f.mainHealthy) bad.push("main is not healthy");
  if (f.conflictsWithRevisedContract) bad.push("conflicts with the revised contract");
  if (f.onlyServesAbandonedOutcome) bad.push("exists only for the abandoned outcome");
  if (bad.length === 0) return { decision: "KEEP", reasons: ["independently valid; main healthy; consistent with the contract"] };
  if (f.laterWorkDependsOnIt === false && f.revertPassesGate === true) return { decision: "REVERT", reasons: bad };
  return { decision: "NEEDS_OWNER", reasons: [...bad, f.laterWorkDependsOnIt ? "later accepted work depends on it" : "a safe revert could not be established"] };
}
