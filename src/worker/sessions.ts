import type { TaskCtx } from "./context";
import { blockEvidence, harnessFailure, pollDue, vols } from "./common";

/**
 * Start a Builder-slot session: a fresh worktree of the repository at `ref`, then Claude Code in its isolated container. The
 * instructions travel as a file inside the workspace (.bakeoff/PROMPT.md, written by the executor), never as argv.
 */
export async function startSession(
  ctx: TaskCtx,
  purpose: "draft_contract" | "build" | "correction",
  ref: string,
  prompt: string,
  opts: { resume?: string; freshWorktree?: boolean } = {},
): Promise<"wait" | { runId: number; container: string }> {
  const v = vols(ctx.task.id);
  if (opts.freshWorktree !== false) {
    const wt = await ctx.once("wt", "worktree", () => ({ vol: v.worktree, repo: ctx.project.repo, ref }));
    if (!wt) return "wait";
    if (wt.status === "error") {
      await harnessFailure(ctx, wt, "wt", "preparing the worktree");
      return "wait";
    }
  }
  const b = await ctx.once("builder", "builder", () => ({
    candidate: ctx.project.builderKey,
    vol: v.worktree,
    model: "opus",
    prompt_text: prompt,
    ...(opts.resume ? { resume: opts.resume } : {}),
  }));
  if (!b) return "wait";
  if (b.status === "error") {
    if (/still running/.test(String(b.error))) {
      await ctx.forget("builder"); // another session of this Builder home is running: wait for it (serialized)
      return "wait";
    }
    await harnessFailure(ctx, b, "builder", "starting the Builder");
    return "wait";
  }
  const container = String(b.result?.detached ?? "");
  const runId = await ctx.startRun({ role: "builder", purpose, container, status: "running", sessionId: opts.resume ?? null });
  await ctx.log(
    "builder",
    purpose === "draft_contract"
      ? "Contract drafter started (Builder slot, isolated container, no GitHub access)."
      : purpose === "build"
        ? `Builder started on ${ctx.task.key} (isolated container; repository ${ref.slice(0, 8)}).`
        : "Builder resumed for a correction.",
    { run: runId, container },
  );
  return { runId, container };
}

/** Poll a detached worker session; when it has exited, record its measured facts. Returns "running" or "finished". */
export async function finishSession(ctx: TaskCtx, runId: number, container: string): Promise<"running" | "finished"> {
  if (!("sess" in ctx.data) && !(await pollDue(ctx, 20))) return "running";
  const j = await ctx.once("sess", "session", () => ({ name: container, tail_lines: 2 }));
  if (!j) return "running";
  await ctx.forget("sess");
  if (j.status === "error") {
    await harnessFailure(ctx, j, "sess", "reading the worker session");
    return "running";
  }
  const r = j.result ?? {};
  if (r.running) return "running";
  const res = (r.result ?? null) as Record<string, unknown> | null;
  await ctx.updateRun(runId, {
    status: r.gone ? "harness_error" : "finished",
    exitCode: r.exit !== undefined ? String(r.exit) : r.gone ? "gone" : null,
    costUsd: typeof res?.total_cost_usd === "number" ? res.total_cost_usd : null,
    turns: typeof res?.num_turns === "number" ? res.num_turns : null,
    durationMs: typeof res?.duration_ms === "number" ? res.duration_ms : null,
    sessionId: typeof res?.session_id === "string" ? res.session_id : undefined,
    closingText: typeof res?.result === "string" ? res.result.slice(0, 4000) : typeof r.tail === "string" ? String(r.tail).slice(-1500) : null,
    finishedAt: ctx.now(),
  });
  const closing = typeof res?.result === "string" ? res.result : "";
  if (/Failed to authenticate|OAuth session expired|Invalid API key|Please run \/login/i.test(closing) && Number(res?.num_turns ?? 0) <= 1) {
    // the worker never started working: its vendor login is not usable. Not the work's fault and not fixable by retrying blindly.
    const run = await ctx.run(runId);
    await ctx.updateRun(runId, { status: "harness_error", outcome: "aborted" });
    await blockEvidence(ctx, `The ${run?.role === "verifier" ? "Verifier" : "Builder"}'s vendor login is not usable (${closing.slice(0, 120)}). This is a credential problem of the worker environment, not of the work.`, { run: runId, credential: true }, { auto: false });
    return "running";
  }
  if (typeof res?.session_id === "string") {
    const run = await ctx.run(runId);
    if (run?.role === "builder" && run.purpose !== "draft_contract") await ctx.save({ builderSessionId: res.session_id });
  }
  return "finished";
}
