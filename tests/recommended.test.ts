import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activity, decisions, tasks, transitions } from "@/db/schema";
import { classifyDecision, type DecisionFacts } from "@/domain/policy";
import { createTask, decideBlock } from "@/server/owner";
import { clock, FakeExecutor, openDecisions, policyDecisions, runUntil, setup, taskRow } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";

/*
 * RECOMMENDED = AUTO-APPROVE. A decision either has one recommended action the control system takes itself (recorded as a
 * control-system decision, workflow continues) or it NEEDS YOU and is shown without any recommended option.
 */
const options = [
  { id: "o1", label: "Use the existing helper", consequence: "No new file." },
  { id: "o2", label: "Write a new helper", consequence: "One new file." },
  { id: "abandon", label: "Abandon the task", consequence: "Nothing is built." },
];
const f = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({ kind: "block", stage: "build", recommendation: "Use the existing helper", options, cls: "routine", taskTier: "standard", hasWork: false, text: "Which helper should be used?", ...over });
const auto = (x: DecisionFacts) => classifyDecision(x).auto;

describe("classifyDecision: recommended = automatic, everything else needs the owner", () => {
  it("takes the one recommended action itself (continue / retry-like choice / abandon)", () => {
    expect(auto(f())).toBe("o1");
    expect(auto(f({ recommendation: "o2" }))).toBe("o2");
    expect(auto(f({ recommendation: "Abandon the task", cls: undefined, options: [options[2]!] }))).toBe("abandon");
    expect(auto(f({ stage: "contract", recommendation: "End here", cls: null, options: [{ id: "o1", label: "End here", consequence: "", action: "abandon" }] }))).toBe("o1");
  });
  it("cannot be bypassed by recommending an option for an owner-level decision", () => {
    const needs = (x: DecisionFacts) => {
      const c = classifyDecision(x);
      expect(c.auto).toBeNull();
      return c.auto === null ? c.needsOwner.join() : "";
    };
    expect(needs(f({ cls: undefined }))).toMatch(/product \/ owner-level/); // genuine ambiguity: a worker question not marked routine
    expect(needs(f({ cls: "owner" }))).toMatch(/product \/ owner-level/);
    expect(needs(f({ taskTier: "critical" }))).toMatch(/critical/); // danger
    expect(needs(f({ recommendation: "Abandon the task", hasWork: true }))).toMatch(/discard existing work/); // major / irreversible
    expect(needs(f({ recommendation: "Abandon the task", cls: undefined }))).toMatch(/product \/ owner-level/); // abandon vs real alternatives is a choice
    for (const [text, word] of [["Rotate the API token?", "token"], ["Grant the App permission to the repo", "permission"], ["Delete the old rows", "delete"], ["Store the password", "password"], ["This widens the scope", "scope"], ["A security trade-off", "security"], ["Needs a credential", "credential"], ["Changes billing", "billing"]] as const)
      expect(needs(f({ text }))).toContain(word);
    expect(needs(f({ options: [{ id: "o1", label: "Use the existing helper", consequence: "Deletes user data: irreversible" }, options[2]!] }))).toMatch(/irreversible|delete/i);
    for (const stage of ["security", "tamper", "access", "evidence", "budget"]) expect(needs(f({ stage }))).toContain(stage);
    for (const kind of ["acceptance", "contract_github_approval", "budget", "contract_approval"]) expect(needs(f({ kind }))).toMatch(/owner authority/);
    expect(needs(f({ recommendation: null }))).toMatch(/no recommended action/);
    expect(needs(f({ recommendation: "Something else" }))).toMatch(/exactly one option/);
    expect(needs(f({ options: [options[0]!, { ...options[0]!, id: "o9" }] }))).toMatch(/exactly one option/);
  });
});

