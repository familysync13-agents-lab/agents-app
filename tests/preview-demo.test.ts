import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { desc } from "drizzle-orm";
import { decisions, qualificationRecords, runs, tasks } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { qualification, route } from "@/domain/router";

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  return db;
}

describe("gate preview demo data", () => {
  it("seeds representative demo tasks once (idempotent)", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    expect((await db.select().from(tasks)).map((t) => t.key)).toEqual(["T1", "T2", "T3"]);
    expect((await db.select().from(decisions)).map((d) => d.kind).sort()).toEqual(["block", "contract_approval"]);
  });

  it("seeds two demo worker runs once: the T1 contract drafting, then the later T3 build run with its context size", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const keys = new Map((await db.select().from(tasks)).map((t) => [t.id, t.key]));
    const rs = await db.select().from(runs).orderBy(desc(runs.startedAt));
    expect(rs.map((r) => [keys.get(r.taskId), r.purpose, r.worker, r.taskClass, r.routeReason, r.contextBytes])).toEqual([
      ["T3", "build", "claude-code", "build", "trusted worker (no alternative has qualified for this class)", 48213],
      ["T1", "draft_contract", "claude-code", "contract_draft", "trusted worker (no alternative is defined for this class)", null],
    ]);
    expect(rs.every((r) => r.status === "finished" && r.finishedAt !== null)).toBe(true);
    expect(rs[0]!.startedAt.getTime()).toBeGreaterThan(rs[1]!.startedAt.getTime());
  });

  it("seeds exactly three shadow qualification records of local-llm for log_summary, which the Router reads as shadow", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const qs = await db.select().from(qualificationRecords);
    expect(qs).toHaveLength(3);
    expect(qs.every((q) => q.worker === "local-llm" && q.taskClass === "log_summary" && q.mode === "shadow" && q.valid === true && q.agree === true)).toBe(true);
    expect(qualification(qs, "local-llm", "log_summary")).toMatchObject({ status: "shadow", samples: 3 });
    expect(qualification(qs, "local-llm", "failure_triage")).toMatchObject({ status: "unqualified", samples: 0 });
    expect(route({ taskClass: "log_summary", risk: "standard", records: qs })).toMatchObject({ worker: "claude-code", reason: "trusted worker (no alternative has qualified for this class)" });
  });

  it("production seeding never receives demo runs or qualification evidence (C3)", async () => {
    const db = await previewDb();
    expect(await db.select().from(runs)).toHaveLength(0);
    expect(await db.select().from(qualificationRecords)).toHaveLength(0);
    // the demo seeder is only reachable from the preview-gated server start hook
    const hook = readFileSync("src/instrumentation.ts", "utf8");
    expect(hook.indexOf("if (!previewMode()) return;")).toBeGreaterThan(-1);
    expect(hook.indexOf("if (!previewMode()) return;")).toBeLessThan(hook.indexOf("seedPreviewDemo"));
    for (const f of ["src/db/seed.ts", "src/db/migrate.ts", "src/worker/orchestrator.ts", "src/domain/router.ts", "src/worker/shadow.ts"])
      expect(readFileSync(f, "utf8")).not.toMatch(/preview-demo|seedPreviewDemo/);
  });
});
