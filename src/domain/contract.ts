import { createHash } from "node:crypto";
import { z } from "zod";

/*
 * Typed acceptance contract (Architecture Baseline v0.1 section 7), in the JSON shape the project gate already enforces
 * (tasks/<T>/contract.json). Four criterion types; security/operational concerns are tags.
 */

const Text = z.string().trim().min(1);

export const VERIFY_CLASSES = ["blackbox", "measure", "static", "suite", "judgment"] as const;
export type VerifyClass = (typeof VERIFY_CLASSES)[number];
export const TRACE_SOURCES = ["intent", "policy", "project", "necessary"] as const;

/** Where a requirement comes from (Contract spec v2, section 4). Exactly one source; never the drafter's own idea. */
export const Trace = z.object({ source: z.enum(TRACE_SOURCES), ref: Text }).loose();
export type Trace = z.infer<typeof Trace>;

export const Criterion = z
  .object({
    id: z.string().regex(/^AC[0-9]+$/),
    type: z.enum(["behavior", "threshold", "experience", "structural"]),
    priority: z.enum(["must", "should"]),
    tags: z.array(z.string()).default([]),
    given: z.string().optional(),
    when: z.string().optional(),
    then: z.string().optional(),
    metric: z.string().optional(),
    target: z.string().optional(),
    conditions: z.string().optional(),
    statement: z.string().optional(),
    refs: z.array(z.string()).optional(),
    rule: z.string().optional(),
    check: z.string().optional(),
    /** v2: the class of proof this criterion needs - never a tool name (section 5) */
    verify: z.enum(VERIFY_CLASSES).optional(),
    /** v2: what evidence a judgment-class criterion requires */
    evidence: z.string().optional(),
    /** v2: optional deliverable group, used only by the plan's shape rules */
    group: z.string().optional(),
    trace: Trace.optional(),
  })
  .loose();
export type Criterion = z.infer<typeof Criterion>;

export const CONSTRAINT_KINDS = ["compatibility", "security", "privacy", "interface", "prohibited", "regression", "design"] as const;
export const Constraint = z
  .object({ id: z.string().regex(/^C[0-9]+$/), kind: z.enum(CONSTRAINT_KINDS), statement: Text, verify: z.enum(VERIFY_CLASSES), trace: Trace })
  .loose();
export type Constraint = z.infer<typeof Constraint>;

export const Assumption = z
  .object({
    id: z.string().regex(/^A[0-9]+$/),
    question: Text,
    chosen: Text,
    basis: z.enum(["existing behaviour", "stated intent", "policy"]),
    reversible: z.boolean(),
  })
  .loose();
export type Assumption = z.infer<typeof Assumption>;

export const Contract = z
  .object({
    id: z.string().regex(/^T[0-9]+$/),
    title: Text,
    traces_to: z.array(z.string()).default([]),
    tier: z.enum(["standard", "critical"]),
    scope: z.object({ summary: Text, paths: z.array(Text).min(1) }).loose(),
    non_goals: z.array(z.string()).default([]),
    open_questions: z.array(z.string()).default([]),
    interface: z.record(z.string(), z.unknown()).optional(),
    criteria: z.array(Criterion).min(1),
    canary_routes: z.array(z.string()).default(["/"]),
    version: z.number().int().min(1),
    // v2 additions: optional on read (every V1 contract stays valid), required on write (lintContract with `v2`)
    intent_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    policies: z.array(Text).optional(),
    constraints: z.array(Constraint).optional(),
    assumptions: z.array(Assumption).optional(),
  })
  .loose();
export type Contract = z.infer<typeof Contract>;

/** What a newly written contract is checked against (v2). Absent = legacy read of an existing V1 contract. */
export interface V2Context {
  /** the owner's recorded intent text (title + intent), the source of `intent_sha256` and of intent traces */
  intent: string;
  /** bodies of every earlier version of this contract, oldest first (criterion ids are stable across versions) */
  previous?: unknown[];
}

/** Verification classes a criterion type may use. The Contract names a class of proof; the tool is bound downstream. */
export const VERIFY_FOR: Record<Criterion["type"], readonly VerifyClass[]> = {
  behavior: ["blackbox"],
  threshold: ["measure", "blackbox"],
  structural: ["static"],
  experience: ["judgment"],
};

