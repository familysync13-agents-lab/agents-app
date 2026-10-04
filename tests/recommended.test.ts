import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { decisions, tasks } from "@/db/schema";
import { classifyDecision, contractEscalation, ROUTINE_OPERATIONS, type DecisionFacts } from "@/domain/policy";
import { Contract, intentHash, lintContract, quotesIntent, requirementAuthority } from "@/domain/contract";
import { createTask, decideBlock } from "@/server/owner";
import { clock, contractApproved, contractRows, FakeExecutor, openDecisions, owner, policyDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario } from "./support/fixture-handlers";

/*
 * RECOMMENDED = AUTO-APPROVE. A decision either has one recommended action the control system takes itself (recorded as a
 * control-system decision, workflow continues) or it NEEDS YOU and is shown without any recommended option.
 */
const options = [
  { id: "o1", label: "Use the existing helper", consequence: "No new file." },
  { id: "o2", label: "Write a new helper", consequence: "One new file." },
  { id: "abandon", label: "Abandon the task", consequence: "Nothing is built." },
];
const f = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({ kind: "block", stage: "build", recommendation: "Use the existing helper", options, taskTier: "standard", hasWork: false, ...over });
const auto = (x: DecisionFacts) => classifyDecision(x).auto;
const needs = (x: DecisionFacts) => {
  const c = classifyDecision(x);
  expect(c.auto).toBeNull();
  return c.auto === null ? c.needsOwner.join() : "";
};

describe("classifyDecision: only an allowlisted routine operation is automatic (SEC-TB-01)", () => {
  it("the allowlist is owned by the control plane and holds routine operations only", () => {
    expect(Object.keys(ROUTINE_OPERATIONS)).toEqual(["end_unbuilt_task"]);
  });
  it("ends a task for which nothing was built and no other path is offered", () => {
    expect(auto(f({ recommendation: "Abandon the task", options: [options[2]!] }))).toBe("abandon");
    expect(auto(f({ stage: "contract", recommendation: "End here", options: [{ id: "o1", label: "End here", consequence: "", action: "abandon" }] }))).toBe("o1");
  });
  it("a recommended option is never authority: every choice between real options needs the Owner", () => {
    expect(needs(f())).toMatch(/only the Owner decides/);
    expect(needs(f({ recommendation: "o2" }))).toMatch(/only the Owner decides/);
    expect(needs(f({ stage: "contract" }))).toMatch(/only the Owner decides/);
    expect(needs(f({ taskTier: "critical" }))).toMatch(/critical/);
    expect(needs(f({ recommendation: "Abandon the task", hasWork: true }))).toMatch(/discard existing work/);
    expect(needs(f({ recommendation: "Abandon the task" }))).toMatch(/only the Owner decides/); // abandon vs real alternatives is a choice
    for (const stage of ["security", "tamper", "access", "evidence", "budget"]) expect(needs(f({ stage }))).toContain(stage);
    for (const kind of ["acceptance", "contract_github_approval", "budget", "contract_approval"]) expect(needs(f({ kind }))).toMatch(/owner authority/);
    expect(needs(f({ recommendation: null }))).toMatch(/no recommended action/);
    expect(needs(f({ recommendation: "Something else" }))).toMatch(/exactly one option/);
    expect(needs(f({ options: [options[0]!, { ...options[0]!, id: "o9" }] }))).toMatch(/exactly one option/);
  });
  it("an operation that is not on the allowlist, or that would end the task, is not automatic", () => {
    expect(needs(f({ operation: "apply_worker_choice" as never }))).toMatch(/only the Owner decides/);
    expect(needs(f({ operation: "end_unbuilt_task", recommendation: "Abandon the task" }))).toMatch(/only the Owner decides/); // real alternatives exist
  });
});

/*
 * SEC-TB-01 adversarial regression. Each record is what a worker could write in BLOCKED.json: neutral wording, no word any filter
 * could catch, its own label "routine", and a recommendation. Before the fix every one of them was applied without the Owner.
 */
