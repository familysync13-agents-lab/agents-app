import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { seedProjects } from "@/db/seed";
import { tick } from "./orchestrator";
import { sealBacklog } from "./evidence";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not configured");
const db = await createDb(url);
await migrate(db, url);
await seedProjects(db);
// Evidence phase: rows written before it are structured and sealed once (idempotent)
const sealedNow = await sealBacklog(db);
if (sealedNow) console.log(JSON.stringify({ evidence_backfilled: sealedNow }));
console.log(JSON.stringify({ worker: "started", at: new Date().toISOString() }));

let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
while (!stopping) {
  try {
    const r = await tick(db);
    if (r.advanced || r.errors) console.log(JSON.stringify({ tick: new Date().toISOString(), ...r }));
  } catch (e) {
    console.error(JSON.stringify({ tickError: String(e).slice(0, 500) }));
  }
  await new Promise((res) => setTimeout(res, 3000));
}
process.exit(0);
