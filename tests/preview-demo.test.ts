import { describe, expect, it } from "vitest";
import { asc, desc } from "drizzle-orm";
import { decisions, qualificationRecords, runs, tasks } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
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
    expect((await db.select().from(tasks)).map((t) => t.key)).toEqual(["T1", "T2", "T3"]);
    expect((await db.select().from(decisions)).map((d) => d.kind).sort()).toEqual(["block", "contract_approval"]);
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
    expect((await db.select().from(tasks)).map((t) => t.key)).toEqual(["T1", "T2", "T3"]);
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

  it("seeds nothing without the demo project (production has none)", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedPreviewDemo(db);
    expect(await db.select().from(runs)).toHaveLength(0);
    expect(await db.select().from(qualificationRecords)).toHaveLength(0);
  });
});
