import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { artifacts, evidence, evidencePackages, executorJobs, tasks } from "@/db/schema";
import { createTask } from "@/server/owner";
import { currentEvidencePackage } from "@/server/queries";
import { latestPackage } from "@/worker/evidence";
import { setup } from "./support/harness";

/* T7.a: the read-only query behind the task page's "Evidence package" card. */

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
type Db = Awaited<ReturnType<typeof setup>>["db"];

async function start() {
  const { db, project } = await setup();
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, id };
}

async function store(db: Db, taskId: number, head: string, o: { status: "complete" | "incomplete" | "blocked" | "inconsistent"; sha256: string; stage?: string; total?: number; verified?: number; verifier?: string }) {
  const [a] = await db.insert(artifacts).values({ taskId, kind: "evidence-package", name: "pkg", content: "{}", sha256: o.sha256, workerAuthored: false }).returning({ id: artifacts.id });
  const summary = { must_total: o.total ?? 3, must: { verified: o.verified ?? 2 }, verifier: o.verifier ?? "not_run" };
  const [row] = await db
    .insert(evidencePackages)
    .values({ taskId, scope: "task", planTask: null, headSha: head, contractVersion: 1, contractSha256: null, status: o.status, summary, artifactId: a!.id, sha256: o.sha256, stage: o.stage ?? "gate" })
    .returning();
  return row!;
}

const setHead = (db: Db, id: number, head: string | null) => db.update(tasks).set({ headSha: head }).where(eq(tasks.id, id));

describe("currentEvidencePackage (task page evidence card read model)", () => {
  it("returns null when the task has no head, even if packages exist", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "complete", sha256: "a".repeat(64) });
    await setHead(db, id, null);
    expect(await currentEvidencePackage(id, db)).toBeNull();
  });

  it("returns null for an unknown task and for a head without any package", async () => {
    const { db, id } = await start();
    expect(await currentEvidencePackage(id + 999, db)).toBeNull();
    await setHead(db, id, H1);
    expect(await currentEvidencePackage(id, db)).toBeNull();
  });

  it("never returns a package of an earlier head as the current one", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "complete", sha256: "a".repeat(64) });
    await setHead(db, id, H2);
    expect(await currentEvidencePackage(id, db)).toBeNull();
  });

  it("returns the recorded values of the package of the current head", async () => {
    const { db, id } = await start();
    const hash = "ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19";
    await store(db, id, H1, { status: "complete", sha256: "b".repeat(64) });
    await store(db, id, H2, { status: "incomplete", sha256: hash, total: 3, verified: 2, verifier: "not_run" });
    await setHead(db, id, H2);
    const p = await currentEvidencePackage(id, db);
    expect(p).toMatchObject({ taskId: id, headSha: H2, status: "incomplete", sha256: hash, summary: { must_total: 3, must: { verified: 2 }, verifier: "not_run" } });
  });

  it("picks the most recently stored package for the head (highest id), the same one the control loop's latestPackage reads", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "incomplete", sha256: "c".repeat(64), stage: "gate" });
    const later = await store(db, id, H1, { status: "complete", sha256: "d".repeat(64), stage: "done" });
    await store(db, id, H2, { status: "blocked", sha256: "e".repeat(64) });
    await setHead(db, id, H1);
    const p = await currentEvidencePackage(id, db);
    expect(p?.id).toBe(later.id);
    expect(p).toMatchObject({ status: "complete", sha256: "d".repeat(64), stage: "done" });
    expect(p).toEqual(await latestPackage(db, id, H1));
  });

  it("is read-only: stores, changes or queues nothing", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "incomplete", sha256: "f".repeat(64) });
    await setHead(db, id, H1);
    const snap = async () => ({
      packages: await db.select().from(evidencePackages),
      artifacts: await db.select().from(artifacts),
      evidence: await db.select().from(evidence),
      jobs: await db.select().from(executorJobs),
      task: await db.select().from(tasks).where(eq(tasks.id, id)),
    });
    const before = await snap();
    await currentEvidencePackage(id, db);
    await currentEvidencePackage(id, db);
    expect(await snap()).toEqual(before);
  });
});
