import { describe, expect, it } from "vitest";
import { failureRouting, flowState, nodeOf } from "@/domain/ops";

describe("operations read model (real state -> flow)", () => {
  it("places tasks on the node of their control-loop step", () => {
    expect(nodeOf({ state: "PROPOSED", step: "draft_poll" })).toBe("contract");
    expect(nodeOf({ state: "PROPOSED", step: "await_owner_contract" })).toBe("owner");
    expect(nodeOf({ state: "IN_PROGRESS", step: "build_poll" })).toBe("builder");
    expect(nodeOf({ state: "VERIFYING", step: "await_gate" })).toBe("gate");
    expect(nodeOf({ state: "VERIFYING", step: "oracle_poll", stepData: { mode: "repair" } })).toBe("verifier");
    expect(nodeOf({ state: "BLOCKED_DECISION", step: "await_decision" })).toBe("owner");
    expect(nodeOf({ state: "ACCEPTED", step: "done" })).toBe("decision");
  });
  it("names who owns a failure and whether the system is fixing it itself", () => {
    expect(failureRouting({ state: "VERIFYING", step: "oracle_poll", stepData: { mode: "repair" } }, 0)).toMatchObject({ party: "oracle", selfCorrecting: true });
    expect(failureRouting({ state: "VERIFYING", step: "attribute_poll" }, 0)?.selfCorrecting).toBe(true);
    expect(failureRouting({ state: "IN_PROGRESS", step: "build_poll" }, 1)).toMatchObject({ party: "implementation", selfCorrecting: true });
    expect(failureRouting({ state: "IN_PROGRESS", step: "build_poll" }, 0)).toBeNull();
    expect(failureRouting({ state: "BLOCKED_DECISION", step: "await_decision" }, 0)).toMatchObject({ party: "ambiguity", selfCorrecting: false });
  });
  it("activates a node only when real work runs there", () => {
    const s = flowState({
      live: [
        { id: 1, state: "IN_PROGRESS", step: "build_poll", corrections: 1 },
        { id: 2, state: "VERIFYING", step: "await_gate", corrections: 0 },
      ],
      running: [{ taskId: 1, purpose: "correction" }],
      openDecisions: 0,
      recentTransitions: [{ fromState: "VERIFYING", toState: "IN_PROGRESS" }],
      accepted: 3,
    });
    expect(s.counts.builder).toBe(1);
    expect(s.counts.gate).toBe(1);
    expect(s.active).toEqual({ builder: true, gate: true });
    expect(s.correcting).toBe(true);
    expect(s.repairing).toBe(false);
    expect(s.pulses).toEqual([["gate", "builder"]]);
  });
});
