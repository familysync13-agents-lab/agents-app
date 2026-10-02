import { acceptancePrompt, VERIFIER_SCAFFOLD } from "@/domain/prompts";
import { verificationPlan } from "@/domain/policy";
import type { TaskCtx } from "./context";
import { currentContract } from "./steps-contract";
import { correction, markDone } from "./steps-build";
import { b64, blockEvidence, mainSha, unb64, vols } from "./common";
import { finishSession } from "./sessions";

interface Finding {
  severity?: string;
  criterion?: string;
  title?: string;
  expected?: string;
  observed?: string;
  repro?: string[];
}

const previewKey = (taskId: number) => `t${taskId}`;

/**
 * Independent post-build check by the Verifier (different vendor, blind to code and to the Builder's narrative) against a local
 * preview of the exact head. It is one evidence source, not truth (bake-off lesson 3): its findings are agent judgment, reproduced
 * steps are stored, and only critical/high findings send the work back automatically.
 */
export async function acceptanceStart(ctx: TaskCtx): Promise<void> {
  const head = String(ctx.data.head);
  const v = vols(ctx.task.id);
  const fail = async (what: string, err: unknown) => {
    await ctx.log("executor", `Independent Verifier check unavailable (${what}): ${String(err).slice(0, 200)}`, {});
    await ctx.evidence({
      subject: "independent-verifier",
      status: "unknown",
      oracle: "agent_judgment",
      persistence: "point_in_time",
      source: "verifier:unavailable",
      commitSha: head,
      detail: `The independent Verifier check could not run (${what}); the gate's deterministic evidence stands alone.`,
    });
    // Unknown is recorded, not escalated: it blocks only where the tier requires independent evidence (critical)
    if (verificationPlan(ctx.task.tier).unknownBlocks) return blockEvidence(ctx, `Critical tier: the independent Verifier check is required but could not run (${what}).`, { head });
    await ctx.goto("mark_done", { acceptance: "unavailable" });
  };
  const wt = await ctx.once("wt", "worktree", () => ({ vol: v.final, repo: ctx.project.repo, ref: head }));
  if (!wt) return;
  if (wt.status === "error") return fail("worktree", wt.error);
  const xf = await ctx.once("xf", "vol_export", () => ({ name: v.final, dir: `agents-${ctx.task.id}` }));
  if (!xf) return;
  if (xf.status === "error") return fail("export", xf.error);
  const pv = await ctx.once("pv", "preview", () => ({ candidate: previewKey(ctx.task.id), action: "up", xfer_ctx: `agents-${ctx.task.id}`, tag: head.slice(0, 12) }));
  if (!pv) return;
  if (pv.status === "error" || !pv.result?.build_ok || !pv.result?.health) return fail("preview", pv.error ?? JSON.stringify(pv.result ?? {}).slice(0, 300));
  const c = await currentContract(ctx);
  const refs = await ctx.once("refs", "pub", () => ({ ls_remote: [ctx.project.repo] }));
  if (!refs) return;
  const sha = refs.status === "done" ? mainSha(refs, ctx.project.repo) : undefined;
  const ifaces = ctx.project.interfaceTasks.filter((k) => k !== ctx.task.key);
  const show = await ctx.once("show", "git_show", () => ({ repo: ctx.project.repo, sha: sha ?? head, paths: ifaces.map((k) => `tasks/${k}/contract.json`) }));
  if (!show) return;
  const files: Record<string, string> = { "contract.json": b64(c?.text ?? "{}"), "SCAFFOLD.md": b64(VERIFIER_SCAFFOLD) };
  const names: string[] = [];
  for (const k of ifaces) {
    const body = show.result?.[`tasks/${k}/contract.json`];
    if (typeof body === "string") {
      files[`${k}-contract.json`] = body;
      names.push(`${k}-contract.json`);
    }
  }
  for (const [n, body] of Object.entries(ctx.project.workerDocs)) files[n] = b64(body);
  const job = await ctx.once("verifier", "verifier", () => ({
    work_vol: v.verifier("acc"),
    preview: previewKey(ctx.task.id),
    prompt: acceptancePrompt(ctx.task.key!, names),
    files,
  }));
  if (!job) return;
  if (job.status === "error") return fail("verifier", job.error);
  const container = String(job.result?.detached ?? "");
  const runId = await ctx.startRun({ role: "verifier", purpose: "acceptance_check", container, status: "running" });
  await ctx.log("verifier", `Independent Verifier started against a local preview of ${head.slice(0, 8)} (blind to code).`, { run: runId });
  await ctx.goto("acceptance_poll", { head, runId, container, started: ctx.now().getTime() });
}

