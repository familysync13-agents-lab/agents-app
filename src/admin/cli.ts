/**
 * Operator entry point for the audited admin operations (used by the host daemon's `app_admin` op via `docker exec` on the worker
 * container, request JSON on stdin). Same validation and audit trail as the owner UI; the actor is recorded as "operator".
 */
import { desc, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { activity, qualificationBatches, qualificationRecords, tasks } from "@/db/schema";
import type { SemanticClass } from "@/domain/router";
import { runAdmin } from "@/server/admin";
import { assemblePackage, auditEvidence, replayEvidence } from "@/worker/evidence";
import { proposeIntent } from "@/server/proposals";
import { routeTable } from "@/worker/shadow";
import { holdoutDecide, holdoutReference, holdoutStatus, qualifyRun, qualifyStatus, qualifyVerify, routeTableAll, submitSemantic } from "@/worker/qualify";

async function main() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  const db = await createDb(process.env.DATABASE_URL!);
  if ((req as { op?: string }).op === "propose_intent") {
    const row = await proposeIntent(db, "operator", (req as { proposal: unknown }).proposal);
    process.stdout.write(JSON.stringify({ ok: true, proposal: row.id }) + "\n");
    process.exit(0);
  }
  // Builder phase: the Router's rule table (read-only) and the qualification harness (replays recorded cases through the candidate)
  const op = (req as { op?: string }).op;
  const out = (o: unknown) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
  // the Router's rule table (read-only): the ten primary classes, or with all:true also the local-worker classes
  // Evidence: integrity audit of a task's evidence (or of every task), and the evidence package of a head (assembled on demand, stage "audit")
  if (op === "evidence_audit") {
    const one = (req as { taskId?: number }).taskId;
    const ids = one ? [one] : (await db.select({ id: tasks.id }).from(tasks)).map((t) => t.id);
    const res = [];
    for (const id of ids) { const a = await auditEvidence(db, id); res.push({ task: id, ok: a.ok, rows: a.chain.rows, sealed: a.chain.sealed, backfilled: a.backfilled, chain_head: a.chain.head?.slice(0, 16) ?? null, problems: a.chain.problems.slice(0, 3), artifacts_bad: a.artifacts.bad, artifacts_missing: a.artifacts.missing }); }
    out({ ok: res.every((r) => r.ok), tasks: res });
  }
  if (op === "evidence_replay") out({ ok: true, ...(await replayEvidence(db, (req as { taskId?: number }).taskId)) });
  if (op === "evidence_package") {
    const r = req as { taskId: number; head?: string; full?: boolean };
    const [t] = await db.select().from(tasks).where(eq(tasks.id, r.taskId));
    if (!t) out({ ok: false, error: "no such task" });
    const head = r.head ?? t!.headSha;
    if (!head) out({ ok: false, error: "the task has no head yet" });
    const p = await assemblePackage(db, t!, { head: head!, stage: "audit" });
    out({ ok: true, id: p.id, sha256: p.sha256, artifact: p.artifactId, status: p.pkg.status, scope: p.pkg.body.scope, plan_task: p.pkg.body.plan_task, summary: p.pkg.summary, gaps: p.pkg.body.gaps.slice(0, 8), inconsistencies: p.pkg.body.inconsistencies, handoff: p.pkg.body.handoff, ...(r.full ? { criteria: p.pkg.body.criteria } : {}) });
  }
  if (op === "route_brief") out({ ok: true, routes: (await routeTableAll(db)).map((r) => `${r.taskClass} -> ${r.worker} (${r.model})${r.promotable.length ? ` | promotable: ${r.promotable.map((p) => `${p.worker} ${p.status} ${p.agree}/${p.samples}`).join(", ")}` : ""}`) });
  if (op === "route_table") out({ ok: true, routes: (req as { all?: boolean }).all ? await routeTableAll(db) : await routeTable(db) });
  // qualification harness of the local workers: run the pinned cases of a class, read the evidence, verify, void
  if (op === "qualify_run") out({ ok: true, ...(await qualifyRun(db, String((req as { class?: string }).class), { ids: (req as { ids?: string[] }).ids, repo: (req as { repo?: string }).repo, worker: (req as { worker?: string }).worker, holdout: (req as { holdout?: boolean }).holdout === true })) });
  // promotion by holdout: calibrate the references, read the evidence, record the decision in the qualification records
  // compact evidence of one class (any harness class): per worker and mode, with every failed case. Small output by design.
  if (op === "qualify_brief") {
    const cls = String((req as { class?: string }).class);
    const rows = (await db.select().from(qualificationRecords).where(eq(qualificationRecords.taskClass, cls))).filter((r) => !r.voided && r.gate !== null);
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(`${r.worker}|${r.model}|${r.mode}`, [...(groups.get(`${r.worker}|${r.model}|${r.mode}`) ?? []), r]);
    out({ ok: true, class: cls, groups: [...groups.entries()].map(([k, rs]) => ({ key: k, samples: rs.length, gatePass: rs.filter((r) => r.gate).length, invalid: rs.filter((r) => r.valid === false).length, verifierPass: rs.filter((r) => r.verifier === "pass").length, verifierFail: rs.filter((r) => r.verifier === "fail").length, verifierPending: rs.filter((r) => r.gate && r.verifier === null).length, agree: rs.filter((r) => r.agree === true).length, medianMs: [...rs.map((r) => r.durationMs ?? 0)].sort((x, y) => x - y)[Math.floor(rs.length / 2)] ?? null, failures: rs.filter((r) => r.agree === false).map((r) => ({ case: r.caseId, gate: r.gate, valid: r.valid, verifier: r.verifier, why: r.gate === false ? JSON.stringify((r.gateDetail as { problems?: unknown } | null)?.problems ?? null).slice(0, 260) : String(r.verifierNote ?? "").slice(0, 260), output: JSON.stringify(r.output).slice(0, 200) })) })) });
  }
  if (op === "holdout_reference") out({ ok: true, ...(await holdoutReference(db, String((req as { class?: string }).class))) });
  if (op === "holdout_status") out({ ok: true, status: await holdoutStatus(db) });
  if (op === "holdout_decide") { const r = req as { class: string; worker: string; decision: "promoted" | "rejected"; note?: string }; out({ ok: true, ...(await holdoutDecide(db, { cls: r.class, worker: r.worker, decision: r.decision, note: String(r.note ?? "") })) }); }
  if (op === "qualify_status") out({ ok: true, status: await qualifyStatus(db), batches: await db.select().from(qualificationBatches).orderBy(desc(qualificationBatches.id)).limit(12) });
  if (op === "qualify_verify") out({ ok: true, ...(await qualifyVerify(db, (req as { class?: string }).class)) });
  if (op === "qualify_void") {
    // records that are no evidence about a worker's quality stay in the audit history but never count: everything produced by a
    // model that cannot generate (embedding-only) or without a recorded model, and - on request - one class of one worker
    const rows = await db.select().from(qualificationRecords);
    const cls = (req as { class?: string }).class;
    const bad = rows.filter((r) => !r.voided && (cls ? r.taskClass === cls && r.worker === String((req as { worker?: string }).worker) && r.mode !== "production" : /embed|bge-|minilm|e5-|rerank|not a generative model/i.test(String(r.note ?? "")) || (r.model === null && r.mode !== "production")));
    for (const r of bad) await db.update(qualificationRecords).set({ voided: true, valid: false, agree: null, note: `voided (${cls ? String((req as { reason?: string }).reason ?? "superseded") : "no evidence: not produced by a qualified-candidate generative model"}): ${String(r.note ?? "").replace(/^voided \([^)]*\): /, "")}`.slice(0, 400) }).where(eq(qualificationRecords.id, r.id));
    out({ ok: true, voided: bad.length });
  }
  // one bounded semantic job for a task, through the Router (runs only on a qualified local worker)
  if (op === "semantic_job") {
    const r = req as { taskId: number; class: SemanticClass; input?: string };
    let input = r.input;
    if (!input) {
      const [t] = await db.select().from(tasks).where(eq(tasks.id, r.taskId));
      const last = await db.select({ message: activity.message }).from(activity).where(eq(activity.taskId, r.taskId)).orderBy(desc(activity.id)).limit(18);
      input = `Task ${t?.key}\n${last.reverse().map((m) => `- ${m.message.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`;
    }
    out({ ok: true, ...(await submitSemantic(db, { taskId: r.taskId, cls: r.class, input })) });
  }
  const r = await runAdmin(db, "operator", req);
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(r.ok ? 0 : 2);
}
main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n");
  process.exit(1);
});
