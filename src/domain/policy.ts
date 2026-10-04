import type { Contract } from "./contract";
import { CALIBRATION } from "./plan";

/*
 * V1 owner-escalation policy. The owner is asked ONLY for:
 *   A a new product decision            B a trust-boundary / security change      C an unavoidable authorization or credential
 *   D an irreversible / high-impact act E an unresolved Critical/High issue       F a genuine blocker the system cannot repair
 *   G final acceptance of the result
 * Routine operations (ROUTINE_OPERATIONS, self-recovery, a contract revision that leaves the required outcome unchanged) are decided
 * mechanically and recorded as a decision row with decidedVia "policy" (the audit trail). A contract that SETS or CHANGES the
 * required outcome is always the Owner's to approve (SEC-TB-01): its text is written by a worker and is never its own authority.
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

/**
 * What the Owner should know when approving a generated contract (shown with the approval). A contract that sets or changes the
 * required outcome ALWAYS needs the Owner - whatever this returns: these are additional reasons, never the test for asking.
 */
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
  // v2: routine ambiguity is resolved and recorded; too much of it, or anything not reversible, is the owner's (calibration values)
  const assumptions = f.body.assumptions ?? [];
  if (assumptions.length > CALIBRATION.maxAssumptions) why.push(`${assumptions.length} assumptions were needed (more than ${CALIBRATION.maxAssumptions})`);
  const irreversible = assumptions.filter((a) => a.reversible === false).map((a) => a.id);
  if (irreversible.length) why.push(`assumptions that are not reversible (${irreversible.join(", ")})`);
  // v2 drafter-inflation guard: requirements the owner did not state ("necessary") may not dominate the contract
  const must = f.body.criteria.filter((k) => k.priority === "must");
  const necessary = must.filter((k) => k.trace?.source === "necessary");
  if (must.length > 0 && necessary.length / must.length > CALIBRATION.maxNecessaryShare)
    why.push(`${necessary.length} of ${must.length} must-criteria were added by the drafter as "necessary" (more than a third)`);
  return why;
}

export interface DecisionOption {
  id: string;
  label: string;
  consequence: string;
  /** "abandon": choosing this option ends the task (same effect as the built-in abandon) */
  action?: "abandon";
}

/**
 * Routine operations the control system may decide itself. THIS LIST IS THE ONLY SOURCE OF THAT AUTHORITY (SEC-TB-01): each entry is
 * an operation whose meaning is defined by control-plane code, is reversible, and changes neither the contract nor the product.
 * Nothing a worker writes - a class label, a recommendation, an option, a tag, a trace or any wording - can add to it or select
 * from it: the operation of a decision is set by the control-plane code that raises it, never read from a worker's file.
 */
export const ROUTINE_OPERATIONS = {
  /** End a task for which nothing was built and no other path is offered: nothing is lost; the intent can be filed again. */
  end_unbuilt_task: "Recommended action: end the task. Nothing has been built, so nothing is lost and the intent can be filed again.",
} as const;
export type RoutineOperation = keyof typeof ROUTINE_OPERATIONS;

export interface DecisionFacts {
  kind: string;
  stage: string;
  recommendation: string | null | undefined;
  options: DecisionOption[];
  /**
   * The routine operation this decision is, when the control-plane code raising it declares one. Absent for every decision that
   * comes from a worker's BLOCKED.json: answering such a block rewrites the contract, which only the Owner may authorize.
   */
  operation?: RoutineOperation | null;
  taskTier: "standard" | "critical";
  /** a PR / built head exists: abandoning would discard work */
  hasWork: boolean;
}

const OWNER_STAGES = ["security", "tamper", "access", "evidence", "budget"];

export const isAbandon = (o: DecisionOption) => o.id === "abandon" || o.action === "abandon";

/**
 * THE decision rule of the control system: RECOMMENDED = AUTO-APPROVE - for routine operations only.
 * A decision either IS one of the ROUTINE_OPERATIONS, with exactly one recommended action - then it is taken, recorded as a
 * control-system decision and the workflow continues - or it NEEDS YOU and is shown to the owner WITHOUT any recommended option.
 *
 * Security invariant (SEC-TB-01): whether the Owner is needed is decided from facts the control plane owns - the decision kind, the
 * stage, the task tier, whether work exists, the shape of the option list, and the declared routine operation. No worker-controlled
 * field is authority: not "class", not the recommendation, not option labels or consequences, not the title or reason. A worker
 * may DESCRIBE a blocker; it can never AUTHORIZE its own answer. In particular there is no wording test here: text is not evidence.
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
  // end_unbuilt_task is recognised from the SHAPE of the decision (the single path left ends the task; nothing was built) - the
  // control plane builds the option list and knows whether work exists. It is the only thing a worker's block can lead to unasked.
  if (isAbandon(hit) && f.options.every(isAbandon)) return { auto: hit.id, basis: ROUTINE_OPERATIONS.end_unbuilt_task };
  if (f.operation && Object.hasOwn(ROUTINE_OPERATIONS, f.operation) && !isAbandon(hit)) return { auto: hit.id, basis: ROUTINE_OPERATIONS[f.operation] };
  return owner("answering this changes the contract or the product (meaning, scope, requirements, behaviour, access, data, security): only the Owner decides");
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
