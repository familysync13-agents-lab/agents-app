import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { contracts, tasks } from "@/db/schema";
import { canonicalJson, lintContract, oracleCriteria, sha256, type Contract } from "@/domain/contract";
import { draftPrompt, OUTCOME_DIR } from "@/domain/prompts";
import { TaskCtx } from "./context";
import { routineChoice } from "@/domain/policy";
import {
  b64,
  blockEvidence,
  harnessFailure,
  latestGate,
  mainSha,
  ownerApproved,
  ownerRequestedChanges,
  pollDue,
  sub,
  unb64,
  vols,
} from "./common";
import { finishSession, startSession } from "./sessions";

export type ContractRow = typeof contracts.$inferSelect;

export async function currentContract(ctx: TaskCtx): Promise<ContractRow | undefined> {
  if (!ctx.task.currentContractId) return undefined;
  const [c] = await ctx.db.select().from(contracts).where(eq(contracts.id, ctx.task.currentContractId));
  return c;
}

/** Step: assign the task key (next free T<n> across the repository's main branch and this system's tasks). */
export async function assignKey(ctx: TaskCtx): Promise<void> {
  if (ctx.task.key) return ctx.goto("draft_start");
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const sha = mainSha(refs, ctx.project.repo);
  if (!sha) return harnessFailure(ctx, { ...refs, error: "main not found" }, "refs", "reading the repository refs");
  const tree = await ctx.once("tree", "git_show", () => ({ repo: ctx.project.repo, sha, tree: true }));
  if (!tree) return;
  if (tree.status === "error") return harnessFailure(ctx, tree, "tree", "reading the repository tree");
  const used = new Set<number>();
  for (const p of Object.keys((tree.result?.tree as Record<string, string>) ?? {})) {
    const m = /^tasks\/T([0-9]+)\//.exec(p);
    if (m) used.add(Number(m[1]));
  }
  const mine = await ctx.db
    .select({ key: tasks.key })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.project.id), isNotNull(tasks.key), ne(tasks.id, ctx.task.id)));
  for (const r of mine) if (r.key) used.add(Number(r.key.slice(1)));
  const next = Math.max(-1, ...used) + 1;
  await ctx.save({ key: `T${next}` });
  await ctx.log("system", `Task key T${next} assigned (repository main ${sha.slice(0, 8)}).`, { main: sha });
  await ctx.goto("draft_start", { mainSha: sha });
}

/** Step: start the contract drafter (a planning configuration of the Builder slot: repository read, no implementation). */
export async function draftStart(ctx: TaskCtx): Promise<void> {
  if (await ctx.builderBusy()) return; // one Builder home per project: sessions are serialized
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const sha = mainSha(refs, ctx.project.repo)!;
  const revision = ctx.data.revision as { previous: string; ownerNote: string } | undefined;
  const prompt = draftPrompt(
    { name: ctx.project.name, description: ctx.project.description, stack: ctx.project.stack },
    { key: ctx.task.key!, title: ctx.task.title, intent: ctx.task.intent, tier: ctx.task.tier },
    revision,
  );
  const started = await startSession(ctx, "draft_contract", sha, prompt);
  if (started === "wait") return;
  await ctx.goto("draft_poll", { runId: started.runId, container: started.container, baseSha: sha, revision, attempt: ctx.data.attempt ?? 1 });
}

export async function draftPoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") return;
  await ctx.goto("draft_collect", { runId: ctx.data.runId, revision: ctx.data.revision, attempt: ctx.data.attempt ?? 1 });
}

