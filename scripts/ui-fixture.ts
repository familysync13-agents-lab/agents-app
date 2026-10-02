/*
 * DEVELOPMENT ONLY: fills a local PGlite database by running the REAL control loop against the scripted test executor, so the UI
 * can be inspected in states that take hours to reach for real. Never used by the product.
 */
import { createHash, randomBytes } from "node:crypto";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { seedProjects } from "@/db/seed";
import { loginTokens, projects } from "@/db/schema";
import { createTask, decideContract } from "@/server/owner";
import { tick } from "@/worker/orchestrator";
import { FakeExecutor, PROJECT } from "../tests/support/harness";
import { fixtureHandlers } from "../tests/support/fixture-handlers";

const url = process.argv[2] ?? "pglite://.data/ui";
const db = await createDb(url);
await migrate(db, url);
await seedProjects(db, JSON.stringify([PROJECT]));
const [p] = await db.select().from(projects);
let t = Date.now() - 3 * 3600_000;
const now = () => new Date(t);
const run = async (n: number, h: ReturnType<typeof fixtureHandlers>) => {
  const ex = new FakeExecutor(db, h.handlers);
  for (let i = 0; i < n; i++) {
    await tick(db, now);
    await ex.drain();
    t += 25_000;
  }
};
const { tasks } = await import("@/db/schema");
const until = async (id: number, step: string, h: ReturnType<typeof fixtureHandlers>) => {
  const ex = new FakeExecutor(db, h.handlers);
  for (let i = 0; i < 400; i++) {
    const [x] = await db.select().from(tasks).where(eqq(tasks.id, id));
    if (x!.step === step) return;
    await tick(db, now);
    await ex.drain();
    t += 25_000;
  }
  const [y] = await db.select().from(tasks).where(eqq(tasks.id, id));
  throw new Error(`task ${id} did not reach ${step}: at ${y!.step} ${y!.state} ${JSON.stringify(y!.stepData).slice(0, 300)}`);
};
const { eq: eqq } = await import("drizzle-orm");
const h1 = fixtureHandlers({ failFirstGate: true });
const a = await createTask(db, { projectId: p!.id, title: "Sort reading lists A–Z", intent: "Owners should be able to sort their lists alphabetically on the list index, so long collections stay easy to scan.", tier: "standard" });
await until(a, "await_owner_contract", h1);
const { contracts } = await import("@/db/schema");
const { eq } = await import("drizzle-orm");
const [c] = await db.select().from(contracts).where(eq(contracts.taskId, a));
await decideContract(db, { taskId: a, contractId: c!.id, choice: "approve", note: "", sha256: c!.sha256 });
await run(160, h1);
const h2 = fixtureHandlers({ draftBlocked: true });
await createTask(db, { projectId: p!.id, title: "Show reading progress", intent: "Readers should see progress on lists somehow.", tier: "standard" });
await run(30, h2);
const h3 = fixtureHandlers({});
await createTask(db, { projectId: p!.id, title: "Add list descriptions", intent: "Lists get an optional description shown under the list name on the list page and on the share page.", tier: "standard" });
await run(30, h3);
// a task stopped mid-correction (oracle repair in progress) to show failure routing
const h4 = fixtureHandlers({ failFirstGate: true, oracleCrash: true });
const r = await createTask(db, { projectId: p!.id, title: "Export a list as CSV", intent: "Owners can download a list as a CSV file.", tier: "standard" });
await until(r, "await_owner_contract", h4);
const [c4] = await db.select().from(contracts).where(eq(contracts.taskId, r));
await decideContract(db, { taskId: r, contractId: c4!.id, choice: "approve", note: "", sha256: c4!.sha256 });
await run(70, h4);
const token = randomBytes(32).toString("base64url");
await db.insert(loginTokens).values({ tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600_000) });
console.log(token);
process.exit(0);
