/**
 * Operator entry point for the audited admin operations (used by the host daemon's `app_admin` op via `docker exec` on the worker
 * container, request JSON on stdin). Same validation and audit trail as the owner UI; the actor is recorded as "operator".
 */
import { createDb } from "@/db/client";
import { runAdmin } from "@/server/admin";
import { proposeIntent } from "@/server/proposals";

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
  const r = await runAdmin(db, "operator", req);
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(r.ok ? 0 : 2);
}
main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + "\n");
  process.exit(1);
});