/**
 * Must-criteria the CURRENT gate can prove. structural/experience musts are representable (verify static / judgment + evidence) but
 * stay disabled until the Gate phase provides their verification paths: nothing is weakened to enable them early.
 */
export const GATED_MUST_TYPES: readonly Criterion["type"][] = ["behavior", "threshold"];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export const intentHash = (intent: string) => sha256(intent);

export interface LintResult {
  ok: boolean;
  problems: string[];
}

/** Deterministic contract lint (section 7). A contract that fails lint can never be offered for approval. */
export function lintContract(raw: unknown, expect: { id: string; tier: "standard" | "critical" }, v2?: V2Context): LintResult {
  const problems: string[] = [];
  const parsed = Contract.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) problems.push(`schema: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return { ok: false, problems };
  }
  const c = parsed.data;
  if (c.id !== expect.id) problems.push(`id must be ${expect.id}`);
  const tier = c.criteria.some((x) => x.tags.some((t) => ["authz", "data-loss", "money", "pii"].includes(t))) ? "critical" : c.tier;
  if (tier !== c.tier) problems.push("criteria tagged authz/data-loss/money/pii require tier \"critical\"");
  if (expect.tier === "critical" && c.tier !== "critical") problems.push("the owner requested the critical tier");
  const ids = new Set<string>();
  for (const k of c.criteria) {
    if (ids.has(k.id)) problems.push(`${k.id}: duplicate id`);
    ids.add(k.id);
    if (k.type === "behavior" && !(nonEmpty(k.given) && nonEmpty(k.when) && nonEmpty(k.then)))
      problems.push(`${k.id}: behavior criteria need given/when/then`);
    if (k.type === "threshold" && !/[0-9]/.test(`${k.target ?? ""}${k.then ?? ""}`))
      problems.push(`${k.id}: threshold criteria need a numeric target`);
    if (k.type === "experience" && !(k.refs && k.refs.length > 0)) problems.push(`${k.id}: experience criteria need at least one reference`);
    if (k.type === "structural" && !nonEmpty(k.check)) problems.push(`${k.id}: structural criteria must name a check (or "review-only")`);
  }
  if (!c.criteria.some((k) => k.priority === "must")) problems.push("at least one must-criterion is required");
  for (const k of c.criteria)
    if (k.priority === "must" && !GATED_MUST_TYPES.includes(k.type))
      problems.push(
        `${k.id}: the V0 gate verifies must-criteria of type behavior/threshold only; make it "should" or express it as behavior`,
      );
  if (c.open_questions.length > 0) problems.push("open_questions must be empty before approval");
  if (v2) problems.push(...lintV2(c, v2));
  return { ok: problems.length === 0, problems };
}

/** Contract spec v2 rules for a contract being WRITTEN: traceability, verification class, assumptions, constraints, stable ids. */
function lintV2(c: Contract, ctx: V2Context): string[] {
  const problems: string[] = [];
  const intent = norm(ctx.intent);
  if (c.intent_sha256 !== intentHash(ctx.intent)) problems.push("intent_sha256 must be the hash of the recorded owner intent");
  const policies = c.policies ?? [];
  if (policies.length === 0) problems.push("policies must reference the applicable policies by id (references, never copies)");
  const acIds = new Set(c.criteria.map((k) => k.id));
  const trace = (id: string, t: Trace | undefined) => {
    if (!t) return problems.push(`${id}: trace is required (intent | policy | project | necessary) - a requirement without a source is not allowed`);
    if (t.source === "intent" && (norm(t.ref).length < 8 || !intent.includes(norm(t.ref))))
      problems.push(`${id}: an intent trace must quote the owner's intent verbatim (at least 8 characters of it)`);
    if (t.source === "policy" && !policies.some((p) => t.ref === p || t.ref.startsWith(`${p}:`) || t.ref.startsWith(`${p} `)))
      problems.push(`${id}: a policy trace must name one of the referenced policies (${policies.join(", ") || "none"})`);
    if (t.source === "necessary") {
      const served = [...t.ref.matchAll(/\bAC[0-9]+\b/g)].map((m) => m[0]).filter((x) => x !== id);
      if (served.length === 0 || !served.every((x) => acIds.has(x))) problems.push(`${id}: a "necessary" trace must name the existing criterion it is required for (and why)`);
    }
    return 0;
  };
  for (const k of c.criteria) {
    trace(k.id, k.trace);
    if (k.priority === "must" && !k.verify) problems.push(`${k.id}: a must-criterion needs a verification class (verify)`);
    if (k.verify && !VERIFY_FOR[k.type].includes(k.verify)) problems.push(`${k.id}: verify "${k.verify}" does not fit type ${k.type} (allowed: ${VERIFY_FOR[k.type].join(", ")})`);
    if (k.verify === "judgment" && !nonEmpty(k.evidence)) problems.push(`${k.id}: a judgment-class criterion must state its evidence requirement`);
    if (k.type === "experience" && ((nonEmpty(k.given) && nonEmpty(k.when) && nonEmpty(k.then)) || /[0-9]/.test(k.target ?? "")))
      problems.push(`${k.id}: this is ordinary behaviour or a threshold; do not label it "experience"`);
  }
  const ids = new Set<string>();
  for (const x of c.constraints ?? []) {
    if (ids.has(x.id)) problems.push(`${x.id}: duplicate id`);
    ids.add(x.id);
    trace(x.id, x.trace);
  }
  const aids = new Set<string>();
  for (const a of c.assumptions ?? []) {
    if (aids.has(a.id)) problems.push(`${a.id}: duplicate id`);
    aids.add(a.id);
  }
  problems.push(...stableIdProblems(ctx.previous ?? [], c));
  return problems;
}