export async function draftCollect(ctx: TaskCtx): Promise<void> {
  const v = vols(ctx.task.id);
  const dump = await ctx.once("dump", "dump", () => ({ vol: v.worktree, paths: [`${OUTCOME_DIR}/contract.json`, `${OUTCOME_DIR}/BLOCKED.json`] }));
  if (!dump) return;
  if (dump.status === "error") return harnessFailure(ctx, dump, "dump", "reading the drafter's output files");
  const runId = ctx.data.runId as number;
  const blocked = unb64(dump.result?.[`${OUTCOME_DIR}/BLOCKED.json`]);
  const draft = unb64(dump.result?.[`${OUTCOME_DIR}/contract.json`]);
  if (blocked) {
    await ctx.updateRun(runId, { outcome: "blocked" });
    const art = await ctx.artifact("block-record", "BLOCKED.json (contract drafter)", blocked);
    let rec: Record<string, unknown> = {};
    try {
      rec = JSON.parse(blocked) as Record<string, unknown>;
    } catch {
      rec = { unknown: blocked.slice(0, 500) };
    }
    const options = Array.isArray(rec.options)
      ? (rec.options as unknown[]).slice(0, 6).map((o, i) =>
          typeof o === "string"
            ? { id: `o${i + 1}`, label: o, consequence: "" }
            : { id: `o${i + 1}`, label: String((o as { label?: unknown }).label ?? `Option ${i + 1}`), consequence: String((o as { consequence?: unknown }).consequence ?? "") },
        )
      : [];
    await ctx.transition("BLOCKED_DECISION", "The intent needs an owner decision before it can become a contract", {
      run: runId,
      file: `${OUTCOME_DIR}/BLOCKED.json`,
      artifact: art,
    }, { resumeState: "PROPOSED" });
    const dec = {
      kind: "block" as const,
      title: String(rec.unknown ?? "The intent needs a decision before it can become a contract"),
      why: String(rec.why ?? rec.would_resolve ?? "The contract drafter could not turn the intent into criteria without a decision it may not make."),
      options: [...options, { id: "abandon", label: "Abandon the task", consequence: "Nothing is built." }],
      recommendation: typeof rec.recommendation === "string" ? rec.recommendation : null,
      context: { stage: "contract", artifactId: art, runId },
    };
    const auto = routineChoice({ cls: rec.class, recommendation: dec.recommendation, options: dec.options, taskTier: ctx.task.tier, text: `${dec.title} ${dec.why}` });
    if (auto) await ctx.policyDecision(dec, auto, "Routine, reversible choice inside the recorded intent; the worker's recommended option was selected.");
    else await ctx.openDecision(dec);
    return ctx.goto("await_decision", {});
  }
  if (!draft) {
    await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
    const attempt = (ctx.data.attempt as number) ?? 1;
    if (attempt < 2) {
      await ctx.log("system", "The drafter wrote no contract file; drafting again.", { run: runId });
      return ctx.goto("draft_start", { revision: ctx.data.revision, attempt: attempt + 1 });
    }
    return blockEvidence(ctx, "The contract drafter produced no contract file twice.", { run: runId });
  }
  await ctx.updateRun(runId, { outcome: "output" });
  let body: unknown;
  try {
    body = JSON.parse(draft);
  } catch {
    body = null;
  }
  const lint = lintContract(body, { id: ctx.task.key!, tier: ctx.task.tier });
  const text = body ? canonicalJson(body) : draft;
  const [{ max } = { max: 0 }] = await ctx.db
    .select({ max: contracts.version })
    .from(contracts)
    .where(eq(contracts.taskId, ctx.task.id))
    .orderBy(desc(contracts.version))
    .limit(1);
  const [row] = await ctx.db
    .insert(contracts)
    .values({
      taskId: ctx.task.id,
      version: (max ?? 0) + 1,
      body: (body ?? {}) as Record<string, unknown>,
      text,
      sha256: sha256(text),
      lint,
      status: lint.ok ? "draft" : "lint_failed",
    })
    .returning();
  await ctx.save({ currentContractId: row!.id });
  if (!lint.ok) {
    await ctx.log("system", `Contract draft v${row!.version} failed lint: ${lint.problems.slice(0, 3).join("; ")}`, { contract: row!.id });
    const attempt = (ctx.data.attempt as number) ?? 1;
    if (attempt < 3)
      return ctx.goto("draft_start", {
        revision: { previous: text, ownerNote: `Mechanical contract lint failed; fix exactly these problems:\n- ${lint.problems.join("\n- ")}` },
        attempt: attempt + 1,
      });
    return blockEvidence(ctx, `The drafter could not produce a lint-clean contract: ${lint.problems.slice(0, 3).join("; ")}`, { contract: row!.id });
  }
  await ctx.log("builder", `Contract draft v${row!.version} written (${(body as Contract).criteria.length} criteria, lint clean).`, { contract: row!.id });
  await ctx.goto("oracle_start", { contractId: row!.id });
}

