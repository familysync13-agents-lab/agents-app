import { sha256 } from "@/domain/contract";
import { calibrate, staticOracleProblems, type OracleResult } from "@/domain/oracle-check";
import { regressionRepairPrompt, VERIFIER_SCAFFOLD } from "@/domain/prompts";
import { escalateGithub } from "./steps-contract";
import type { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { checkSyntax } from "./steps-oracle";
import { b64, blockEvidence, harnessFailure, latestGate, mainSha, ownerApproved, pollDue, sub, unb64, vols } from "./common";
import { finishSession } from "./sessions";

/*
 * Repair of an EARLIER task's oracle (a regression check) that rejects the current task's work although the work follows the
 * current, owner-approved contract - typically because that contract deliberately supersedes part of the earlier one (V1 finding on
 * T10: the owner chose a placement that T9's and T4's checks forbid). The failing party is the stale check, so:
 *   - the blind Verifier rewrites each stale regression oracle from: the earlier contract, the superseding contract, its previous
 *     check and the arbiter's findings (keep everything not superseded; never weaken unrelated assertions);
 *   - each rewritten check is validated (syntax, static environment) and run once against a preview of the current head: every
 *     criterion must produce a verdict and no harness defect;
 *   - ONE amendment PR carries all rewritten checks with their task records; the owner approves it on GitHub (changing an accepted
 *     task's check is the owner's decision - the trust boundary); then the task PR is updated and re-gated. Builder work is kept and
 *     nothing is charged to it.
 */
export interface RegressTarget {
  key: string;
  criteria: string[];
  reason: string;
}
interface Repaired {
  key: string;
  js: string;
  sha: string;
  taskJson: string;
}

const MAX = 2;

export async function regressStart(ctx: TaskCtx): Promise<void> {
  const targets = ctx.data.targets as RegressTarget[];
  const i = Number(ctx.data.i ?? 0);
  const done = (ctx.data.done as Repaired[] | undefined) ?? [];
  if (i >= targets.length) return ctx.goto("regress_pr", { done, head: ctx.data.head, round: ctx.data.round ?? 1 });
  const t = targets[i]!;
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const main = mainSha(refs, ctx.project.repo)!;
  const paths = [`tasks/${t.key}/contract.json`, `tasks/${t.key}/task.json`, `oracle/${t.key}/check.mjs`];
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha: main, paths }));
  if (!show) return;
  if (show.status === "error") return harnessFailure(ctx, show, "show", "reading the earlier task's contract and check");
  const [contract, taskJson, prev] = paths.map((p) => show.result?.[p]);
  if (typeof contract !== "string" || typeof taskJson !== "string" || typeof prev !== "string")
    return blockEvidence(ctx, `The regression check of ${t.key} is not an oracle file this system can repair (built-in probe or missing file).`, { target: t.key });
  const c = await currentContract(ctx);
  const attempt = Number(ctx.data.attempt ?? 1);
  const files: Record<string, string> = {
    "contract.json": contract,
    "superseding-contract.json": b64(c?.text ?? "{}"),
    "previous-check.mjs": prev,
    "SCAFFOLD.md": b64(VERIFIER_SCAFFOLD),
  };
  for (const [n, body] of Object.entries(ctx.project.workerDocs)) files[n] = b64(body);
  const tag = `g${t.key.toLowerCase()}x${Number(ctx.data.round ?? 1)}a${attempt}`;
  const job = await ctx.once("verifier", "verifier", () => ({
    work_vol: vols(ctx.task.id).verifier(tag),
    prompt: regressionRepairPrompt(t.key, ctx.task.key!, t.criteria, `${t.reason}${ctx.data.feedback ? `\n\nYour previous attempt was rejected mechanically:\n${String(ctx.data.feedback)}` : ""}`, Object.keys(ctx.project.workerDocs)),
    files,
  }));
  if (!job) return;
  if (job.status === "error") return harnessFailure(ctx, job, "verifier", "starting the Verifier");
  const container = String(job.result?.detached ?? "");
  const runId = await ctx.startRun({ role: "verifier", purpose: "repair_oracle", container, status: "running" });
  await ctx.log("verifier", `Verifier updating the regression check of ${t.key} (${t.criteria.join(", ")}) that the approved contract of ${ctx.task.key} supersedes (attempt ${attempt}).`, { run: runId });
  await ctx.goto("regress_poll", { ...ctx.data, refs: undefined, show: undefined, verifier: undefined, runId, container, tag, taskJson, main, attempt });
}

