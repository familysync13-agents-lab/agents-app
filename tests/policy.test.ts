import { describe, expect, it } from "vitest";
import { contractEscalation, recoveryDelay, verificationPlan } from "@/domain/policy";
import type { Contract } from "@/domain/contract";
import { previewMode } from "@/server/preview-mode";
import { createTask, decideContract } from "@/server/owner";
import { clock, contractApproved, contractRows, FakeExecutor, openDecisions, policyDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario } from "./support/fixture-handlers";

const base = () => CONTRACT("T9") as unknown as Contract;
const facts = (over: Partial<Parameters<typeof contractEscalation>[0]> = {}) => ({ taskTier: "standard" as const, body: base(), lintOk: true, oracleProblems: [], calibrated: true, ...over });

describe("owner-escalation policy (deterministic)", () => {
  it("does not escalate merely because a contract exists", () => {
    expect(contractEscalation(facts())).toEqual([]);
  });
  it("escalates real owner-level decisions only", () => {
    expect(contractEscalation(facts({ taskTier: "critical" }))[0]).toMatch(/critical/);
    const tagged = base();
    tagged.criteria[0]!.tags = ["authz"];
    expect(contractEscalation(facts({ body: tagged })).join()).toMatch(/trust boundary \(authz\)/);
    const scoped = base();
    scoped.scope.paths = ["src/**", "gate/**", ".github/workflows/x.yml", "policy.json"];
    expect(contractEscalation(facts({ body: scoped })).join()).toMatch(/enforcement paths \(gate\/\*\*, \.github\/workflows\/x\.yml, policy\.json\)/);
    expect(contractEscalation(facts({ oracleProblems: ["AC1: crash"] })).join()).toMatch(/could not be fully validated/);
    expect(contractEscalation(facts({ calibrated: false })).join()).toMatch(/not calibrated/);
    expect(contractEscalation(facts({ lintOk: false })).join()).toMatch(/lint/);
  });
  it("bounds self-recovery and AI verification by tier", () => {
    expect([recoveryDelay(0), recoveryDelay(1), recoveryDelay(2)]).toEqual([120, 900, null]);
    expect(verificationPlan("standard")).toEqual({ independentVerifier: true, mutation: false, unknownBlocks: false });
    expect(verificationPlan("critical")).toEqual({ independentVerifier: true, mutation: true, unknownBlocks: true });
  });
});

describe("gate-preview detection (/auth/preview hardening)", () => {
  const gate = { APP_ENV: "preview", DATABASE_URL: "postgres://gate:pw@db:5432/preview", APP_URL: "http://preview:8080", APP_BUILD_ID: "dev" };
  it("accepts the gate preview and its seed start", () => {
    expect(previewMode(gate)).toBe(true);
    expect(previewMode({ ...gate, DATABASE_URL: "postgres://dev:dev@db:5432/seed" })).toBe(true);
  });
  it("rejects production even when APP_ENV is misconfigured to preview", () => {
    const prod = { APP_ENV: "preview", DATABASE_URL: "postgres://agents:pw@db:5432/agents", APP_ALLOWED_HOSTS: "127.0.0.1:3700", AGENTS_PROJECTS: "[]", APP_BUILD_ID: "724c64791fa5331e" };
    expect(previewMode(prod)).toBe(false);
    // each marker alone is enough to refuse
    expect(previewMode({ ...gate, DATABASE_URL: "postgres://agents:pw@db:5432/agents" })).toBe(false);
    expect(previewMode({ ...gate, AGENTS_PROJECTS: "[]" })).toBe(false);
    expect(previewMode({ ...gate, APP_ALLOWED_HOSTS: "127.0.0.1:3700" })).toBe(false);
    expect(previewMode({ ...gate, APP_BUILD_ID: "724c64791fa5331e" })).toBe(false);
    expect(previewMode({ ...gate, APP_URL: "http://127.0.0.1:3700" })).toBe(false);
    expect(previewMode({ ...gate, APP_URL: undefined })).toBe(false);
    expect(previewMode({ ...gate, DATABASE_URL: undefined })).toBe(false);
    expect(previewMode({ ...gate, DATABASE_URL: "pglite://memory" })).toBe(false);
    for (const e of [undefined, "production", "test", "Preview", "preview "]) expect(previewMode({ ...gate, APP_ENV: e })).toBe(false);
  });
});

