import type { Contract } from "./contract";

/*
 * V1 owner-escalation policy. The owner is asked ONLY for:
 *   A a new product decision            B a trust-boundary / security change      C an unavoidable authorization or credential
 *   D an irreversible / high-impact act E an unresolved Critical/High issue       F a genuine blocker the system cannot repair
 *   G final acceptance of the result
 * Everything else is decided mechanically here and recorded as a decision row with decidedVia "policy" (the audit trail).
 * All functions are pure and deterministic: no AI call decides whether the owner is needed.
 */

const SENSITIVE_TAGS = ["authz", "data-loss", "money", "pii", "security", "secret", "credential", "permission"];
const PROTECTED_SCOPE = /^(\.github|gate|oracle|tasks|baselines)(\/|$)|^(CODEOWNERS|policy\.json)$/;

export interface ContractFacts {
  taskTier: "standard" | "critical";
  body: Contract;
  lintOk: boolean;
  /** problems the oracle still had when it was offered (empty when it passed syntax, static validation and calibration) */
  oracleProblems: string[];
  calibrated: boolean;
}

/** Reasons a generated contract needs the owner. Empty = it stays within the recorded intent and is approved automatically. */
export function contractEscalation(f: ContractFacts): string[] {
  const why: string[] = [];
  if (!f.lintOk) why.push("the contract is not lint-clean");
  if (f.taskTier === "critical" || f.body.tier === "critical") why.push("critical tier (security / trust-sensitive work)");
  const tags = [...new Set(f.body.criteria.flatMap((k) => k.tags ?? []).filter((t) => SENSITIVE_TAGS.includes(t)))];
  if (tags.length) why.push(`criteria touch a trust boundary (${tags.join(", ")})`);
  const prot = (f.body.scope?.paths ?? []).filter((p) => PROTECTED_SCOPE.test(p.replace(/^\.?\//, "")));
  if (prot.length) why.push(`scope includes enforcement paths (${prot.join(", ")})`);
  if ((f.body.open_questions ?? []).length) why.push("the contract has open questions");
  if (f.oracleProblems.length) why.push("the acceptance check could not be fully validated");
  if (!f.calibrated) why.push("the acceptance check was not calibrated against main");
  return why;
}

export interface DecisionOption {
  id: string;
  label: string;
  consequence: string;
  /** "abandon": choosing this option ends the task (same effect as the built-in abandon) */
  action?: "abandon";
}

export interface DecisionFacts {
  kind: string;
  stage: string;
  recommendation: string | null | undefined;
  options: DecisionOption[];
  /** the worker's own label in BLOCKED.json; only "routine" can make a worker question automatic, and never on its own */
  cls: unknown;
  taskTier: "standard" | "critical";
  /** a PR / built head exists: abandoning would discard work */
  hasWork: boolean;
  text: string;
}

const OWNER_WORDS = /\b(secret|credential|token|password|permission|access|delete|irreversible|payment|billing|price|legal|privacy|personal data|security|authori[sz]|scope|architecture)\b/i;
const OWNER_STAGES = ["security", "tamper", "access", "evidence", "budget"];

export const isAbandon = (o: DecisionOption) => o.id === "abandon" || o.action === "abandon";

/**
 * THE decision rule of the control system: RECOMMENDED = AUTO-APPROVE.
 * A decision either has exactly one recommended action that the control system may take itself - then it is taken, recorded as a
 * control-system decision and the workflow continues - or it NEEDS YOU and is shown to the owner WITHOUT any recommended option.
 * There is no third state: a recommended option never waits for a click.
 * Whether the owner is needed is decided here, mechanically, from what the decision is - never from the fact that somebody
 * labelled an option "recommended". So a dangerous, major, irreversible, security/permission/credential or ambiguous decision cannot
 * be turned into an automatic one by recommending an option.
 */
export function classifyDecision(f: DecisionFacts): { auto: string; basis: string } | { auto: null; needsOwner: string[] } {
  const owner = (...why: string[]) => ({ auto: null, needsOwner: why });
  if (!f.recommendation) return owner("no recommended action: a real choice");
  const rec = f.recommendation.trim().toLowerCase();
  const hits = f.options.filter((o) => o.id.toLowerCase() === rec || o.label.trim().toLowerCase() === rec);
  if (hits.length !== 1) return owner("the recommendation does not name exactly one option");
  const hit = hits[0]!;
  if (f.kind !== "block") return owner(`${f.kind.replaceAll("_", " ")} is an owner authority`);
  if (OWNER_STAGES.includes(f.stage)) return owner(`${f.stage} stop`);
  if (f.taskTier === "critical") return owner("critical tier (security / trust-sensitive work)");
  if (isAbandon(hit) && f.hasWork) return owner("abandoning would discard existing work (major / not reversible)");
  // ending a task is automatic only when it is the single path left (no alternative to choose between) and nothing was built
  if (isAbandon(hit) && f.options.every(isAbandon)) {
    return { auto: hit.id, basis: "Recommended action: end the task. Nothing has been built, so nothing is lost and the intent can be filed again." };
  }
  if (f.cls !== "routine") return owner("a product / owner-level question (not a routine engineering choice)");
  const m = OWNER_WORDS.exec(`${f.text} ${hit.label} ${hit.consequence}`);
  if (m) return owner(`touches an owner-level matter (${m[0].toLowerCase()})`);
  return { auto: hit.id, basis: "Recommended routine, reversible choice inside the approved intent." };
}

/** Self-recovery: automatic retries of a failed step before a person is asked (delays in seconds, by attempt). */
export const RECOVERY_DELAYS_S = [120, 900];
export function recoveryDelay(previousAutoRetries: number): number | null {
  return previousAutoRetries < RECOVERY_DELAYS_S.length ? RECOVERY_DELAYS_S[previousAutoRetries]! : null;
}

/** Which optional AI verification runs for a tier (token policy: deterministic gate evidence always runs; AI depth only where the tier needs it). */
export function verificationPlan(tier: "standard" | "critical") {
  return {
    independentVerifier: true,
    /** oracle mutation test: an extra Builder-slot session + previews; critical tier only */
    mutation: tier === "critical",
    /** a Verifier that could not run leaves Unknown: it blocks only where the tier requires independent evidence */
    unknownBlocks: tier === "critical",
  };
}
