import type { Contract } from "@/domain/contract";
import { mutantPrompt, OUTCOME_DIR } from "@/domain/prompts";
import type { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { unb64, vols } from "./common";
import { finishSession, startSession } from "./sessions";

/*
 * Oracle mutation test (bake-off lesson 2: all three T3 oracles missed a title/author swap). After the gate passes, a mutant
 * author (Builder slot, oracle removed from its workspace) writes up to three realistic defects; each is applied to the exact head,
 * previewed locally and judged by the task's oracle of record. A surviving mutant marks that criterion's oracle as weak
 * (Partially verified) - recorded evidence shown to the owner at acceptance, not a blocker in V0.
 */
interface Mutant {
  criterion: string;
  description: string;
  patch: string;
}
const pv = (taskId: number, i: number) => `t${taskId}m${i}`;

async function skip(ctx: TaskCtx, why: string) {
  await ctx.evidence({
    subject: "oracle-mutation",
    status: "unknown",
    oracle: "deterministic",
    persistence: "point_in_time",
    source: "mutation:unavailable",
    commitSha: ctx.task.headSha,
    detail: `Oracle mutation test not completed: ${why}`,
  });
  await ctx.log("system", `Oracle mutation test not completed (${why}); recorded as Unknown.`, {});
  await ctx.goto("mark_done", { acceptance: ctx.data.acceptance ?? null });
}

export async function mutationStart(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  const body = c?.body as unknown as Contract | undefined;
  const crit = (body?.criteria ?? []).filter((k) => k.priority === "must" && (k.type === "behavior" || k.type === "threshold"));
  if (crit.length === 0) return skip(ctx, "no black-box must-criteria");
  if (await ctx.builderBusy()) return;
  const v = vols(ctx.task.id);
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.worktree, repo: ctx.project.repo, ref: ctx.task.headSha }));
  if (!wt) return;
  if (wt.status === "error") return skip(ctx, "worktree");
  const st = await ctx.once("strip", "strip_oracles", () => ({ vol: v.worktree }));
  if (!st) return;
  if (st.status === "error") return skip(ctx, "could not remove the oracle from the mutant author's workspace");
  const prompt = mutantPrompt(
    ctx.task.key!,
    crit.map((k) => ({ id: k.id, text: [k.given && `given ${k.given}`, k.when && `when ${k.when}`, k.then && `then ${k.then}`, k.metric && `${k.metric} ${k.target}`].filter(Boolean).join("; ") })),
  );
  const s = await startSession(ctx, "correction", "", prompt, { freshWorktree: false });
  if (s === "wait") return;
  await ctx.updateRun(s.runId, { purpose: "mutants", taskClass: "mutants" });
  await ctx.goto("mutation_poll", { runId: s.runId, container: s.container, acceptance: ctx.data.acceptance ?? null });
}

export async function mutationPoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") return;
  const dump = await ctx.once("dump", "dump", () => ({ vol: vols(ctx.task.id).worktree, paths: [`${OUTCOME_DIR}/mutants.json`] }));
  if (!dump) return;
  const raw = dump.status === "done" ? unb64(dump.result?.[`${OUTCOME_DIR}/mutants.json`]) : null;
  let ms: Mutant[] = [];
  try {
    const j = JSON.parse(raw ?? "{}") as { mutants?: Mutant[] };
    ms = (j.mutants ?? []).filter((m) => m && typeof m.patch === "string" && m.patch.includes("diff")).slice(0, 3);
  } catch {
    ms = [];
  }
  await ctx.updateRun(ctx.data.runId as number, { outcome: ms.length ? "output" : "no_structured_outcome" });
  if (ms.length === 0) return skip(ctx, "the mutant author produced no mutants");
  const art = await ctx.artifact("mutants", `mutants.json (run ${String(ctx.data.runId)})`, raw!);
  await ctx.log("builder", `Mutant author wrote ${ms.length} mutant(s): ${ms.map((m) => `${m.criterion} (${m.description})`).join("; ").slice(0, 300)}`, { artifact: art });
  await ctx.goto("mutant_eval", { mutants: ms, i: 0, results: [], acceptance: ctx.data.acceptance ?? null, artifact: art });
}