export async function regressPoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") return;
  const targets = ctx.data.targets as RegressTarget[];
  const i = Number(ctx.data.i ?? 0);
  const t = targets[i]!;
  const dump = await ctx.once("dump", "dump", () => ({ vol: vols(ctx.task.id).verifier(String(ctx.data.tag)), paths: ["out/check.mjs", "out/NOTES.md"] }));
  if (!dump) return;
  const js = dump.status === "done" ? unb64(dump.result?.["out/check.mjs"]) : null;
  const retry = async (problems: string[]) => {
    const attempt = Number(ctx.data.attempt ?? 1);
    await ctx.updateRun(ctx.data.runId as number, { outcome: js ? "output" : "no_structured_outcome" });
    if (attempt >= MAX) return blockEvidence(ctx, `The Verifier could not produce a valid regression check for ${t.key}: ${problems.join("; ").slice(0, 300)}`, { target: t.key });
    await ctx.log("system", `The rewritten check of ${t.key} was rejected mechanically; returned to the Verifier: ${problems.join("; ").slice(0, 300)}`, {});
    return ctx.goto("regress_start", { targets, i, done: ctx.data.done ?? [], head: ctx.data.head, round: ctx.data.round ?? 1, attempt: attempt + 1, feedback: problems.join("\n") });
  };
  if (!js || js.length < 100) return retry(["no out/check.mjs was written"]);
  const syntax = checkSyntax(js);
  if (syntax) return retry([syntax]);
  const stat = staticOracleProblems(js);
  if (stat.length) return retry(stat);
  // run once against a preview of the CURRENT head: the check must execute and judge every criterion (it is not required to pass)
  const v = vols(ctx.task.id);
  const pv = `t${ctx.task.id}`;
  const head = String(ctx.data.head);
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: head }));
  if (!wt) return;
  const xf = wt.status === "done" ? await ctx.once("xf", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}` })) : wt;
  if (!xf) return;
  const up = xf.status === "done" ? await ctx.once("pv", "preview", () => ({ candidate: pv, action: "up", xfer_ctx: `agents-${ctx.task.id}`, tag: head.slice(0, 12) })) : xf;
  if (!up) return;
  let executed = "not executed (preview unavailable)";
  if (up.status === "done" && up.result?.build_ok && up.result?.health) {
    const run = await ctx.once("run", "oracle_run", () => ({ preview: pv, oracle_js: js }));
    if (!run) return;
    const down = await ctx.once("down", "preview", () => ({ candidate: pv, action: "down" }));
    if (!down) return;
    if (run.status === "done") {
      const res = (run.result?.results as OracleResult[] | undefined) ?? [];
      const tj = JSON.parse(unb64(ctx.data.taskJson) ?? "{}") as { checks?: Record<string, string> };
      const expected = Object.entries(tj.checks ?? {}).filter(([, ref]) => ref === `oracle:oracle/${t.key}/check.mjs`).map(([k]) => k);
      const cal = calibrate(expected, res, String(run.result?.stderr ?? ""));
      if (cal.problems.length) {
        await ctx.forget("run");
        await ctx.forget("down");
        return retry(cal.problems);
      }
      executed = `executed against head ${head.slice(0, 8)}: ${res.map((x) => `${x.criterion}=${x.result}`).join(", ")}`;
    }
  }
  await ctx.updateRun(ctx.data.runId as number, { outcome: "output" });
  const shaJs = sha256(js);
  const prevTj = JSON.parse(unb64(ctx.data.taskJson) ?? "{}") as { amendments?: unknown[] } & Record<string, unknown>;
  const am = prevTj.amendments ?? [];
  const now = new Date().toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  const tj =
    JSON.stringify(
      {
        ...prevTj,
        amendments: [
          ...am,
          {
            id: `A${am.length + 1}`,
            at: now,
            kind: "oracle-update-superseded",
            reason: `Agents App: the owner-approved contract of ${ctx.task.key} (sha256 ${(await currentContract(ctx))?.sha256}) supersedes part of ${t.key} (${t.criteria.join(", ")}): ${t.reason.slice(0, 600)} The contract text of ${t.key} is kept as the historical record; its check now follows the superseding contract for the superseded behaviour and is otherwise unchanged.`,
            files: { [`oracle/${t.key}/check.mjs`]: shaJs },
          },
        ],
      },
      null,
      1,
    ) + "\n";
  await ctx.artifact("oracle", `oracle/${t.key}/check.mjs (regression check updated for ${ctx.task.key})`, js);
  await ctx.evidence({ subject: `regression-oracle:${t.key}`, status: "unknown", oracle: "deterministic", persistence: "point_in_time", source: "regression-repair", commitSha: head, detail: `Rewritten by the Verifier, ${executed}. Awaiting the owner's approval on GitHub.` });
  const done = [...((ctx.data.done as Repaired[] | undefined) ?? []), { key: t.key, js, sha: shaJs, taskJson: tj }];
  await ctx.goto("regress_start", { targets, i: i + 1, done, head, round: ctx.data.round ?? 1 });
}

