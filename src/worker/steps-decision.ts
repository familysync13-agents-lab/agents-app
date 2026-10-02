import { and, eq, inArray } from "drizzle-orm";
import { decisions, type TaskState } from "@/db/schema";
import type { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { unb64, vols } from "./common";

/**
 * Step: a block waits for the owner. The UI records the decision; this step applies it. Leaving a blocked state always cites the
 * decision as its fact.
 */
export async function awaitDecision(ctx: TaskCtx): Promise<void> {
  // Only the decision opened for THIS block may unblock the task (bound by id when the task entered await_decision). An older decided
  // decision is never re-applied (V0 finding F-V0-1: a stale decision from an earlier block was applied to a later block without the owner).
  const awaiting = Number(ctx.data.awaiting);
  if (!Number.isInteger(awaiting)) return;
  const [pick] = await ctx.db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, awaiting), eq(decisions.taskId, ctx.task.id), inArray(decisions.kind, ["block", "budget"])))
    .limit(1);
  if (!pick || pick.status !== "decided" || !pick.decidedAt) return;
  const stage = String((pick.context as { stage?: string }).stage ?? "");
  const fact = { decision: pick.id, choice: pick.choice, via: pick.decidedVia };
  const who = pick.decidedVia === "policy" ? "the control system (recommended action)" : "the owner";
  const chosen = pick.options.find((o) => o.id === pick.choice);
  // an option that ends the task ends it - whatever the worker called it (never back to drafting to ask again)
  if (pick.choice === "abandon" || chosen?.action === "abandon") return abandon(ctx, `Abandoned by ${who}${chosen && chosen.id !== "abandon" ? `: ${chosen.label.slice(0, 160)}` : ""}`, fact);

  if (pick.kind === "budget") {
    await ctx.save({ extraCorrections: ctx.task.extraCorrections + 2 });
    const ctxd = pick.context as { verdict?: string; details?: string };
    await ctx.goto("fix_start", { verdict: ctxd.verdict ?? "FAIL", details: ctxd.details ?? "", head: ctx.task.headSha, fact });
    return;
  }
  if (stage === "evidence") {
    const c = pick.context as { resumeStep?: string; resumeState?: TaskState };
    await ctx.transition((c.resumeState ?? ctx.task.resumeState ?? "PROPOSED") as TaskState, `Retry after missing evidence (${who})`, fact);
    return ctx.goto(c.resumeStep ?? "draft_start", {});
  }
  if (stage === "tamper") {
    await ctx.goto("fix_start", {
      verdict: "REFUSED:PROTECTED-PATHS",
      details: "Your change modified protected paths (tasks/, oracle/, baselines/, gate/, .github/, CODEOWNERS, policy.json). Undo every change under those paths; keep the rest of your work.",
      head: ctx.task.headSha,
      fact,
    });
    return;
  }
  if (stage === "security") return abandon(ctx, "Security stop resolved by abandoning the task", fact);

  // stage "contract" (the drafter blocked) or "build" (the Builder blocked): the owner's answer becomes part of the contract
  const label = pick.choice === "custom" ? "Own answer (see note)" : (pick.options.find((o) => o.id === pick.choice)?.label ?? pick.choice ?? "");
  const answer = `${pick.decidedVia === "policy" ? "Control-system decision (your recommended routine option was applied; the owner was not asked)" : "Owner decision"}: ${label}${pick.note ? `\nOwner note: ${pick.note}` : ""}`;
  const art = (pick.context as { artifactId?: number }).artifactId;
  let blockText = "";
  if (art) {
    const { artifacts } = await import("@/db/schema");
    const [a] = await ctx.db.select().from(artifacts).where(eq(artifacts.id, art));
    blockText = a?.content ?? "";
  }
  const defect = (pick.context as { oracleDefect?: boolean; detail?: string }).oracleDefect ? String((pick.context as { detail?: string }).detail ?? "") : "";
  if (defect) blockText = `The oracle of record (acceptance check) was defective at the gate - keep the contract's meaning unchanged; the Verifier will rewrite the check. Defects: ${defect}`;
  const c = await currentContract(ctx);
  if (stage === "build") {
    // a new contract version supersedes the current work: close the open PR and start from the amended contract
    if (ctx.task.prNumber)
      await ctx.submit("transport", { repo: ctx.project.repo, ops: [{ op: "cleanup", id: "c", close: [ctx.task.prNumber], delete_branches: [ctx.task.branch] }] });
    await ctx.save({ prNumber: null, headSha: null, branch: null, builderSessionId: null });
  }
  await ctx.transition("PROPOSED", `${pick.decidedVia === "policy" ? "Decided by the control system" : "Owner decided"}; the contract is being revised with the decision`, fact);
  await ctx.goto("draft_start", {
    revision: {
      previous: `${c ? `Current contract (v${c.version}):\n${c.text}\n` : ""}${blockText ? `The ${stage === "build" ? "Builder" : "drafter"} blocked with:\n${blockText}\n` : ""}`,
      ownerNote: answer,
    },
    attempt: 1,
  });
}

export async function abandon(ctx: TaskCtx, reason: string, fact: Record<string, unknown>) {
  if (ctx.task.prNumber && ctx.task.state !== "ACCEPTED")
    await ctx.submit("transport", { repo: ctx.project.repo, ops: [{ op: "cleanup", id: "c", close: [ctx.task.prNumber] }] });
  const v = vols(ctx.task.id);
  await ctx.submit("vol_rm", { names: [v.worktree, v.export, v.final] });
  await ctx.transition("ABANDONED", reason, fact);
  await ctx.goto("done", {});
}

export { unb64 };