/** Step: wait for the owner's decision in the app (recorded by the UI on the contract row). */
export async function awaitOwnerContract(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  if (!c) return;
  if (c.status === "approved_app") return ctx.goto("contract_batch", { contractId: c.id, since: ctx.now().getTime() });
  if (c.status === "changes_requested")
    return ctx.goto("draft_start", { revision: { previous: c.text, ownerNote: c.ownerNote ?? "" }, attempt: 1 });
  if (c.status === "rejected") {
    await ctx.transition("REJECTED", "The owner rejected the intent at contract review", { contract: c.id, decision: "reject" });
    return ctx.goto("done", {});
  }
}

function taskJson(ctx: TaskCtx, c: ContractRow, existing: Record<string, unknown> | null): string {
  const now = new Date().toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  const criteria = oracleCriteria(c.body as unknown as Contract);
  const prev = (existing?.amendments as unknown[] | undefined) ?? [];
  const t = {
    id: ctx.task.key,
    status: "CONTRACTED",
    tier: ctx.task.tier,
    contract: `tasks/${ctx.task.key}/contract.json`,
    approval: {
      by: ctx.project.ownerLogin,
      contract_sha256: c.sha256,
      at: now.slice(0, 10),
      basis: `owner intent recorded in Agents App task ${ctx.task.id}; contract v${c.version} approved under the owner's standing V1 escalation policy (within intent) or by the owner in person; hash-bound amendment confirmed by the gate`,
    },
    checks: Object.fromEntries(criteria.map((id) => [id, `oracle:oracle/${ctx.task.key}/check.mjs`])),
    probe_params: (existing?.probe_params as Record<string, unknown> | undefined) ?? {},
    oracle_timeout_s: 900,
    amendments: [
      ...prev,
      {
        id: `A${prev.length + 1}`,
        at: now,
        kind: c.kind === "oracle_revision" ? "oracle-repair" : prev.length === 0 ? "contract+oracle-of-record" : "contract-amendment+oracle-of-record",
        reason:
          c.kind === "oracle_revision"
            ? `Agents App: repaired oracle of record (contract unchanged, sha256 ${c.sha256}); the previous check was defective as a check. Calibrated against main; no criterion weakened.`
            : `Agents App: owner-approved contract v${c.version} and its oracle of record (blind Verifier, authored from the contract before implementation).`,
        files: {
          [`tasks/${ctx.task.key}/contract.json`]: c.sha256,
          [`oracle/${ctx.task.key}/check.mjs`]: c.oracleSha256,
        },
      },
    ],
  };
  return JSON.stringify(t, null, 1) + "\n";
}

const BATCH_WAIT_MS = 3 * 60_000;

/**
 * Step: batch owner approvals. Contracts of the same project that the owner approves in the app in one sitting go to GitHub as ONE
 * amendment PR (the gate's amend/multi/ form: every task's files are hash-listed in its own task record), so the owner confirms them
 * with ONE GitHub approval instead of one per task. Authority is unchanged: every contract was approved individually and sha-bound in
 * the app, and the single PR shows every contract, task record and oracle.
 */
export async function contractBatch(ctx: TaskCtx): Promise<void> {
  const sibs = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.project.id), ne(tasks.id, ctx.task.id), inArray(tasks.step, ["contract_batch", "await_owner_contract"]), eq(tasks.state, "PROPOSED")));
  const reviewing = sibs.filter((t) => t.step === "await_owner_contract");
  const waiting = sibs.filter((t) => t.step === "contract_batch");
  if (reviewing.length && ctx.now().getTime() - Number(ctx.data.since ?? 0) < BATCH_WAIT_MS) return; // the owner is still reviewing siblings
  const leader = Math.min(ctx.task.id, ...waiting.map((t) => t.id));
  if (leader !== ctx.task.id) return; // the leader opens the PR for all
  if (waiting.length === 0) return ctx.goto("contract_pr", { contractId: ctx.data.contractId });
  const members = [ctx.task, ...waiting].map((t) => ({ taskId: t.id, contractId: t.currentContractId! }));
  for (const t of waiting) await ctx.db.update(tasks).set({ step: "batch_wait", stepData: { leader: ctx.task.id, since: ctx.now().getTime() } }).where(eq(tasks.id, t.id));
  await ctx.log("system", `Batching ${members.length} owner-approved contracts (${[ctx.task, ...waiting].map((t) => t.key).join(", ")}) into one GitHub approval.`, { members });
  return ctx.goto("contract_pr", { contractId: ctx.data.contractId, members });
}