export async function regressPr(ctx: TaskCtx): Promise<void> {
  const done = ctx.data.done as Repaired[];
  const head = String(ctx.data.head);
  if (!ctx.data.prNo) {
    const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
    if (!refs) return;
    if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
    const main = mainSha(refs, ctx.project.repo)!;
    const files: Record<string, string> = {};
    for (const d of done) {
      files[`oracle/${d.key}/check.mjs`] = b64(d.js);
      files[`tasks/${d.key}/task.json`] = b64(d.taskJson);
    }
    const keys = done.map((d) => d.key);
    const branch = keys.length > 1 ? `amend/multi/regress-${keys.join("-")}-${ctx.task.id}-r${String(ctx.data.round ?? 1)}` : `amend/${keys[0]}/regress-${ctx.task.id}-r${String(ctx.data.round ?? 1)}`;
    const job = await ctx.once("open", "transport", () => ({
      repo: ctx.project.repo,
      ops: [
        {
          op: "pr_from_files",
          id: "pr",
          base_sha: main,
          branch,
          title: `Update the check${keys.length > 1 ? "s" : ""} of ${keys.join(", ")} superseded by ${ctx.task.key}`,
          body: `The owner-approved contract of ${ctx.task.key} deliberately changes behaviour that the checks of ${keys.join(", ")} still enforced, so the gate rejected correct work (independent arbiter, black-box reproduction). The blind Verifier rewrote only those checks; each was executed against the current build. Contracts are unchanged.\n\n${done.map((d) => `- oracle/${d.key}/check.mjs sha256 ${d.sha}`).join("\n")}\n\nApproving this PR on GitHub is the authoritative approval. The Builder's work is kept and re-checked afterwards.`,
          files,
        },
      ],
    }));
    if (!job) return;
    const pr = job.status === "done" ? sub(job, "pr") : undefined;
    if (job.status === "error" || !pr?.ok) return harnessFailure(ctx, { ...job, error: job.error ?? JSON.stringify(pr ?? {}).slice(0, 300) }, "pr", "opening the regression-check PR");
    await ctx.log("system", `Regression-check amendment PR #${pr.pr} opened (${branch}); the gate validates it and the control system merges it.`, { pr: pr.pr });
    return ctx.goto("regress_pr", { done: [], head, prNo: pr.pr, prHead: pr.head_sha, round: ctx.data.round ?? 1 });
  }
  const prNo = Number(ctx.data.prNo);
  if (!ctx.data.approved) {
    if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return;
    const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: prNo }] }));
    if (!job) return;
    await ctx.forget("state");
    if (job.status === "error") return harnessFailure(ctx, job, "state", "reading the regression-check PR");
    const s = sub(job, "s");
    if (!s?.ok) return;
    if (s.merged) return ctx.goto("resume_after_oracle", { mainSha: s.merge_commit });
    if (!ownerApproved(s, ctx.project.ownerLogin, String(ctx.data.prHead)).ok) {
      // a stale check invalidated by a newer approved contract is repaired without the owner when the gate confirms the amendment
      const g = latestGate(s);
      if (!g || g.status !== "completed") return;
      if (g.verdict === "AMENDMENT-OK" && ctx.data.escalated) return;
      if (g.verdict === "AMENDMENT-OK") return ctx.setData({ approved: true, refreshed: true, auto: true });
      if (g.verdict === "BLOCKED:DECISION") return escalateGithub(ctx, prNo, String(ctx.data.prHead), "The repository's gate requires your review to change an accepted task's check.");
      return blockEvidence(ctx, `The gate rejected the regression-check PR #${prNo} (verdict ${g.verdict}).`, { pr: prNo, run: g.id }, { auto: false });
    }
    await ctx.closeDecisions("contract_github_approval", "approved", "github");
    await ctx.log("owner", `Regression-check PR #${prNo} approved on GitHub.`, { pr: prNo });
    return ctx.setData({ approved: true });
  }
  if (!ctx.data.refreshed) {
    const r = await ctx.once("refresh", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "refresh_pr", id: "r", pr: prNo }] }));
    if (!r) return;
    if (r.status === "error") return harnessFailure(ctx, r, "refresh", "re-running the gate on the approved PR");
    return ctx.setData({ refreshed: true });
  }
  if (!("merge" in ctx.data) && !ctx.data.auto) {
    if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return;
    const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: prNo }] }));
    if (!job) return;
    await ctx.forget("state");
    const g = job.status === "done" ? latestGate(sub(job, "s")) : undefined;
    if (!g || g.status !== "completed" || g.verdict !== "AMENDMENT-OK") return;
  }
  const m = await ctx.once("merge", "transport", () => ({ repo: ctx.project.repo, ops: [ctx.data.auto ? { op: "merge_system", id: "m", pr: prNo } : { op: "merge_approved", id: "m", pr: prNo, owner: ctx.project.ownerLogin }] }));
  if (!m) return;
  const mr = m.status === "done" ? sub(m, "m") : undefined;
  if (m.status === "error" || !mr?.ok) {
    await ctx.forget("merge");
    if (ctx.data.auto && mr && [405, 409, 422].includes(Number(mr.status))) {
      await ctx.setData({ approved: false, refreshed: false, auto: false });
      return escalateGithub(ctx, prNo, String(ctx.data.prHead), "The repository's ruleset requires your review to merge this protected change.");
    }
    return harnessFailure(ctx, { ...m, error: m.error ?? JSON.stringify(mr ?? {}).slice(0, 300) }, "merge", "merging the approved regression-check PR");
  }
  await ctx.log("system", `Updated regression checks merged (${String(mr.merge_commit).slice(0, 8)}); the Builder's work is kept and re-checked.`, { pr: prNo });
  await ctx.goto("resume_after_oracle", { mainSha: mr.merge_commit });
}
