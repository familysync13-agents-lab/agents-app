import { describe, expect, it } from "vitest";
import { decisions, tasks } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";

describe("gate preview demo data", () => {
  it("seeds representative demo tasks once (idempotent)", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    expect((await db.select().from(tasks)).map((t) => t.key)).toEqual(["T1", "T2", "T3"]);
    expect((await db.select().from(decisions)).map((d) => d.kind).sort()).toEqual(["block", "contract_approval"]);
  });
});