/** Step: a batch member waits until the leader has opened the combined PR (then it tracks that PR; it opens nothing itself). */
export async function batchWait(ctx: TaskCtx): Promise<void> {
  const [l] = await ctx.db.select().from(tasks).where(eq(tasks.id, Number(ctx.data.leader)));
  const stale = ctx.now().getTime() - Number(ctx.data.since ?? 0) > 15 * 60_000;
  if (!l || stale || !["contract_pr", "await_github_contract", "contract_merge", "build_start"].includes(l.step)) {
    if (stale || !l || l.state !== "PROPOSED") return ctx.goto("contract_batch", { contractId: ctx.task.currentContractId, since: ctx.now().getTime() - BATCH_WAIT_MS });
  }
}

/** Step: propose contract + task record + oracle as one amendment PR (the gate requires the owner's GitHub approval of it). */
export async function contractPr(ctx: TaskCtx): Promise<void> {
  const c = await currentContract(ctx);
  if (!c || !c.oracleJs) return blockEvidence(ctx, "The approved contract has no oracle.", { contract: c?.id ?? null });
  const members = (ctx.data.members as { taskId: number; contractId: number }[] | undefined) ?? [];
  if (members.length > 1) return contractPrBatch(ctx, members);
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const sha = mainSha(refs, ctx.project.repo)!;
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha, paths: [`tasks/${ctx.task.key}/task.json`] }));
  if (!show) return;
  if (show.status === "error") return harnessFailure(ctx, show, "show", "reading the task record");
  const prev = unb64(show.result?.[`tasks/${ctx.task.key}/task.json`]);
  const tj = taskJson(ctx, c, prev ? (JSON.parse(prev) as Record<string, unknown>) : null);
  const repair = c.kind === "oracle_revision";
  const branch = `amend/${ctx.task.key}/${repair ? "oracle" : "contract"}-v${c.version}-${ctx.task.id}`;
  const job = await ctx.once("pr", "transport", () => ({
    repo: ctx.project.repo,
    ops: [
      {
        op: "pr_from_files",
        id: "pr",
        base_sha: sha,
        branch,
        title: repair ? `${ctx.task.key}: oracle repair (contract unchanged) - ${ctx.task.title}` : `${ctx.task.key}: contract v${c.version} - ${ctx.task.title}`,
        body: repair
          ? `The approved contract of ${ctx.task.key} is unchanged (sha256 ${c.sha256}). Its oracle of record was defective as a check:\n\n${String(c.ownerNote ?? "").slice(0, 1500)}\n\nThe Verifier repaired only the harness; the repaired check was calibrated against main and no criterion became weaker. Oracle sha256 ${c.oracleSha256}\n\nThe Builder's work is kept.`
          : `Owner intent turned into a contract by Agents App (task ${ctx.task.id}).\n\nContract sha256 ${c.sha256}\nOracle sha256 ${c.oracleSha256}\n\nHash-bound amendment: the gate confirms it and the control system merges it.`,
        files: {
          ...(repair ? {} : { [`tasks/${ctx.task.key}/contract.json`]: b64(c.text) }),
          [`tasks/${ctx.task.key}/task.json`]: b64(tj),
          [`oracle/${ctx.task.key}/check.mjs`]: b64(c.oracleJs!),
        },
      },
    ],
  }));
  if (!job) return;
  const pr = job.status === "done" ? sub(job, "pr") : undefined;
  if (job.status === "error" || !pr?.ok) return harnessFailure(ctx, { ...job, error: job.error ?? JSON.stringify(pr ?? {}).slice(0, 300) }, "pr", "opening the contract PR");
  await ctx.db
    .update(contracts)
    .set({ status: "pr_open", prNumber: Number(pr.pr), prHead: String(pr.head_sha) })
    .where(eq(contracts.id, c.id));
  await ctx.log("system", `${repair ? "Oracle-only amendment" : "Contract"} PR #${pr.pr} opened (${branch}); the gate validates it and the control system merges it (no owner action).`, { pr: pr.pr, head: pr.head_sha });
  await ctx.goto("await_github_contract", { contractId: c.id, pr: pr.pr, head: pr.head_sha, resume: ctx.data.resume ?? null });
}

