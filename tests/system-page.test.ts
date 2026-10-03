import { describe, expect, it } from "vitest";
import { projects } from "@/db/schema";
import { getDb } from "@/db/client";
import { migrate } from "@/db/migrate";

process.env.DATABASE_URL = "pglite://memory";

describe("systemPage() capabilities", () => {
  it("lists active projects only, ordered by name, with their stored profile", async () => {
    const db = await getDb();
    await migrate(db, "pglite://memory");
    const base = { description: "", org: "o", repo: "r", ownerLogin: "me", builderKey: "k", stack: "" };
    await db.insert(projects).values([
      { ...base, slug: "zeta", name: "Zeta", capabilityProfile: { languages: ["go"] } },
      { ...base, slug: "old", name: "Old", active: false },
      { ...base, slug: "alpha", name: "Alpha" },
    ]);
    const { systemPage } = await import("@/server/queries");
    const d = await systemPage();
    expect(d.capabilities.map((p) => [p.name, p.capabilityProfile])).toEqual([
      ["Alpha", null],
      ["Zeta", { languages: ["go"] }],
    ]);
  });
});
