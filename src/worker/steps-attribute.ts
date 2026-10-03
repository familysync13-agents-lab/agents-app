import { and, eq } from "drizzle-orm";
import { runs } from "@/db/schema";
import { arbiterPrompt, VERIFIER_SCAFFOLD } from "@/domain/prompts";
import { submitCandidate } from "./shadow";
import type { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { correction, unmergedDependencies, waitForDependencies } from "./steps-build";
import { b64, blockEvidence, unb64, vols } from "./common";
import { finishSession, ledger, routeFor } from "./sessions";

/*
 * WORK -> CHECK -> ATTRIBUTE FAILURE -> CORRECT THE RESPONSIBLE PARTY -> RECHECK.
 * A gate failure that is not mechanically attributable goes to an independent arbiter (Verifier role, fresh session, blind to the
 * implementation's source) that reproduces each failing criterion against a live preview of the exact head and assigns an owner:
 *   implementation -> Builder correction (charged to the correction budget of this contract version)
 *   oracle         -> oracle-only repair by the Verifier (not charged; the Builder's work is kept)
 *   environment    -> re-run the gate once, then BLOCKED:EVIDENCE (never charged)
 *   ambiguity      -> owner decision (product meaning)
 * The arbiter's classification is agent judgment (recorded as such); the mechanical guards around an oracle repair (calibration, "no
 * criterion weaker", owner approval of the protected file on GitHub, then the mutation test) keep it from becoming a way around the
 * contract.
 */
export interface FailureInput {
  head: string;
  verdict: string;
  details: string;
  failing: { subject: string; detail: string; regression: boolean }[];
  builderClaim?: string;
  fact: Record<string, unknown>;
}

export type Party = "implementation" | "oracle" | "environment" | "ambiguity";
interface Attribution {
  criteria: { criterion: string; party: Party; observed?: string; expected?: string; reason?: string }[];
  summary?: string;
}

const pvKey = (id: number) => `t${id}`;

export async function attributeStart(ctx: TaskCtx): Promise<void> {
  const f = ctx.data.failure as unknown as FailureInput;
  const v = vols(ctx.task.id);
  let n = Number(ctx.data.n ?? 0);
  if (!n) {
    const prior = await ctx.db.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, ctx.task.id), eq(runs.purpose, "attribution")));
    n = prior.length + 1;
    await ctx.setData({ n });
  }
  const fallback = async (why: string) => {
    await ctx.submit("preview", { candidate: pvKey(ctx.task.id), action: "down" });
    await ctx.log("system", `Failure attribution unavailable (${why}); the gate findings go to the Builder as in V0.`, {});
    return correction(ctx, f.verdict, f.details, { ...f.fact, attribution: "unavailable" });
  };
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: f.head }));
  if (!wt) return;
  if (wt.status === "error") return fallback("worktree");
  const xf = await ctx.once("xf", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}` }));
  if (!xf) return;
  if (xf.status === "error") return fallback("export");
  const up = await ctx.once("pv", "preview", () => ({ candidate: pvKey(ctx.task.id), action: "up", xfer_ctx: `agents-${ctx.task.id}`, tag: f.head.slice(0, 12) }));
  if (!up) return;
  if (up.status === "error" || !up.result?.build_ok || !up.result?.health) return fallback("preview");
  const c = await currentContract(ctx);
  const failures = f.failing.map((x) => `- ${x.subject}${x.regression ? " (regression of an earlier task)" : ""}: ${x.detail.slice(0, 900)}`).join("\n");
  const files: Record<string, string> = {
    "contract.json": b64(c?.text ?? "{}"),
    "check.mjs": b64(c?.oracleJs ?? ""),
    "FAILURES.md": b64(`# Gate verdict ${f.verdict} for ${f.head}\n\n${failures}\n`),
    "SCAFFOLD.md": b64(VERIFIER_SCAFFOLD),
  };
  for (const [name, body] of Object.entries(ctx.project.workerDocs)) files[name] = b64(body);
  const earlier = [...new Set(f.failing.filter((x) => x.regression).map((x) => x.subject.split(":")[0]!))].filter((k) => /^T[0-9]+$/.test(k)).slice(0, 6);
  if (earlier.length) {
    const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha: f.head, paths: earlier.flatMap((k) => [`tasks/${k}/contract.json`, `oracle/${k}/check.mjs`]) }));
    if (!show) return;
    for (const k of earlier) {
      const c1 = show.result?.[`tasks/${k}/contract.json`];
      const o1 = show.result?.[`oracle/${k}/check.mjs`];
      if (typeof c1 === "string") files[`${k}-contract.json`] = c1;
      if (typeof o1 === "string") files[`${k}-check.mjs`] = o1;
    }
  }
  const job = await ctx.once("arb", "verifier", () => ({
    work_vol: v.verifier(`a${n}`),
    preview: pvKey(ctx.task.id),
    prompt: arbiterPrompt(ctx.task.key!, f.head, f.builderClaim),
    files,
  }));
  if (!job) return;
  if (job.status === "error") return fallback("arbiter session");
  const container = String(job.result?.detached ?? "");
  const runId = await ctx.startRun({ role: "verifier", purpose: "attribution", container, status: "running", ...ledger("attribution", await routeFor(ctx, "attribution")) });
  await ctx.log("verifier", `Independent arbiter started: who owns the failure of ${f.head.slice(0, 8)} (${f.failing.map((x) => x.subject).join(", ").slice(0, 160)})?`, { run: runId });
  await ctx.goto("attribute_poll", { failure: f as unknown as Record<string, unknown>, n, runId, container, started: ctx.now().getTime(), envRetried: ctx.data.envRetried ?? false });
}

