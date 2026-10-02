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

export interface BlockFacts {
  /** worker's own classification in BLOCKED.json ("routine" = reversible engineering choice inside the approved intent) */
  cls: unknown;
  recommendation: string | null;
  options: { id: string; label: string }[];
  taskTier: "standard" | "critical";
  text: string;
}

const OWNER_WORDS = /\b(secret|credential|token|password|permission|access|delete|irreversible|payment|billing|price|legal|privacy|personal data|security|authori[sz]|scope|architecture)\b/i;

/** The option to select automatically for a worker's routine question, or null when the owner must decide. */
export function routineChoice(f: BlockFacts): string | null {
  if (f.cls !== "routine" || !f.recommendation || f.taskTier === "critical") return null;
  if (OWNER_WORDS.test(f.text)) return null;
  const rec = f.recommendation.trim().toLowerCase();
  const hit = f.options.filter((o) => o.id !== "abandon" && (o.label.trim().toLowerCase() === rec || o.id === rec));
  return hit.length === 1 ? hit[0]!.id : null;
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