async function contractPrBatch(ctx: TaskCtx, members: { taskId: number; contractId: number }[]) {
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  if (refs.status === "error") return harnessFailure(ctx, refs, "refs", "reading the repository refs");
  const sha = mainSha(refs, ctx.project.repo)!;
  const mts = await ctx.db.select().from(tasks).where(inArray(tasks.id, members.map((m) => m.taskId)));
  const mcs = await ctx.db.select().from(contracts).where(inArray(contracts.id, members.map((m) => m.contractId)));
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha, paths: mts.map((t) => `tasks/${t.key}/task.json`) }));
  if (!show) return;
  if (show.status === "error") return harnessFailure(ctx, show, "show", "reading the task records");
  const files: Record<string, string> = {};
  for (const t of mts) {
    const c = mcs.find((x) => x.taskId === t.id)!;
    const prev = unb64(show.result?.[`tasks/${t.key}/task.json`]);
    const mctx = new TaskCtx(ctx.db, t, ctx.project, ctx.now);
    files[`tasks/${t.key}/contract.json`] = b64(c.text);
    files[`tasks/${t.key}/task.json`] = b64(taskJson(mctx, c, prev ? (JSON.parse(prev) as Record<string, unknown>) : null));
    files[`oracle/${t.key}/check.mjs`] = b64(c.oracleJs!);
  }
  const keys = mts.map((t) => t.key).join("-");
  const branch = `amend/multi/${keys}-${ctx.task.id}`;
  const job = await ctx.once("pr", "transport", () => ({
    repo: ctx.project.repo,
    ops: [
      {
        op: "pr_from_files",
        id: "pr",
        base_sha: sha,
        branch,
        title: `Contracts ${mts.map((t) => t.key).join(", ")}: ${mts.map((t) => t.title).join(" / ")}`.slice(0, 250),
        body: `${mts.length} contracts, each approved by the owner in Agents App (sha-bound), proposed together so that ONE GitHub approval confirms them all.\n\n${mts
          .map((t) => {
            const c = mcs.find((x) => x.taskId === t.id)!;
            return `- ${t.key} ${t.title}: contract sha256 ${c.sha256}, oracle sha256 ${c.oracleSha256}`;
          })
          .join("\n")}\n\nEvery file is hash-listed in its task's own task record (tasks/<T>/task.json, latest amendment).`,
        files,
      },
    ],
  }));
  if (!job) return;
  const pr = job.status === "done" ? sub(job, "pr") : undefined;
  if (job.status === "error" || !pr?.ok) return harnessFailure(ctx, { ...job, error: job.error ?? JSON.stringify(pr ?? {}).slice(0, 300) }, "pr", "opening the combined contract PR");
  for (const c of mcs) await ctx.db.update(contracts).set({ status: "pr_open", prNumber: Number(pr.pr), prHead: String(pr.head_sha) }).where(eq(contracts.id, c.id));
  for (const t of mts)
    if (t.id !== ctx.task.id)
      await ctx.db
        .update(tasks)
        .set({ step: "await_github_contract", stepData: { contractId: t.currentContractId, pr: pr.pr, head: pr.head_sha, follower: true, leader: ctx.task.id } })
        .where(eq(tasks.id, t.id));
  await ctx.log("system", `Combined contract PR #${pr.pr} opened for ${mts.map((t) => t.key).join(", ")} (${branch}); the gate validates it and the control system merges it.`, { pr: pr.pr, head: pr.head_sha });
  await ctx.goto("await_github_contract", { contractId: ctx.data.contractId, pr: pr.pr, head: pr.head_sha, members: mts.map((t) => t.id) });
}