describe("control loop: recommended actions never wait for the owner", () => {
  const start = async (opts: Parameters<typeof scenario>[0]) => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario(opts);
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    /** run, recording every decision that was ever open for the owner */
    const run = async (until: () => Promise<boolean>) => {
      const shown: (typeof decisions.$inferSelect)[] = [];
      await runUntil(db, ex, clk, async () => {
        for (const d of await openDecisions(db, id)) if (!shown.some((x) => x.id === d.id)) shown.push(d);
        return until();
      });
      return shown;
    };
    return { db, clk, state, ex, id, run };
  };
  const Q = { type: "BLOCKED:DECISION", unknown: "Sort by title or by date?", why: "Both are possible.", options: [{ label: "By title", consequence: "A-Z" }, { label: "By date", consequence: "newest first" }], recommendation: "By title" };

  it("a recommended routine choice is executed without the owner, recorded as a control-system decision, and the workflow continues", async () => {
    const { db, id, run, ex } = await start({ draftBlocks: [{ ...Q, class: "routine" }] });
    const shown = await run(async () => (await taskRow(db, id)).step === "await_acceptance");
    expect(shown.map((d) => d.kind)).toEqual(["acceptance"]); // the question itself was never shown to the owner
    const pol = (await policyDecisions(db, id)).filter((d) => d.kind === "block");
    expect(pol.map((d) => [d.choice, d.status, d.decidedVia])).toEqual([["o1", "decided", "policy"]]);
    const act = await db.select().from(activity).where(eq(activity.taskId, id));
    expect(act.filter((a) => a.actor === "owner" && /Decision/.test(a.message))).toEqual([]); // not "by the owner"
    expect(act.some((a) => a.actor === "system" && /Decided by the control system/.test(a.message) && /By title/.test(a.message))).toBe(true);
    const prompts = ex.log.filter((l) => l.op === "builder").map((l) => String(l.params.prompt_text));
    expect(prompts[1]).toContain("Control-system decision");
    expect(prompts[1]).not.toContain("Owner decision");
    const tr = await db.select().from(transitions).where(eq(transitions.taskId, id));
    expect(tr.some((t) => /Decided by the control system/.test(t.reason))).toBe(true);
  });

  it("nothing shown to the owner ever carries a recommended option (invariant, whole lifecycle incl. blocks and acceptance)", async () => {
    const { db, id, run, state } = await start({ draftBlocks: [Q], failFirstGate: true });
    const shown = await run(async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const [d] = await openDecisions(db, id);
    expect(d!.recommendation).toBeNull(); // NEEDS YOU: the worker's suggestion is not presented as RECOMMENDED
    expect((d!.context as { suggestion?: string }).suggestion).toBe("By title");
    expect((d!.context as { needsOwner?: string[] }).needsOwner!.join()).toMatch(/product \/ owner-level/);
    // genuine owner decision: the task waits
    await expect(runUntil(db, (await start({})).ex, clock(), async () => (await taskRow(db, id)).state !== "BLOCKED_DECISION", 5)).rejects.toThrow();
    expect((await taskRow(db, id)).state).toBe("BLOCKED_DECISION");
    await decideBlock(db, { decisionId: d!.id, choice: "o2", note: "" });
    const later = await run(async () => (await taskRow(db, id)).step === "await_acceptance");
    state.ownerApprovedTask = true;
    const all = await db.select().from(decisions).where(eq(decisions.taskId, id));
    for (const x of [...shown, ...later]) expect(x.recommendation).toBeNull();
    for (const x of all) if (x.decidedVia !== "policy") expect(x.recommendation).toBeNull();
    for (const x of all) if (x.recommendation) expect([x.status, x.decidedVia]).toEqual(["decided", "policy"]);
    expect(all.find((x) => x.id === d!.id)!.decidedVia).toBe("app");
  });

  it("a recommended Abandon ends the task by itself when nothing was built", async () => {
    const { db, id, run } = await start({ draftBlocks: [{ type: "BLOCKED:DECISION", unknown: "This intent cannot be built in this project.", why: "It belongs to another repository.", options: [{ label: "Abandon the task", action: "abandon" }], recommendation: "Abandon the task" }] });
    const shown = await run(async () => (await taskRow(db, id)).step === "done");
    expect(shown).toEqual([]);
    const t = await taskRow(db, id);
    expect(t.state).toBe("ABANDONED");
    expect(t.stateReason).toMatch(/Abandoned by the control system/);
    const [p] = await policyDecisions(db, id);
    expect([p!.choice, p!.options.map((o) => o.id)]).toEqual(["abandon", ["abandon"]]); // the worker's "Abandon the task" IS the built-in abandon
  });

  it("replay of the T2 run: ONE owner decision ends the task; no second question, no 'recommended Abandon' waiting for a click", async () => {
    // what the drafter wrote for T2 (decision 49), with the option that ends the task marked as such
    const first = {
      type: "BLOCKED:DECISION",
      unknown: "Which repository and project should the task build in, and which technology stack should the scaffold use?",
      why: "The intent asks for an independent product outside this repository. Choosing another repository or project, or the stack, is an owner decision about architecture and scope.",
      options: [
        { label: "Register it as its own project and re-file the task there", consequence: "This task is abandoned here.", action: "abandon" },
        { label: "Build the scaffold as a subfolder of this repository", consequence: "Contradicts the independence the intent requires." },
        { label: "Abandon the task", consequence: "Nothing is built." },
      ],
      recommendation: "Register it as its own project and re-file the task there",
    };
    const { db, id, run, state } = await start({ draftBlocks: [first] });
    const shown = await run(async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    expect(shown.length).toBe(1);
    expect(shown[0]!.recommendation).toBeNull(); // architecture/scope: NEEDS YOU, nothing "recommended" to confirm
    expect(shown[0]!.options.map((o) => o.id)).toEqual(["o1", "o2", "abandon"]); // the duplicate "Abandon the task" is the built-in one
    await decideBlock(db, { decisionId: shown[0]!.id, choice: "o1", note: "" });
    const after = await run(async () => (await taskRow(db, id)).step === "done");
    expect(after).toEqual([]); // no follow-up question
    expect((await taskRow(db, id)).state).toBe("ABANDONED");
    expect((await taskRow(db, id)).stateReason).toMatch(/Abandoned by the owner: Register it as its own project/);
    expect(state.drafts).toBe(1); // the drafter was not sent back to ask again
  });

  it("replay of the T2 run with an unmarked option: the drafter's follow-up 'Abandon' is executed by the control system, not asked", async () => {
    const first = { type: "BLOCKED:DECISION", unknown: "Which project should this be built in?", why: "A product decision.", options: [{ label: "Its own project", consequence: "Re-file there." }, { label: "A subfolder here", consequence: "Not independent." }], recommendation: "Its own project" };
    const third = { type: "BLOCKED:DECISION", unknown: "The owner decided to build this elsewhere; this task must end.", why: "No contract can be written here under that decision.", options: [{ label: "Abandon the task" }], recommendation: "Abandon the task" };
    const { db, id, run } = await start({ draftBlocks: [first, third] });
    const shown = await run(async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    await decideBlock(db, { decisionId: shown[0]!.id, choice: "o1", note: "" });
    const after = await run(async () => (await taskRow(db, id)).step === "done");
    expect(after).toEqual([]);
    expect((await taskRow(db, id)).state).toBe("ABANDONED");
    expect((await policyDecisions(db, id)).map((d) => d.choice)).toEqual(["abandon"]);
  });

  it("a recommended Abandon that would discard built work NEEDS YOU", async () => {
    const { db, id, run } = await start({});
    await run(async () => (await taskRow(db, id)).step === "await_acceptance");
    const t = await taskRow(db, id);
    expect(t.prNumber).toBeTruthy();
    const { TaskCtx } = await import("@/worker/context");
    const { projects } = await import("@/db/schema");
    const [p] = await db.select().from(projects);
    const ctx = new TaskCtx(db, (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!, p!);
    const did = await ctx.openDecision({ kind: "block", title: "Give up?", why: "The worker suggests ending.", options: [{ id: "abandon", label: "Abandon the task", consequence: "The PR is closed." }], recommendation: "abandon", context: { stage: "build" } });
    const [d] = await db.select().from(decisions).where(eq(decisions.id, did));
    expect([d!.status, d!.recommendation, d!.decidedVia]).toEqual(["open", null, null]);
  });
});
