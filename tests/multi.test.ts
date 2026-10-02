import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { decisions, projects, transitions } from "@/db/schema";
import { createTask, decideContract } from "@/server/owner";
import { clock, contractRows, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";

const intent = (s: string) => `Let owners ${s} on the list index, without changing anything else.`;

async function approveContract(db: Parameters<typeof decideContract>[0], id: number) {
  const [c] = await contractRows(db, id);
  await decideContract(db, { taskId: id, contractId: c!.id, choice: "approve", note: "", sha256: c!.sha256 });
}

describe("several tasks: batched approvals, serialized and stacked work", () => {
  it("batches contracts approved in one sitting into ONE GitHub approval", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { state, h } = scenario();
    const ex = new FakeExecutor(db, h);
    const a = await createTask(db, { projectId: project.id, title: "Sort lists", intent: intent("sort lists"), tier: "standard" });
    const b = await createTask(db, { projectId: project.id, title: "Filter lists", intent: intent("filter lists"), tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, a)).step === "await_owner_contract" && (await taskRow(db, b)).step === "await_owner_contract");
    await approveContract(db, a);
    await approveContract(db, b);
    await runUntil(db, ex, clk, async () => (await openDecisions(db, a)).some((d) => d.kind === "contract_github_approval"));
    expect(state.contractPrs.size).toBe(1); // one PR for both
    const [only] = [...state.contractPrs.values()];
    const ka = (await taskRow(db, a)).key!;
    const kb = (await taskRow(db, b)).key!;
    expect(only!.files).toEqual([`oracle/${ka}/check.mjs`, `oracle/${kb}/check.mjs`, `tasks/${ka}/contract.json`, `tasks/${ka}/task.json`, `tasks/${kb}/contract.json`, `tasks/${kb}/task.json`].sort());
    const prFiles = ex.log.find((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_files")!;
    expect(String((prFiles.params.ops as { branch: string }[])[0]!.branch)).toMatch(/^amend\/multi\//);
    expect((await openDecisions(db, b)).length).toBe(0); // the owner confirms once, on the leader's decision
    await runUntil(db, ex, clk, async () => (await taskRow(db, a)).state === "IN_PROGRESS" && (await taskRow(db, b)).state !== "PROPOSED");
    expect((await taskRow(db, a)).state).toBe("IN_PROGRESS"); // a builds first ...
    expect((await taskRow(db, b)).state).toBe("CONTRACTED"); // ... b is serialized behind it (this project serializes)
    const merges = ex.log.filter((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "merge_approved");
    expect(merges.length).toBe(1);
  });

  it("stacks a task on a DONE head and accepts both with one owner approval", async () => {
    const { db, project } = await setup();
    await db.update(projects).set({ workMode: "stacked" }).where(eq(projects.id, project.id));
    const clk = clock();
    const { state, h } = scenario();
    const ex = new FakeExecutor(db, h);
    const a = await createTask(db, { projectId: project.id, title: "Sort lists", intent: intent("sort lists"), tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, a)).step === "await_owner_contract");
    await approveContract(db, a);
    await runUntil(db, ex, clk, async () => (await taskRow(db, a)).step === "await_acceptance");
    const ta = await taskRow(db, a);
    const b = await createTask(db, { projectId: project.id, title: "Filter lists", intent: intent("filter lists"), tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, b)).step === "await_owner_contract");
    await approveContract(db, b);
    await runUntil(db, ex, clk, async () => (await taskRow(db, b)).step === "await_acceptance");
    const tb = await taskRow(db, b);
    expect(tb.stackParentId).toBe(a);
    // the child's PR was built on the parent's DONE head
    const prOpen = ex.log.filter((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "pr_from_worktree").map((l) => (l.params.ops as { base_sha: string }[])[0]!.base_sha);
    expect(prOpen[1]).toBe(ta.headSha);
    expect((await taskRow(db, a)).step).toBe("await_stack");
    const open = [...(await openDecisions(db, a)), ...(await openDecisions(db, b))];
    expect(open.map((d) => d.kind)).toEqual(["acceptance"]);
    expect(open[0]!.title).toContain("together");
    state.approvedPrs.add(tb.prNumber!);
    await runUntil(db, ex, clk, async () => (await taskRow(db, a)).state === "ACCEPTED" && (await taskRow(db, b)).state === "ACCEPTED");
    expect(state.closedPrs).toContain(ta.prNumber);
    const fa = (await db.select().from(transitions).where(eq(transitions.taskId, a))).at(-1)!;
    expect(fa.fact).toMatchObject({ stacked_in: b });
    const ds = await db.select().from(decisions).where(eq(decisions.taskId, a));
    expect(ds.find((d) => d.kind === "acceptance")!.choice).toBe("stacked");
  });
});