const ATTACKS: Record<string, Record<string, unknown>> = {
  "public access by link": { unknown: "Who can open a list from a link", why: "The intent does not say", options: [{ label: "Anyone holding the link can open it", consequence: "Links work for everybody" }, { label: "Only the person who made the list", consequence: "Links work for one person" }], recommendation: "Anyone holding the link can open it" },
  "automatic deletion": { unknown: "How long finished lists are kept", why: "Not stated", options: [{ label: "Remove finished lists after 30 days", consequence: "Old lists go away on their own" }, { label: "Keep them", consequence: "Nothing goes away" }], recommendation: "Remove finished lists after 30 days" },
  "dropping a required criterion": { unknown: "AC1 cannot be met with the chosen component", would_resolve: "Leave AC1 out of this task", options: ["Leave AC1 out of this task", "Rebuild the component"], recommendation: "Leave AC1 out of this task" },
  "sending data to an outside service": { unknown: "Where list names are spell-checked", why: "Not stated", options: [{ label: "Send each list name to an outside spell-check service", consequence: "Names are checked remotely" }, { label: "No spell-check", consequence: "-" }], recommendation: "Send each list name to an outside spell-check service" },
};

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

  for (const [name, attack] of Object.entries(ATTACKS)) {
    it(`contract stage - ${name}: "class: routine" and a recommendation never decide; the Owner is asked and nothing proceeds`, async () => {
      const { db, id, run, state } = await start({ draftBlocks: [{ type: "BLOCKED:DECISION", ...attack, class: "routine" }] });
      const shown = await run(async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
      expect(shown.map((d) => d.kind)).toEqual(["block"]);
      const [d] = await openDecisions(db, id);
      expect([d!.status, d!.recommendation, d!.decidedVia]).toEqual(["open", null, null]);
      expect((d!.context as { needsOwner: string[]; workerClass: unknown; origin: string })).toMatchObject({ origin: "worker", workerClass: "routine", needsOwner: [expect.stringMatching(/only the Owner decides/)] });
      expect((await policyDecisions(db, id)).filter((x) => x.kind === "block")).toEqual([]); // nothing was decided by the control system
      // it waits: no contract is written from the worker's own recommendation
      await expect(runUntil(db, (await start({})).ex, clock(), async () => (await taskRow(db, id)).state !== "BLOCKED_DECISION", 5)).rejects.toThrow();
      expect(state.drafts).toBe(1);
      expect(await contractRows(db, id)).toEqual([]);
    });
    it(`build stage with a PR already open - ${name}: the Builder's "routine" block waits for the Owner; the contract is not rewritten`, async () => {
      const { db, id, run } = await start({ failFirstGate: true, builderBlocks: [{ type: "BLOCKED:DECISION", ...attack, class: "routine" }] });
      await run(async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
      const [d] = await openDecisions(db, id);
      expect([d!.kind, d!.status, d!.recommendation]).toEqual(["block", "open", null]);
      expect((d!.context as { stage: string; origin: string }).stage).toBe("build");
      expect((await taskRow(db, id)).prNumber).toBeTruthy(); // existing work: a PR is open
      expect((await policyDecisions(db, id)).filter((x) => x.kind === "block")).toEqual([]);
      expect((await contractRows(db, id)).filter((c) => c.kind === "contract").length).toBe(1); // still the Owner-approved v1, unchanged
    });
  }

  it("a new contract is never approved by the control system: tags, tier, traces and wording are the drafter's and carry no authority", async () => {
    owner.approvesContracts = false;
    try {
      const { db, id, run } = await start({});
      const shown = await run(async () => (await taskRow(db, id)).step === "await_owner_contract");
      expect(shown.map((d) => d.kind)).toEqual(["contract_approval"]);
      expect([shown[0]!.status, shown[0]!.recommendation]).toEqual(["open", null]);
      expect(shown[0]!.why).toMatch(/sets what will be built; approving requirements is yours\. Traced to a quote of your intent: AC1/);
      expect((await policyDecisions(db, id)).filter((x) => x.kind === "contract_approval")).toEqual([]);
      expect(await contractApproved(db, id)).toBe(false);
    } finally {
      owner.approvesContracts = true;
    }
  });

  it("nothing shown to the owner ever carries a recommended option (invariant, whole lifecycle incl. blocks and acceptance)", async () => {
    const { db, id, run, state } = await start({ draftBlocks: [Q], failFirstGate: true });
    const shown = await run(async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const [d] = await openDecisions(db, id);
    expect(d!.recommendation).toBeNull(); // NEEDS YOU: the worker's suggestion is not presented as RECOMMENDED
    expect((d!.context as { suggestion?: string }).suggestion).toBe("By title");
    expect((d!.context as { needsOwner?: string[] }).needsOwner!.join()).toMatch(/only the Owner decides/);
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

describe("SEC-TB-01 wider path: a requirement the drafter writes into a contract is never its own authority", () => {
  const INTENT = "Sort lists\nLet owners sort their lists alphabetically on the list index.";
  const open = { id: "AC9", type: "behavior", priority: "must", tags: [], verify: "blackbox", given: "a list and a visitor who is not signed in", when: "the visitor opens the link of the list", then: "the list is shown" };
  const body = (trace: { source: string; ref: string }, extra: Record<string, unknown> = {}) => ({ ...CONTRACT("T9"), intent_sha256: intentHash(INTENT), policies: ["policy.json"], criteria: [...CONTRACT("T9").criteria, { ...open, trace }], ...extra });
  const lint = (c: unknown) => lintContract(c, { id: "T9", tier: "standard" }, { intent: INTENT });
  it("a fragment of the intent is not a source: the weak trace that passed before is refused", () => {
    expect(quotesIntent("their lists", INTENT)).toBe(false); // the audit's example: 2 words
    expect(quotesIntent("ir lists alphabetically on th", INTENT)).toBe(false); // not whole words
    expect(quotesIntent("sort their lists alphabetically", INTENT)).toBe(true);
    expect(quotesIntent("Sort  THEIR lists, alphabetically", INTENT)).toBe(true); // case and punctuation do not matter; the words do
    expect(lint(body({ source: "intent", ref: "their lists" })).problems.join()).toMatch(/AC9: an intent trace must quote the owner's intent verbatim: at least 4 consecutive whole words/);
  });
  it("a strong quote, no sensitive tag and standard tier still do not approve it: it is listed for the Owner, who approves every new outcome", () => {
    const c = Contract.parse(body({ source: "intent", ref: "sort their lists alphabetically" }));
    expect(lint(c).ok).toBe(true); // well-formed - and that is all lint says
    expect(contractEscalation({ taskTier: "standard", body: c, lintOk: true, oracleProblems: [], calibrated: true })).toEqual([]); // nothing "sensitive" was declared
    // ... which no longer matters: approval is not derived from the contract's own text (see the control-loop test above)
    const drafted = Contract.parse(body({ source: "necessary", ref: "AC1: lists must be reachable" }, { assumptions: [{ id: "A1", question: "Who may open a list?", chosen: "Anyone with the link", basis: "stated intent", reversible: true }] }));
    const auth = requirementAuthority(drafted, INTENT);
    expect(auth.quoted).toContain("AC1");
    expect(auth.quoted).not.toContain("AC9");
    expect(auth.added).toEqual(expect.arrayContaining([{ id: "AC9", why: expect.stringMatching(/^drafter: needed for AC1/) }, { id: "A1", why: "assumption: Anyone with the link" }]));
  });
});
