import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminActions, decisions, executorJobs, runs, tasks } from "@/db/schema";
import { createTask, decideBlock } from "@/server/owner";
import { runAdmin } from "@/server/admin";
import { clock, FakeExecutor, contractApproved, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";
import { tick } from "@/worker/orchestrator";

describe("audited admin operations", () => {
  it("pauses and resumes a task; the control loop does not advance a paused task", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario();
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    const r = await runAdmin(db, "owner", { op: "pause", taskId: id, reason: "control-plane defect under investigation" });
    expect(r.ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      await tick(db, clk.now);
      await ex.drain();
    }
    expect((await taskRow(db, id)).step).toBe("draft_contract");
    const again = await runAdmin(db, "owner", { op: "pause", taskId: id, reason: "second pause attempt here" });
    expect(again).toMatchObject({ ok: false, refusal: "task is already paused" });
    expect((await runAdmin(db, "owner", { op: "resume", taskId: id, reason: "investigation finished, safe" })).ok).toBe(true);
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    const audit = await db.select().from(adminActions).orderBy(adminActions.id);
    expect(audit.map((a) => [a.op, a.outcome])).toEqual([
      ["pause", "applied"],
      ["pause", "refused"],
      ["resume", "applied"],
    ]);
    expect(audit[0]!.before).toMatchObject({ state: "PROPOSED" });
  });

  it("re-opens a wrongly applied decision only when no worker is running, and the task waits for exactly that decision", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario({ draftBlocked: true });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists somehow on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).state === "BLOCKED_DECISION");
    const [d] = await openDecisions(db, id);
    await decideBlock(db, { decisionId: d!.id, choice: "o1", note: "" });
    // the revised draft is running: re-opening is refused until the run is stopped
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "draft_poll");
    const refused = await runAdmin(db, "operator", { op: "reopen_decision", taskId: id, decisionId: d!.id, reason: "decision applied to the wrong block" });
    expect(refused.ok).toBe(false);
    const [run] = await db.select().from(runs).where(eq(runs.status, "running"));
    expect((await runAdmin(db, "operator", { op: "stop_run", taskId: id, runId: run!.id, reason: "stop the wrongly started drafter" })).ok).toBe(true);
    expect((await db.select().from(executorJobs).where(eq(executorJobs.op, "session"))).some((j) => (j.params as { kill?: boolean }).kill)).toBe(true);
    const ok = await runAdmin(db, "operator", { op: "reopen_decision", taskId: id, decisionId: d!.id, reason: "decision applied to the wrong block" });
    expect(ok.ok).toBe(true);
    const t = await taskRow(db, id);
    expect(t.state).toBe("BLOCKED_DECISION");
    const open = await db.select().from(decisions).where(eq(decisions.status, "open"));
    expect(open.length).toBe(1);
    expect(t.stepData).toEqual({ awaiting: open[0]!.id });
    // the control loop keeps waiting (the old decided decision is not re-applied)
    for (let i = 0; i < 5; i++) await tick(db, clk.now);
    expect((await taskRow(db, id)).state).toBe("BLOCKED_DECISION");
  });

  it("waits for a GitHub permission without offering Retry, and resumes by itself when access exists", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const { h } = scenario();
    let access = false;
    const wt = h.worktree!;
    h.worktree = (p, j) => (access ? wt(p, j) : new Error("JobError: ACCESS: the agent GitHub App installation has no access to repository bakeoff-c1 (token mint refused)"));
    h.access_check = () => ({ ok: access });
    const ex = new FakeExecutor(db, h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_access");
    const [d] = await openDecisions(db, id);
    expect(d!.options.map((o) => o.id)).toEqual(["abandon"]); // no Retry button for a permission problem
    expect(d!.why).toContain("settings/installations");
    await expect(runUntil(db, ex, clk, async () => (await taskRow(db, id)).step !== "await_access", 10)).rejects.toThrow();
    expect(ex.log.filter((l) => l.op === "worktree").length).toBe(1); // not hammered
    access = true;
    await runUntil(db, ex, clk, async () => await contractApproved(db, id));
    expect((await db.select().from(decisions).where(eq(decisions.id, d!.id)))[0]!.choice).toBe("granted");
  });

  it("refuses invalid requests and records the refusal", async () => {
    const { db, project } = await setup();
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    expect((await runAdmin(db, "owner", { op: "reset_budget", taskId: id, reason: "nothing was charged yet" })).ok).toBe(false);
    expect((await runAdmin(db, "owner", { op: "set_state", taskId: id, reason: "not an operation that exists" })).ok).toBe(false);
    expect((await runAdmin(db, "owner", { op: "pause", taskId: id, reason: "short" })).ok).toBe(false);
    const audit = await db.select().from(adminActions);
    expect(audit.every((a) => a.outcome === "refused")).toBe(true);
    expect((await db.select().from(tasks)).length).toBe(1);
  });
});
