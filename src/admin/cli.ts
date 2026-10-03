/**
 * Operator entry point for the audited admin operations (used by the host daemon's `app_admin` op via `docker exec` on the worker
 * container, request JSON on stdin). Same validation and audit trail as the owner UI; the actor is recorded as "operator".
 */
import { desc, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { activity, qualificationBatches, qualificationRecords, tasks } from "@/db/schema";
import type { SemanticClass } from "@/domain/router";
import { runAdmin } from "@/server/admin";
import { proposeIntent } from "@/server/proposals";
import { routeTable } from "@/worker/shadow";
import { qualifyRun, qualifyStatus, qualifyVerify, routeTableAll, submitSemantic } from "@/worker/qualify";

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
  if (op === "route_table") out({ ok: true, routes: (req as { all?: boolean }).all ? await routeTableAll(db) : await routeTable(db) });
  // qualification harness of the local workers: run the pinned cases of a class, read the evidence, verify, void
  if (op === "qualify_run") out({ ok: true, ...(await qualifyRun(db, String((req as { class?: string }).class), { ids: (req as { ids?: string[] }).ids, repo: (req as { repo?: string }).repo, worker: (req as { worker?: string }).worker })) });
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
