import { describe, expect, it } from "vitest";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { artifacts, decisions, evidencePackages, qualificationRecords, runs, tasks } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { DEMO_HEAD, seedPreviewDemo } from "@/db/preview-demo";
import { currentEvidencePackage } from "@/server/queries";
import { latestPackage } from "@/worker/evidence";
import { requiredVerified, verifierStatus } from "@/components/evidence-package";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { routeTable } from "@/worker/shadow";

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  return db;
}

async function ledger(db: Awaited<ReturnType<typeof previewDb>>) {
  const keys = new Map((await db.select().from(tasks)).map((t) => [t.id, t.key]));
  return (await db.select().from(runs).orderBy(desc(runs.startedAt))).map((r) => ({
    task: keys.get(r.taskId),
    purpose: r.purpose,
    worker: r.worker,
    taskClass: r.taskClass,
    reason: r.routeReason,
    contextBytes: r.contextBytes,
    status: r.status,
  }));
}

const RUNS = [
  {
    task: "T3",
    purpose: "build",
    worker: "claude-code",
    taskClass: "build",
    reason: "trusted worker (no alternative has qualified for this class)",
    contextBytes: 48213,
    status: "finished",
  },
  {
    task: "T1",
    purpose: "draft_contract",
    worker: "claude-code",
    taskClass: "contract_draft",
    reason: "trusted worker (no alternative is defined for this class)",
    contextBytes: null,
    status: "finished",
  },
];

describe("gate preview demo data", () => {
  it("seeds representative demo tasks once (idempotent)", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    expect((await db.select().from(tasks)).map((t) => t.key)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect((await db.select().from(decisions)).map((d) => d.kind).sort()).toEqual(["acceptance", "acceptance", "block", "contract_approval"]);
  });

  it("seeds the two demo worker runs (newest first: T3 build, then T1 contract draft) and three shadow records, once", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    expect(await ledger(db)).toEqual(RUNS);
    const q = await db.select().from(qualificationRecords).orderBy(asc(qualificationRecords.id));
    expect(q).toHaveLength(3);
    for (const r of q)
      expect(r).toMatchObject({
        worker: "local-llm",
        taskClass: "log_summary",
        mode: "shadow",
        valid: true,
        agree: true,
      });
  });

  it("adds the ledger to a preview database seeded before the ledger existed", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await db.delete(runs);
    await db.delete(qualificationRecords);
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    expect((await db.select().from(tasks)).map((t) => t.key)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(await ledger(db)).toEqual(RUNS);
    expect(await db.select().from(qualificationRecords)).toHaveLength(3);
  });

  it("leaves the Router's decisions as the preview contract states (local-llm shadow for log_summary, nothing qualified)", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    const table = await routeTable(db);
    const log = table.find((r) => r.taskClass === "log_summary")!;
    expect(log).toMatchObject({
      worker: "claude-code",
      reason: "trusted worker (no alternative has qualified for this class)",
    });
    expect(log.alternatives).toMatchObject([{ worker: "local-llm", status: "shadow", samples: 3 }]);
    const triage = table.find((r) => r.taskClass === "failure_triage")!;
    expect(triage.alternatives).toMatchObject([{ worker: "local-llm", status: "unqualified", samples: 0 }]);
  });

  it("gives demo task T3 the demonstration head and one evidence package (T1 and T2 have none), once", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const byKey = new Map((await db.select().from(tasks)).map((t) => [t.key, t]));
    const t3 = byKey.get("T3")!;
    expect(t3.headSha).toBe(DEMO_HEAD);
    expect(DEMO_HEAD).toBe("3333333333333333333333333333333333333333");
    expect(byKey.get("T1")!.headSha).toBeNull();
    expect(byKey.get("T2")!.headSha).toBeNull();
    const pkgs = await db.select().from(evidencePackages);
    expect(pkgs).toHaveLength(1);
    const p = pkgs[0]!;
    expect(p).toMatchObject({ taskId: t3.id, headSha: DEMO_HEAD, status: "incomplete", sha256: "ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19" });
    const [a] = await db.select().from(artifacts).where(eq(artifacts.id, p.artifactId));
    expect(a).toMatchObject({ taskId: t3.id, kind: "evidence-package", sha256: p.sha256, workerAuthored: false });
    expect(await db.select().from(artifacts).where(eq(artifacts.kind, "evidence-package"))).toHaveLength(1);
    // what the task page card and the control loop read
    const cur = (await currentEvidencePackage(t3.id, db))!;
    expect(cur.status).toBe("incomplete");
    expect(requiredVerified(cur.summary)).toBe("2 of 3");
    expect(verifierStatus(cur.summary)).toBe("not_run");
    expect(cur.sha256).toBe("ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19");
    expect((await latestPackage(db, t3.id, DEMO_HEAD))?.sha256).toBe(cur.sha256);
    expect(await currentEvidencePackage(byKey.get("T1")!.id, db)).toBeNull();
    expect(await currentEvidencePackage(byKey.get("T2")!.id, db)).toBeNull();
  });

  it("adds the evidence package to a preview database seeded before it existed, leaving the other demo data as it was", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await db.delete(evidencePackages);
    await db.delete(artifacts).where(eq(artifacts.kind, "evidence-package"));
    await db.update(tasks).set({ headSha: null }).where(inArray(tasks.key, ["T1", "T2", "T3"]));
    const before = (await db.select().from(tasks).orderBy(asc(tasks.id))).map(({ headSha: _h, updatedAt: _u, ...t }) => t);
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const after = (await db.select().from(tasks).orderBy(asc(tasks.id))).map(({ headSha: _h, updatedAt: _u, ...t }) => t);
    expect(after).toEqual(before);
    expect(await db.select().from(evidencePackages)).toHaveLength(1);
    expect(await db.select().from(artifacts).where(eq(artifacts.kind, "evidence-package"))).toHaveLength(1);
    expect(await ledger(db)).toEqual(RUNS);
    expect((await db.select().from(decisions)).map((d) => d.kind).sort()).toEqual(["acceptance", "acceptance", "block", "contract_approval"]);
  });

  it("seeds nothing without the demo project (production has none)", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedPreviewDemo(db);
    expect(await db.select().from(runs)).toHaveLength(0);
    expect(await db.select().from(qualificationRecords)).toHaveLength(0);
    expect(await db.select().from(evidencePackages)).toHaveLength(0);
    expect(await db.select().from(artifacts)).toHaveLength(0);
  });
});
