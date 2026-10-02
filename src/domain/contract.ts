import { createHash } from "node:crypto";
import { z } from "zod";

/*
 * Typed acceptance contract (Architecture Baseline v0.1 section 7), in the JSON shape the project gate already enforces
 * (tasks/<T>/contract.json). Four criterion types; security/operational concerns are tags.
 */

const Text = z.string().trim().min(1);

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
  })
  .loose();
export type Criterion = z.infer<typeof Criterion>;

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
  })
  .loose();
export type Contract = z.infer<typeof Contract>;

export interface LintResult {
  ok: boolean;
  problems: string[];
}

/** Deterministic contract lint (section 7). A contract that fails lint can never be offered for approval. */
export function lintContract(raw: unknown, expect: { id: string; tier: "standard" | "critical" }): LintResult {
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
    if (k.priority === "must" && (k.type === "experience" || k.type === "structural"))
      problems.push(
        `${k.id}: the V0 gate verifies must-criteria of type behavior/threshold only; make it "should" or express it as behavior`,
      );
  if (c.open_questions.length > 0) problems.push("open_questions must be empty before approval");
  return { ok: problems.length === 0, problems };
}

const nonEmpty = (s: string | undefined) => typeof s === "string" && s.trim().length > 0;

/** Canonical bytes committed to tasks/<T>/contract.json (stable key order, 1-space indent, trailing newline). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 1) + "\n";
}
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
