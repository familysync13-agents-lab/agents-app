import type { TaskState } from "@/db/schema";

/*
 * Read model of the Operations Interface: where each task is in the operational flow
 *   OWNER -> CONTRACT -> BUILDER -> EVIDENCE -> GATE -> VERIFIER -> DECISION
 * derived ONLY from authoritative state (task state + control-loop step + running worker sessions + recorded evidence). Nothing here
 * is estimated or animated for its own sake; the UI animates a node only when these functions say it is active.
 */
export const NODES = ["owner", "contract", "builder", "evidence", "gate", "verifier", "decision"] as const;
export type FlowNode = (typeof NODES)[number];

export const NODE_LABEL: Record<FlowNode, string> = {
  owner: "Owner",
  contract: "Contract",
  builder: "Builder",
  evidence: "Evidence",
  gate: "Gate",
  verifier: "Verifier",
  decision: "Decision",
};

export const NODE_HELP: Record<FlowNode, string> = {
  owner: "Intent, clarifications, reviews and final acceptance - the owner's decision rights",
  contract: "Contract drafted from the intent; acceptance checks written blind and calibrated",
  builder: "Isolated Builder session implementing or correcting the work",
  evidence: "Structured outcome files and the exported change, bound to a commit",
  gate: "The repository gate: required check on the exact commit",
  verifier: "Independent verification, failure attribution and the oracle mutation test",
  decision: "DONE from evidence, then the owner's acceptance and merge",
};

const STEP_NODE: Record<string, FlowNode> = {
  draft_contract: "contract",
  draft_start: "contract",
  draft_poll: "contract",
  draft_collect: "contract",
  oracle_start: "contract",
  oracle_poll: "contract",
  oracle_collect: "contract",
  oracle_calibrate: "contract",
  await_owner_contract: "owner",
  contract_pr: "contract",
  await_github_contract: "owner",
  contract_merge: "gate",
  build_start: "builder",
  build_poll: "builder",
  build_collect: "evidence",
  ship: "evidence",
  await_gate: "gate",
  gate_collect: "gate",
  regate: "gate",
  sync_branch: "gate",
  regress_start: "verifier",
  regress_poll: "verifier",
  regress_pr: "owner",
  resume_after_oracle: "gate",
  fix_start: "builder",
  attribute_start: "verifier",
  attribute_poll: "verifier",
  attribute_collect: "verifier",
  acceptance_start: "verifier",
  acceptance_poll: "verifier",
  acceptance_collect: "verifier",
  mutation_start: "verifier",
  mutation_poll: "verifier",
  mutant_eval: "verifier",
  mark_done: "decision",
  await_stack: "owner",
  await_access: "owner",
  self_recover: "gate",
  await_quota: "builder",
  plan_start: "contract",
  plan_poll: "contract",
  plan_collect: "contract",
  plan_pr: "contract",
  plan_merge: "gate",
  plan_task_done: "gate",
  restack: "gate",
  contract_batch: "contract",
  batch_wait: "contract",
  await_acceptance: "owner",
  cleanup: "decision",
  await_decision: "owner",
  done: "decision",
};

export interface TaskLike {
  state: TaskState;
  step: string;
  stepData?: Record<string, unknown> | null;
  pausedAt?: Date | null;
}

/** The node a task currently occupies. Oracle repair is shown at the Verifier (it is the Verifier's work, not the Builder's). */
export function nodeOf(t: TaskLike): FlowNode {
  if (t.state === "ACCEPTED" || t.state === "REJECTED" || t.state === "ABANDONED") return "decision";
  if ((t.state === "BLOCKED_DECISION" || t.state === "BLOCKED_EVIDENCE") && t.step === "await_decision") return "owner";
  const d = t.stepData ?? {};
  if (d.mode === "repair" && t.step.startsWith("oracle_")) return "verifier";
  return STEP_NODE[t.step] ?? "decision";
}

export type Party = "implementation" | "oracle" | "environment" | "ambiguity" | "security";
export const PARTY: Record<Party, { label: string; owner: string; tone: "builder" | "verifier" | "gate" | "owner" | "bad" }> = {
  implementation: { label: "Implementation defect", owner: "Builder", tone: "builder" },
  oracle: { label: "Check (oracle) defect", owner: "Verifier", tone: "verifier" },
  environment: { label: "Environment / infrastructure", owner: "Control system", tone: "gate" },
  ambiguity: { label: "Product ambiguity", owner: "You", tone: "owner" },
  security: { label: "Security / trust stop", owner: "You", tone: "bad" },
};

/**
 * What the control system is doing about a failure right now (null when nothing failed on the current path). Derived from the step
 * the control loop is executing - so it is exactly what will happen next, not a guess.
 */
