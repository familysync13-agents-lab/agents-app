import type { TaskState } from "@/db/schema";

/*
 * Lifecycle of Architecture Baseline v0.1 section 6. The control system - never a worker - moves a task between states, and
 * every move must name the mechanical fact that justifies it (a gate result for an exact SHA, a structured file a worker wrote,
 * a GitHub review by the owner, an executor result). Worker prose is never a fact.
 */
const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  PROPOSED: ["CONTRACTED", "BLOCKED_DECISION", "BLOCKED_EVIDENCE", "REJECTED", "ABANDONED"],
  CONTRACTED: ["IN_PROGRESS", "BLOCKED_DECISION", "BLOCKED_EVIDENCE", "ABANDONED"],
  IN_PROGRESS: ["VERIFYING", "BLOCKED_DECISION", "BLOCKED_EVIDENCE", "ABANDONED"],
  VERIFYING: ["DONE", "IN_PROGRESS", "BLOCKED_DECISION", "BLOCKED_EVIDENCE", "ABANDONED"],
  DONE: ["ACCEPTED", "IN_PROGRESS", "VERIFYING", "BLOCKED_DECISION", "BLOCKED_EVIDENCE", "REJECTED", "ABANDONED"],
  ACCEPTED: [],
  BLOCKED_DECISION: ["PROPOSED", "CONTRACTED", "IN_PROGRESS", "VERIFYING", "DONE", "REJECTED", "ABANDONED"],
  BLOCKED_EVIDENCE: ["PROPOSED", "CONTRACTED", "IN_PROGRESS", "VERIFYING", "DONE", "BLOCKED_DECISION", "REJECTED", "ABANDONED"],
  REJECTED: [],
  ABANDONED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export const TERMINAL: readonly TaskState[] = ["ACCEPTED", "REJECTED", "ABANDONED"];
export const BLOCKED: readonly TaskState[] = ["BLOCKED_DECISION", "BLOCKED_EVIDENCE"];

export const STATE_LABEL: Record<TaskState, string> = {
  PROPOSED: "Proposed",
  CONTRACTED: "Contracted",
  IN_PROGRESS: "In progress",
  VERIFYING: "Verifying",
  DONE: "Done",
  ACCEPTED: "Accepted",
  BLOCKED_DECISION: "Decision required",
  BLOCKED_EVIDENCE: "Blocked: evidence",
  REJECTED: "Rejected",
  ABANDONED: "Abandoned",
};

/** The linear path shown in the UI stepper. */
export const MAIN_PATH: readonly TaskState[] = ["PROPOSED", "CONTRACTED", "IN_PROGRESS", "VERIFYING", "DONE", "ACCEPTED"];

/** Gate verdict classification: which verdicts go back to the Builder automatically. */
export function classifyVerdict(verdict: string): "pass" | "candidate_failure" | "blocked" | "tamper" | "harness" {
  if (verdict === "DONE") return "pass";
  if (verdict === "FAIL:TAMPER" || verdict === "FAIL:FOREIGN-HEAD") return "tamper";
  if (verdict.startsWith("FAIL:")) return "candidate_failure"; // CHECK, ORACLE, REGRESSION, CANARY, SECRET, BUILD
  if (verdict.startsWith("BLOCKED:")) return "blocked";
  return "harness";
}
