import type { Role } from "./ui";

/** Plain-language meaning of the control loop's current step, and who is acting. Derived from the real step, not simulated. */
export const STEP_INFO: Record<string, { label: string; role: Role; waitingOnOwner?: boolean }> = {
  draft_contract: { label: "Preparing the task", role: "system" },
  draft_start: { label: "Starting the contract drafter", role: "system" },
  draft_poll: { label: "Drafting the contract from your intent", role: "builder" },
  draft_collect: { label: "Checking the draft (contract lint)", role: "system" },
  oracle_start: { label: "Starting the independent Verifier", role: "system" },
  oracle_poll: { label: "Writing the acceptance checks, blind to any code", role: "verifier" },
  oracle_collect: { label: "Collecting the acceptance checks", role: "system" },
  oracle_calibrate: { label: "Calibrating the acceptance checks against the current app", role: "gate" },
  await_owner_contract: { label: "Your review of the contract", role: "owner", waitingOnOwner: true },
  contract_batch: { label: "Grouping approved contracts into one GitHub approval", role: "system" },
  batch_wait: { label: "Waiting for the combined contract PR", role: "system" },
  contract_pr: { label: "Proposing the contract to the repository", role: "system" },
  await_github_contract: { label: "Your confirmation of the contract on GitHub", role: "owner", waitingOnOwner: true },
  contract_merge: { label: "Gate confirming the approved contract", role: "gate" },
  build_start: { label: "Waiting to start the build", role: "system" },
  build_poll: { label: "Building", role: "builder" },
  build_collect: { label: "Reading the Builder's structured outcome", role: "system" },
  ship: { label: "Submitting the work for verification", role: "system" },
  await_gate: { label: "Gate evaluating the exact commit", role: "gate" },
  gate_collect: { label: "Recording the gate evidence", role: "gate" },
  fix_start: { label: "Returning findings to the Builder", role: "system" },
  acceptance_start: { label: "Preparing a live preview for independent verification", role: "system" },
  acceptance_poll: { label: "Independent verification against a live preview", role: "verifier" },
  acceptance_collect: { label: "Recording the independent findings", role: "system" },
  attribute_start: { label: "Arbiter reproducing the failure on a live preview", role: "verifier" },
  attribute_poll: { label: "Arbiter deciding who owns the failure", role: "verifier" },
  attribute_collect: { label: "Routing the failure to its owner", role: "system" },
  regate: { label: "Re-running the gate (environment failure)", role: "gate" },
  resume_after_oracle: { label: "Re-checking the kept work against the repaired check", role: "gate" },
  mutation_start: { label: "Preparing the oracle mutation test", role: "system" },
  mutation_poll: { label: "Writing realistic defects to test the oracle", role: "builder" },
  mutant_eval: { label: "Checking that the oracle catches each defect", role: "gate" },
  await_stack: { label: "Accepted together with the task stacked on it", role: "owner", waitingOnOwner: true },
  restack: { label: "Updating the stacked PR with main and re-verifying", role: "gate" },
  mark_done: { label: "Deciding DONE from evidence", role: "system" },
  await_acceptance: { label: "Your acceptance on GitHub", role: "owner", waitingOnOwner: true },
  await_decision: { label: "Your decision", role: "owner", waitingOnOwner: true },
  cleanup: { label: "Cleaning up", role: "system" },
  done: { label: "Finished", role: "system" },
};

export function stepInfo(step: string) {
  return STEP_INFO[step] ?? { label: step, role: "system" as Role };
}
