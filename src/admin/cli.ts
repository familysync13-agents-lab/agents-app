/**
 * Operator entry point for the audited admin operations (used by the host daemon's `app_admin` op via `docker exec` on the worker
 * container, request JSON on stdin). Same validation and audit trail as the owner UI; the actor is recorded as "operator".
 */
import { eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { qualificationRecords } from "@/db/schema";
import { runAdmin } from "@/server/admin";
import { proposeIntent } from "@/server/proposals";
import { qualifyReplay, routeTable } from "@/worker/shadow";

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
  if ((req as { op?: string }).op === "route_table") {
    process.stdout.write(JSON.stringify({ ok: true, routes: await routeTable(db) }) + "\n");
    process.exit(0);
  }
  if ((req as { op?: string }).op === "qualify_replay") {
    process.stdout.write(JSON.stringify({ ok: true, ...(await qualifyReplay(db, Number((req as { limit?: number }).limit ?? 30))) }) + "\n");
    process.exit(0);
  }
  if ((req as { op?: string }).op === "qualify_void") {
    // records produced by a model that cannot answer at all (an embedding-only model) say nothing about quality: close them without a verdict
    const rows = await db.select().from(qualificationRecords);
    const bad = rows.filter((r) => /embed|bge-|minilm|e5-|rerank/i.test(String(r.note ?? "")) && r.agree !== null);
    for (const r of bad) await db.update(qualificationRecords).set({ valid: false, agree: null, note: `voided (not a generative model): ${r.note}` }).where(eq(qualificationRecords.id, r.id));
    process.stdout.write(JSON.stringify({ ok: true, voided: bad.length }) + "\n");
    process.exit(0);
  }
  const r = await runAdmin(db, "operator", req);
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(r.ok ? 0 : 2);
}
main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n");
  process.exit(1);
});