/**
 * Criterion and constraint ids are stable for the life of a contract: an id keeps its requirement (same type / kind) and an id that
 * was retired in an earlier version never comes back for something else.
 */
export function stableIdProblems(previous: unknown[], next: Contract): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  let last = new Set<string>();
  const retired = new Set<string>();
  for (const raw of previous) {
    const p = Contract.safeParse(raw);
    if (!p.success) continue;
    const now = new Map<string, string>([...p.data.criteria.map((k) => [k.id, k.type] as const), ...(p.data.constraints ?? []).map((x) => [x.id, x.kind] as const)]);
    for (const id of last) if (!now.has(id)) retired.add(id);
    for (const [id, t] of now) seen.set(id, t);
    last = new Set(now.keys());
  }
  const now = new Map<string, string>([...next.criteria.map((k) => [k.id, k.type] as const), ...(next.constraints ?? []).map((x) => [x.id, x.kind] as const)]);
  for (const [id, t] of now) {
    if (retired.has(id)) problems.push(`${id}: this id was retired in an earlier version and may not be reused`);
    else if (seen.has(id) && seen.get(id) !== t) problems.push(`${id}: an existing id may not change into a different requirement (${seen.get(id)} -> ${t}); use a new id`);
  }
  return problems;
}

/** The parts of a contract that define the required outcome (everything except lineage, traces and recorded assumptions). */
export function outcomeOf(c: Contract) {
  // traces (lineage) and groups (a planning hint) are not part of the outcome
  const strip = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "trace" && k !== "group"));
  return sortKeysDeep({
    tier: c.tier,
    scope: c.scope,
    non_goals: c.non_goals,
    interface: c.interface ?? null,
    criteria: c.criteria.map(strip),
    constraints: (c.constraints ?? []).map(strip),
    canary_routes: c.canary_routes,
  });
}

/** Did the REQUIRED OUTCOME change between two versions? (Approval authority depends on it; the version number does not.) */
export function outcomeChanged(prev: Contract, next: Contract): boolean {
  return JSON.stringify(outcomeOf(prev)) !== JSON.stringify(outcomeOf(next));
}

/** The database row is a cache of the committed bytes: it must reproduce them exactly. */
export function contractIntegrity(row: { body: unknown; text: string; sha256: string }): string[] {
  const problems: string[] = [];
  if (sha256(row.text) !== row.sha256) problems.push("stored sha256 is not the hash of the stored contract bytes");
  if (canonicalJson(row.body) !== row.text) problems.push("stored body does not reproduce the stored contract bytes");
  return problems;
}

const nonEmpty = (s: string | undefined) => typeof s === "string" && s.trim().length > 0;

/** Canonical bytes committed to tasks/<T>/contract.json (stable key order, 1-space indent, trailing newline). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 1) + "\n";
}
const sortKeysDeep = (v: unknown) => sortKeys(v);
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The must-criteria that the gate maps to the oracle of record (behavior and threshold: black-box checkable). */
export function oracleCriteria(c: Contract): string[] {
  return c.criteria.filter((k) => k.priority === "must" && (k.type === "behavior" || k.type === "threshold")).map((k) => k.id);
}