export async function mutantEval(ctx: TaskCtx): Promise<void> {
  const ms = ctx.data.mutants as Mutant[];
  const i = ctx.data.i as number;
  const results = (ctx.data.results as { criterion: string; outcome: string; detail: string }[]) ?? [];
  if (i >= ms.length) return mutationFinish(ctx, results);
  const m = ms[i]!;
  const v = vols(ctx.task.id);
  const c = await currentContract(ctx);
  const next = async (outcome: string, detail: string) => {
    await ctx.once("down", "preview", () => ({ candidate: pv(ctx.task.id, i), action: "down" }));
    await ctx.goto("mutant_eval", { ...ctx.data, i: i + 1, results: [...results, { criterion: m.criterion, outcome, detail }], wt: undefined, patch: undefined, xf: undefined, pv: undefined, run: undefined, down: undefined });
  };
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: ctx.task.headSha }));
  if (!wt) return;
  if (wt.status === "error") return next("not_evaluated", "worktree failed");
  const ap = await ctx.once("patch", "apply_patch", () => ({ vol: v.final, patch: m.patch }));
  if (!ap) return;
  if (ap.status === "error" || !ap.result?.ok) return next("invalid", "the patch does not apply");
  const xf = await ctx.once("xf", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}-m${i}` }));
  if (!xf) return;
  if (xf.status === "error") return next("not_evaluated", "export failed");
  const up = await ctx.once("pv", "preview", () => ({ candidate: pv(ctx.task.id, i), action: "up", xfer_ctx: `agents-${ctx.task.id}-m${i}`, tag: `${String(ctx.task.headSha).slice(0, 12)}m${i}` }));
  if (!up) return;
  if (up.status === "error" || !up.result?.build_ok || !up.result?.health) return next("invalid", "the mutant does not build or start");
  const run = await ctx.once("run", "oracle_run", () => ({ preview: pv(ctx.task.id, i), oracle_js: c?.oracleJs ?? "" }));
  if (!run) return;
  const res = ((run.result?.results as { criterion: string; result: string; detail?: string }[]) ?? []);
  if (run.status === "error" || res.length === 0) return next("not_evaluated", "the oracle did not produce results");
  const failed = res.filter((r) => r.result !== "pass").map((r) => r.criterion);
  const killed = failed.length > 0;
  await next(killed ? "killed" : "survived", killed ? `oracle failed ${failed.join(", ")}` : "every oracle criterion still passed");
}

async function mutationFinish(ctx: TaskCtx, results: { criterion: string; outcome: string; detail: string }[]) {
  const ms = ctx.data.mutants as Mutant[];
  for (const [i, r] of results.entries()) {
    if (r.outcome === "invalid" || r.outcome === "not_evaluated") continue;
    await ctx.evidence({
      subject: `oracle-mutation:${ctx.task.key}:${r.criterion}`,
      status: r.outcome === "killed" ? "verified" : "partially_verified",
      oracle: "deterministic",
      persistence: "point_in_time",
      source: `mutation:${String(ctx.data.artifact)}`,
      commitSha: ctx.task.headSha,
      detail: `${r.outcome === "killed" ? "Mutant killed" : "Mutant SURVIVED - the oracle did not notice"}: ${ms[i]?.description ?? ""} (${r.detail})`,
      artifactId: ctx.data.artifact as number,
    });
  }
  const killed = results.filter((r) => r.outcome === "killed").length;
  const survived = results.filter((r) => r.outcome === "survived").length;
  await ctx.log("system", `Oracle mutation test: ${killed} killed, ${survived} survived, ${results.length - killed - survived} not evaluable.`, { results });
  await ctx.goto("mark_done", { acceptance: ctx.data.acceptance ?? null, mutation: { killed, survived } });
}