export async function awaitGithubContract(ctx: TaskCtx): Promise<void> {
  const prNo = ctx.data.pr as number;
  const head = ctx.data.head as string;
  if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return;
  const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: prNo }] }));
  if (!job) return;
  await ctx.forget("state");
  if (job.status === "error") return harnessFailure(ctx, job, "state", "reading the contract PR");
  const s = sub(job, "s");
  if (!s?.ok) return;
  if (s.merged) return ctx.goto("contract_merge", { ...ctx.data, merged: true, mergeCommit: s.merge_commit });
  const appr = ownerApproved(s, ctx.project.ownerLogin, head);
  if (ctx.data.follower) return; // the batch leader merges; this task follows the merge
  if (appr.ok) {
    await ctx.db.update(contracts).set({ githubApprovedAt: appr.at ? new Date(appr.at) : ctx.now() }).where(eq(contracts.id, ctx.data.contractId as number));
    await ctx.closeDecisions("contract_github_approval", "approved", "github");
    await ctx.log("owner", `Contract PR #${prNo} approved on GitHub.`, { pr: prNo, head, at: appr.at });
    return ctx.goto("contract_merge", { contractId: ctx.data.contractId, pr: prNo, head, approvedAt: appr.at, resume: ctx.data.resume ?? null });
  }
  if (ownerRequestedChanges(s, ctx.project.ownerLogin, head)) {
    if (!ctx.data.changesLogged) {
      await ctx.log("owner", `Changes requested on contract PR #${prNo} on GitHub; revise it in Agents App.`, { pr: prNo });
      await ctx.setData({ changesLogged: true });
    }
    return;
  }
  // No owner approval is needed for a hash-bound contract/check amendment when the repository gate confirms it (AMENDMENT-OK).
  const g = latestGate(s);
  if (!g || g.status !== "completed") return;
  if (g.verdict === "AMENDMENT-OK" && ctx.data.escalated) return;
  if (g.verdict === "AMENDMENT-OK") return ctx.goto("contract_merge", { contractId: ctx.data.contractId, pr: prNo, head, auto: true, gateRun: g.id, members: ctx.data.members ?? null, resume: ctx.data.resume ?? null });
  if (g.verdict === "BLOCKED:DECISION") return escalateGithub(ctx, prNo, head, "The repository's gate requires your review for this protected change.");
  return blockEvidence(ctx, `The gate rejected the contract PR #${prNo} (verdict ${g.verdict}).`, { pr: prNo, run: g.id }, { auto: false });
}

/** The repository itself (gate / ruleset) insists on the owner's review: only then is the owner asked, once. */
export async function escalateGithub(ctx: TaskCtx, prNo: number, head: string, why: string) {
  if (ctx.data.escalated) return;
  await ctx.openDecision({
    kind: "contract_github_approval",
    title: `Approve PR #${prNo} of ${ctx.task.key} on GitHub`,
    why: `${why} This is a trust boundary enforced by the repository, not by Agents App.`,
    options: [{ id: "github", label: `Approve PR #${prNo} on GitHub`, consequence: "The control system merges it and continues." }],
    context: { pr: prNo, head, repo: ctx.project.repo, org: ctx.project.org },
  });
  await ctx.log("system", `PR #${prNo} needs your approval on GitHub (${why})`, { pr: prNo });
  await ctx.setData({ escalated: true });
}

async function pollAmendmentGate(ctx: TaskCtx, prNo: number) {
  if (!("state" in ctx.data) && !(await pollDue(ctx, 30))) return undefined;
  const job = await ctx.once("state", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "pr_state", id: "s", pr: prNo }] }));
  if (!job) return undefined;
  await ctx.forget("state");
  if (job.status === "error") {
    await harnessFailure(ctx, job, "state", "reading the contract PR");
    return undefined;
  }
  return latestGate(sub(job, "s"));
}