export async function attributePoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") {
    if ((ctx.now().getTime() - Number(ctx.data.started)) / 1000 < 30 * 60) return;
    await ctx.submit("session", { name: ctx.data.container, kill: true });
  }
  await ctx.goto("attribute_collect", { failure: ctx.data.failure, n: ctx.data.n, runId: ctx.data.runId, envRetried: ctx.data.envRetried ?? false });
}

export async function attributeCollect(ctx: TaskCtx): Promise<void> {
  const f = ctx.data.failure as unknown as FailureInput;
  const n = Number(ctx.data.n ?? 1);
  const runId = ctx.data.runId as number;
  const dump = await ctx.once("dump", "dump", () => ({ vol: vols(ctx.task.id).verifier(`a${n}`), paths: ["out/attribution.json"] }));
  if (!dump) return;
  const down = await ctx.once("down", "preview", () => ({ candidate: pvKey(ctx.task.id), action: "down" }));
  if (!down) return;
  const raw = dump.status === "done" ? unb64(dump.result?.["out/attribution.json"]) : null;
  let a: Attribution | null = null;
  try {
    a = raw ? (JSON.parse(raw) as Attribution) : null;
  } catch {
    a = null;
  }
  // an arbiter verdict about criteria of an earlier task whose work is simply not merged yet must not be acted on (no check rewritten)
  if (f.verdict === "FAIL:REGRESSION") {
    const deps = await unmergedDependencies(ctx, f.failing.filter((x) => x.regression && !/not yet required at this plan task/.test(x.detail)).map((x) => x.subject));
    if (deps.wait) {
      await ctx.updateRun(runId, { outcome: raw ? "output" : "no_structured_outcome" });
      await ctx.setData({ head: f.head, checkRun: (f.fact as { check_run?: unknown }).check_run ?? null });
      return waitForDependencies(ctx, deps.keys, f.verdict);
    }
  }
  const parties = new Set(["implementation", "oracle", "environment", "ambiguity"]);
  const rows = (a?.criteria ?? []).filter((x) => x && parties.has(String(x.party))).slice(0, 40);
  if (!raw || rows.length === 0) {
    await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
    await ctx.log("system", "The arbiter produced no attribution; the gate findings go to the Builder.", { run: runId });
    return correction(ctx, f.verdict, f.details, { ...f.fact, attribution: "none" });
  }
  await ctx.updateRun(runId, { outcome: "output" });
  const art = await ctx.artifact("attribution", `attribution.json (run ${runId})`, raw);
  for (const x of rows)
    await ctx.evidence({
      subject: `attribution:${/^T[0-9]+:/.test(String(x.criterion)) ? String(x.criterion) : `${ctx.task.key}:${String(x.criterion)}`}`,
      status: x.party === "implementation" ? "not_verified" : "unknown",
      oracle: "agent_judgment",
      persistence: "point_in_time",
      source: `arbiter:${runId}`,
      commitSha: f.head,
      detail: `${x.party.toUpperCase()}: ${String(x.reason ?? "").slice(0, 600)}\nObserved: ${String(x.observed ?? "").slice(0, 400)}\nExpected: ${String(x.expected ?? "").slice(0, 400)}`,
      artifactId: art,
    });
  const by = (p: Party) => rows.filter((x) => x.party === p);
  const summary = rows.map((x) => `${String(x.criterion)}=${x.party}`).join(", ");
  await ctx.log("verifier", `Arbiter: ${summary}. ${String(a?.summary ?? "").slice(0, 300)}`, { run: runId, artifact: art });
  const fact = { ...f.fact, attribution: summary, arbiter_run: runId, artifact: art };
  // SHADOW MODE: a not-yet-qualified candidate gets the same bounded findings; its answer is recorded and compared, never used
  try {
    await submitCandidate(ctx.db, { taskId: ctx.task.id, risk: ctx.task.tier, details: f.details, expected: [...new Set(rows.map((x) => String(x.party)))].sort().join("+"), mode: "shadow" });
  } catch {
    /* shadow bookkeeping never affects the task */
  }

  if (by("ambiguity").length) {
    await ctx.transition("BLOCKED_DECISION", `Product ambiguity found while attributing the failure of ${f.head.slice(0, 8)}`, fact, { resumeState: "VERIFYING" });
    const amb = by("ambiguity");
    await ctx.openDecision({
      kind: "block",
      title: `The contract of ${ctx.task.key} allows two readings`,
      why: amb.map((x) => `${x.criterion}: ${x.reason ?? ""} (observed: ${x.observed ?? ""}; expected: ${x.expected ?? ""})`).join("\n").slice(0, 3000),
      options: [
        { id: "o1", label: "Clarify the contract (write the intended behaviour in the note)", consequence: "The contract is revised with your note; you review it once; the Builder continues." },
        { id: "abandon", label: "Abandon the task", consequence: "Nothing is merged." },
      ],
      recommendation: "o1",
      context: { stage: "build", artifactId: art },
    });
    return ctx.goto("await_decision", {});
  }
  const foreign = by("oracle").filter((x) => /^T[0-9]+:/.test(String(x.criterion)) && !String(x.criterion).startsWith(`${ctx.task.key}:`));
  if (foreign.length) {
    // stale/defective REGRESSION checks (earlier tasks): their checks are updated, with the owner's approval on GitHub
    const map = new Map<string, { key: string; criteria: string[]; reason: string }>();
    for (const x of foreign) {
      const [key, ac] = String(x.criterion).split(":") as [string, string];
      const t = map.get(key) ?? { key, criteria: [], reason: "" };
      t.criteria.push(ac);
      t.reason += `${ac}: ${x.reason ?? ""}\n  observed in the application: ${x.observed ?? ""}\n  required: ${x.expected ?? ""}\n`;
      map.set(key, t);
    }
    await ctx.log("system", `The arbiter attributes the regression failures to the checks of ${[...map.keys()].join(", ")} (stale against the approved contract of ${ctx.task.key}); the Verifier updates them. Nothing is charged to the Builder.`, fact);
    return ctx.goto("regress_start", { targets: [...map.values()], i: 0, done: [], head: f.head, round: n });
  }
  if (by("oracle").length) {
    // repair the check first (the Builder's work is kept); implementation failures, if any, are re-judged against the repaired check
    const c = await currentContract(ctx);
    const reason = by("oracle")
      .map((x) => `${String(x.criterion).replace(/^.*:/, "")}: ${x.reason ?? ""}${x.observed ? ` (observed in the app: ${x.observed})` : ""}`)
      .join("\n");
    await ctx.log("system", `Oracle defect confirmed by the arbiter (${by("oracle").length} criterion/criteria); the Verifier repairs the check. No correction is charged to the Builder.`, fact);
    return ctx.goto("oracle_start", {
      mode: "repair",
      feedback: reason,
      repairReason: reason,
      prevCalibration: c?.calibration ?? null,
      repaired: by("oracle").map((x) => String(x.criterion)),
      resume: { head: f.head },
      round: n,
    });
  }
  if (by("implementation").length) {
    const extra = by("implementation")
      .map((x) => `- ${String(x.criterion).replace(/^.*:/, "")} independently reproduced: observed ${x.observed ?? "?"}; the contract requires ${x.expected ?? "?"}`)
      .join("\n");
    return correction(ctx, f.verdict, `${f.details}\n\nIndependent reproduction (arbiter, black-box):\n${extra}`, fact);
  }
  // environment only
  if (!ctx.data.envRetried) {
    await ctx.log("system", "The arbiter attributes the failure to the test environment; the gate is re-run once (not charged).", fact);
    return ctx.goto("regate", { head: f.head, envRetried: true, afterRun: f.fact.check_run ?? 0 });
  }
  return blockEvidence(ctx, `The gate failed twice for environment reasons (${summary}); not charged to the work.`, fact);
}

/** Step: re-run the gate on the same head (environment failure), then wait for it as usual. */
export async function regate(ctx: TaskCtx): Promise<void> {
  const r = await ctx.once("refresh", "transport", () => ({ repo: ctx.project.repo, ops: [{ op: "refresh_pr", id: "r", pr: ctx.task.prNumber }] }));
  if (!r) return;
  if (r.status === "error") return blockEvidence(ctx, "Could not re-run the gate.", { job: r.id });
  await ctx.goto("await_gate", { head: ctx.data.head, since: ctx.now().getTime(), envRetried: true, afterRun: ctx.data.afterRun ?? 0 });
}