export function failureRouting(t: TaskLike, corrections: number): { party: Party; selfCorrecting: boolean; text: string } | null {
  const d = t.stepData ?? {};
  if (t.step.startsWith("oracle_") && d.mode === "repair")
    return { party: "oracle", selfCorrecting: true, text: "The acceptance check was defective - the Verifier is repairing it; the Builder's work is kept" };
  if (t.step === "contract_pr" || t.step === "await_github_contract" || t.step === "contract_merge") {
    if (d.resume) return { party: "oracle", selfCorrecting: false, text: "Repaired check awaits your approval on GitHub (the contract is unchanged)" };
    return null;
  }
  if (t.step === "regress_start" || t.step === "regress_poll") return { party: "oracle", selfCorrecting: true, text: "An earlier task's check is stale against the new approved contract - the Verifier is updating it; the Builder's work is kept" };
  if (t.step === "regress_pr") return { party: "oracle", selfCorrecting: false, text: "Updated earlier checks await your approval on GitHub" };
  if (t.step === "resume_after_oracle") return { party: "oracle", selfCorrecting: true, text: "Re-checking the kept work against the repaired check" };
  if (t.step.startsWith("attribute_")) return { party: "implementation", selfCorrecting: true, text: "An independent arbiter is reproducing the failure to decide who owns it" };
  if (t.step === "regate") return { party: "environment", selfCorrecting: true, text: "Environment failure - the gate is re-run (not charged to the work)" };
  if (t.step === "fix_start" || (t.state === "IN_PROGRESS" && corrections > 0 && (t.step === "build_poll" || t.step === "build_collect")))
    return { party: "implementation", selfCorrecting: true, text: `The Builder is correcting its work (correction ${corrections})` };
  if (t.step === "self_recover") return { party: "environment", selfCorrecting: true, text: "A step failed - the control system repeats it by itself (no action needed)" };
  if (t.step === "await_access") return { party: "security", selfCorrecting: false, text: "A GitHub permission only you can grant; the system resumes by itself once it exists" };
  if (t.state === "BLOCKED_EVIDENCE") return { party: "environment", selfCorrecting: false, text: "Evidence unavailable - your decision is needed" };
  if (t.state === "BLOCKED_DECISION") return { party: "ambiguity", selfCorrecting: false, text: "A decision only you can make" };
  return null;
}

/** Node transitions for an edge animation: which edge a state transition travels along. */
export function edgeOfTransition(from: TaskState | null, to: TaskState): [FlowNode, FlowNode] | null {
  const pairs: Record<string, [FlowNode, FlowNode]> = {
    "null>PROPOSED": ["owner", "contract"],
    "PROPOSED>CONTRACTED": ["owner", "contract"],
    "CONTRACTED>IN_PROGRESS": ["contract", "builder"],
    "IN_PROGRESS>VERIFYING": ["evidence", "gate"],
    "VERIFYING>IN_PROGRESS": ["gate", "builder"],
    "VERIFYING>DONE": ["verifier", "decision"],
    "DONE>ACCEPTED": ["owner", "decision"],
  };
  const k = `${from ?? "null"}>${to}`;
  if (pairs[k]) return pairs[k]!;
  if (to === "BLOCKED_DECISION" || to === "BLOCKED_EVIDENCE") return ["gate", "owner"];
  return null;
}

const PURPOSE_NODE: Record<string, FlowNode> = {
  draft_contract: "contract",
  author_oracle: "contract",
  repair_oracle: "verifier",
  build: "builder",
  correction: "builder",
  acceptance_check: "verifier",
  attribution: "verifier",
  mutants: "verifier",
  plan: "contract",
};

export interface FlowInputs {
  live: (TaskLike & { id: number; corrections: number })[];
  running: { taskId: number; purpose: string }[];
  openDecisions: number;
  recentTransitions: { fromState: TaskState | null; toState: TaskState }[];
  accepted: number;
}

/** The whole flow instrument's state from authoritative records (see FlowMap). */
export function flowState(i: FlowInputs) {
  const counts = Object.fromEntries(NODES.map((n) => [n, 0])) as Record<FlowNode, number>;
  for (const t of i.live) counts[nodeOf(t)]++;
  const active: Partial<Record<FlowNode, boolean>> = {};
  for (const r of i.running) {
    const n = PURPOSE_NODE[r.purpose];
    if (n) active[n] = true;
  }
  for (const t of i.live) {
    if (["await_gate", "regate", "resume_after_oracle", "contract_merge", "oracle_calibrate"].includes(t.step)) active[t.step === "oracle_calibrate" ? "contract" : "gate"] = true;
    if (["ship", "build_collect"].includes(t.step)) active.evidence = true;
  }
  const pulses = i.recentTransitions.map((t) => edgeOfTransition(t.fromState, t.toState)).filter((x): x is [FlowNode, FlowNode] => !!x);
  const correcting = i.live.some((t) => failureRouting(t, t.corrections)?.party === "implementation");
  const repairing = i.live.some((t) => failureRouting(t, t.corrections)?.party === "oracle");
  return { counts, active, alert: i.openDecisions, pulses, correcting, repairing, resolved: i.accepted };
}