/** Step: after the owner's GitHub approval, re-run the gate for the approval (close/reopen) and merge on AMENDMENT-OK. */
export async function contractMerge(ctx: TaskCtx): Promise<void> {
  const prNo = ctx.data.pr as number;
  const c = await currentContract(ctx);
  if (!c) return;
  if (!ctx.data.merged && ctx.data.auto) {
    const m = await ctx.once("merge", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "merge_system", id: "m", pr: prNo }] }));
    if (!m) return;
    const mr = m.status === "done" ? sub(m, "m") : undefined;
    if (m.status === "error" || !mr?.ok) {
      if (mr && [405, 409, 422].includes(Number(mr.status))) {
        // the repository's ruleset still demands a review: fall back to the owner's approval (the trust boundary decides, not the app)
        const head = String(ctx.data.head);
        await ctx.goto("await_github_contract", { contractId: ctx.data.contractId, pr: prNo, head, members: ctx.data.members ?? null, resume: ctx.data.resume ?? null });
        return escalateGithub(ctx, prNo, head, "The repository's ruleset requires your review to merge this protected change.");
      }
      await ctx.forget("merge");
      return harnessFailure(ctx, { ...m, error: m.error ?? JSON.stringify(mr ?? {}).slice(0, 300) }, "merge", "merging the gate-confirmed contract PR");
    }
    await ctx.setData({ merged: true, mergeCommit: mr.merge_commit });
    return;
  }
  if (!ctx.data.merged) {
    if (!ctx.data.refreshed) {
      const r = await ctx.once("refresh", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "refresh_pr", id: "r", pr: prNo }] }));
      if (!r) return;
      if (r.status === "error") return harnessFailure(ctx, r, "refresh", "re-running the gate on the approved contract PR");
      await ctx.setData({ refreshed: true, refreshedAt: ctx.now().getTime() });
      return;
    }
    // once the merge has been requested, wait for its result (never re-poll the PR in between)
    const g = "merge" in ctx.data ? { id: Number(ctx.data.gateRun ?? 0), verdict: "AMENDMENT-OK", status: "completed" } : await pollAmendmentGate(ctx, prNo);
    if (!g || g.status !== "completed") return;
    if (!("merge" in ctx.data)) await ctx.setData({ gateRun: g.id });
    if (g.verdict !== "AMENDMENT-OK") {
      if ((ctx.now().getTime() - Number(ctx.data.refreshedAt ?? 0)) / 1000 > 900)
        return blockEvidence(ctx, `The gate did not confirm the approved contract PR #${prNo} (verdict ${g.verdict}).`, { pr: prNo, run: g.id });
      return;
    }
    const m = await ctx.once("merge", "transport", () => ({
      repo: ctx.project.repo,
      ops: [{ op: "merge_approved", id: "m", pr: prNo, owner: ctx.project.ownerLogin }],
    }));
    if (!m) return;
    const mr = m.status === "done" ? sub(m, "m") : undefined;
    if (m.status === "error" || !mr?.ok) {
      await ctx.forget("merge");
      return harnessFailure(ctx, { ...m, error: m.error ?? JSON.stringify(mr ?? {}).slice(0, 300) }, "merge", "merging the approved contract PR");
    }
    await ctx.setData({ merged: true, mergeCommit: mr.merge_commit, approvedAt: mr.approval_at });
    return;
  }
  const mergeCommit = String(ctx.data.mergeCommit);
  await ctx.db.update(contracts).set({ status: "merged", mergeCommit }).where(eq(contracts.id, c.id));
  await ctx.db.update(contracts).set({ status: "superseded" }).where(and(eq(contracts.taskId, ctx.task.id), ne(contracts.id, c.id), eq(contracts.status, "merged")));
  if (c.kind === "oracle_revision") {
    // the contract (and so the correction budget) is unchanged; the Builder's work is re-checked against the repaired oracle
    await ctx.log("system", `Repaired oracle of ${ctx.task.key} merged (${mergeCommit.slice(0, 8)}); the Builder's work is kept and re-checked.`, {
      contract: c.id,
      oracle_sha256: c.oracleSha256,
      pr: prNo,
      merge_commit: mergeCommit,
    });
    if (ctx.task.prNumber) return ctx.goto("resume_after_oracle", { mainSha: mergeCommit });
    return ctx.goto("build_start", { mainSha: mergeCommit });
  }
  await ctx.save({ corrections: 0, extraCorrections: 0, budgetContractId: c.id });
  await ctx.transition("CONTRACTED", `Contract v${c.version} ${ctx.data.auto ? "confirmed by the gate" : "approved by the owner on GitHub"} and merged (sha256 ${c.sha256.slice(0, 12)})`, {
    contract: c.id,
    contract_sha256: c.sha256,
    oracle_sha256: c.oracleSha256,
    pr: prNo,
    merge_commit: mergeCommit,
    gate_run: ctx.data.gateRun ?? null,
    owner_approved_at: ctx.data.approvedAt ?? null,
  });
  await ctx.goto("build_start", { mainSha: mergeCommit });
}