export async function acceptancePoll(ctx: TaskCtx): Promise<void> {
  const r = await finishSession(ctx, ctx.data.runId as number, ctx.data.container as string);
  if (r === "running") {
    if ((ctx.now().getTime() - Number(ctx.data.started)) / 1000 > 45 * 60) {
      await ctx.submit("session", { name: ctx.data.container, kill: true });
      await ctx.log("system", "Independent Verifier exceeded 45 minutes; stopped.", {});
    } else return;
  }
  await ctx.goto("acceptance_collect", { head: ctx.data.head, runId: ctx.data.runId });
}

export async function acceptanceCollect(ctx: TaskCtx): Promise<void> {
  const head = String(ctx.data.head);
  const v = vols(ctx.task.id);
  const runId = ctx.data.runId as number;
  const dump = await ctx.once("dump", "dump", () => ({ vol: v.verifier("acc"), paths: ["out/findings.json"] }));
  if (!dump) return;
  const down = await ctx.once("down", "preview", () => ({ candidate: previewKey(ctx.task.id), action: "down" }));
  if (!down) return;
  const raw = dump.status === "done" ? unb64(dump.result?.["out/findings.json"]) : null;
  let findings: Finding[] = [];
  let parsed: { checked?: unknown; unknown?: unknown } = {};
  if (raw) {
    try {
      const j = JSON.parse(raw) as { findings?: Finding[]; checked?: unknown; unknown?: unknown };
      findings = Array.isArray(j.findings) ? j.findings.slice(0, 50) : [];
      parsed = j;
    } catch {
      findings = [];
    }
  }
  if (!raw) {
    await ctx.updateRun(runId, { outcome: "no_structured_outcome" });
    await ctx.evidence({
      subject: "independent-verifier",
      status: "unknown",
      oracle: "agent_judgment",
      persistence: "point_in_time",
      source: `verifier:${runId}`,
      commitSha: head,
      detail: "The Verifier wrote no structured findings file.",
    });
    if (verificationPlan(ctx.task.tier).unknownBlocks) return blockEvidence(ctx, "Critical tier: the independent Verifier wrote no findings file.", { head, run: runId });
    return ctx.goto("mark_done", { acceptance: "no_output" });
  }
  await ctx.updateRun(runId, { outcome: "output" });
  const art = await ctx.artifact("verifier-findings", `findings.json (run ${runId})`, raw);
  for (const f of findings)
    await ctx.evidence({
      subject: `finding:${String(f.criterion ?? "general").slice(0, 60)}`,
      status: "not_verified",
      oracle: "agent_judgment",
      persistence: "point_in_time",
      source: `verifier:${runId}`,
      commitSha: head,
      severity: String(f.severity ?? "low").toLowerCase(),
      detail: `${f.title ?? ""}\nExpected: ${f.expected ?? ""}\nObserved: ${f.observed ?? ""}`.slice(0, 2000),
      artifactId: art,
    });
  if (findings.length === 0)
    await ctx.evidence({
      subject: "independent-verifier",
      status: "verified",
      oracle: "agent_judgment",
      persistence: "point_in_time",
      source: `verifier:${runId}`,
      commitSha: head,
      detail: `No reproduced defect. Checked: ${JSON.stringify(parsed.checked ?? []).slice(0, 800)}`,
      artifactId: art,
    });
  const blocking = findings.filter((f) => ["critical", "high"].includes(String(f.severity ?? "").toLowerCase()));
  await ctx.log("verifier", `Independent Verifier: ${findings.length} finding(s)${blocking.length ? `, ${blocking.length} critical/high` : ""}.`, { run: runId, artifact: art });
  if (blocking.length > 0) {
    const details = blocking
      .map((f, i) => `${i + 1}. [${f.severity}] ${f.criterion ?? ""} - ${f.title ?? ""}\n   expected: ${f.expected ?? ""}\n   observed: ${f.observed ?? ""}\n   steps: ${(f.repro ?? []).join(" | ")}`)
      .join("\n");
    return correction(ctx, "VERIFIER:DEFECT", `The independent Verifier reproduced these defects against a preview of your build:\n${details}`, {
      verifier_run: runId,
      head,
      artifact: art,
    });
  }
  // token policy: the oracle mutation test (an extra AI session and previews) runs for the critical tier only
  await ctx.goto(verificationPlan(ctx.task.tier).mutation ? "mutation_start" : "mark_done", { acceptance: { run: runId, findings: findings.length } });
}

export { markDone };