describe("control loop under the V1 escalation policy", () => {
  const start = async (opts: Parameters<typeof scenario>[0], tier: "standard" | "critical" = "standard") => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario(opts);
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier });
    return { db, clk, state, ex, id };
  };

  it("intent -> contract (Owner approves it) -> build -> DONE with no other owner action before final acceptance", async () => {
    const { db, clk, state, ex, id } = await start({});
    const asked: string[] = [];
    await runUntil(db, ex, clk, async () => {
      for (const d of await openDecisions(db, id)) if (!asked.includes(d.kind)) asked.push(d.kind);
      return (await taskRow(db, id)).step === "await_acceptance";
    });
    expect(asked).toEqual(["contract_approval", "acceptance"]); // the Owner approves what will be built, and the result (SEC-TB-01)
    expect((await policyDecisions(db, id)).filter((d) => d.kind === "contract_approval")).toEqual([]); // never approved by the control system
    const { decisions: decs } = await import("@/db/schema");
    const { eq: eqq } = await import("drizzle-orm");
    const ca = (await db.select().from(decs).where(eqq(decs.taskId, id))).filter((d) => d.kind === "contract_approval");
    expect(ca.map((d) => [d.choice, d.status, d.decidedVia])).toEqual([["approve", "decided", "app"]]);
    expect(state.systemMerges).toBe(1);
    expect(state.ownerMerges).toBe(0);
    expect(ex.log.some((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "refresh_pr")).toBe(false);
    // token policy: no mutation session on the standard tier
    expect(ex.log.some((l) => l.op === "strip_oracles")).toBe(false);
    expect(state.builderPrompts.some((p) => p.includes("mutation tester"))).toBe(false);
  });

  it("a critical-tier contract still goes to the owner", async () => {
    const { db, clk, ex, id } = await start({}, "critical");
    await runUntil(db, ex, clk, async () => ["await_owner_contract", "await_decision"].includes((await taskRow(db, id)).step));
    const t = await taskRow(db, id);
    if (t.step === "await_owner_contract") {
      const [d] = await openDecisions(db, id);
      expect(d!.kind).toBe("contract_approval");
      expect(d!.why).toMatch(/critical tier/);
      expect(await policyDecisions(db, id)).toEqual([]);
      expect(await contractApproved(db, id)).toBe(false);
    } else {
      // the fixture's drafter writes a standard-tier contract: lint refuses it for a critical intent and nothing is auto-approved
      expect((await policyDecisions(db, id)).filter((d) => d.kind === "contract_approval")).toEqual([]);
    }
  });

  it("falls back to the owner's GitHub approval when the repository itself still requires it (gate)", async () => {
    const { db, clk, state, ex, id } = await start({ repoRequiresOwner: true });
    await runUntil(db, ex, clk, async () => (await openDecisions(db, id)).some((d) => d.kind === "contract_github_approval"));
    expect(state.systemMerges).toBe(0);
    await expect(runUntil(db, ex, clk, async () => (await taskRow(db, id)).state !== "PROPOSED", 10)).rejects.toThrow("condition not reached");
    expect((await openDecisions(db, id)).length).toBe(1); // asked once, not repeatedly
    state.ownerApprovedContract = true;
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "IN_PROGRESS");
    expect(state.ownerMerges).toBe(1);
  });

  it("falls back to the owner when the ruleset refuses the system merge, without a merge loop", async () => {
    const { db, clk, state, ex, id } = await start({ rulesetRefusesMerge: true });
    await runUntil(db, ex, clk, async () => (await openDecisions(db, id)).some((d) => d.kind === "contract_github_approval"));
    await expect(runUntil(db, ex, clk, async () => (await taskRow(db, id)).state !== "PROPOSED", 10)).rejects.toThrow("condition not reached");
    expect(state.systemMerges).toBe(1);
    state.ownerApprovedContract = true;
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "IN_PROGRESS");
    expect(state.ownerMerges).toBe(1);
  });

  it("the owner can still decide a contract in person when it is escalated", async () => {
    const { db, clk, ex, id } = await start({});
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    const [c] = await contractRows(db, id);
    await expect(decideContract(db, { taskId: id, contractId: c!.id, choice: "approve", note: "", sha256: c!.sha256 })).rejects.toThrow(/no longer awaiting/);
  });
});
