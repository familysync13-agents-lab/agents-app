import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ProjectCapabilities, capabilityRows } from "@/components/project-capabilities";
import { projects } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { PREVIEW_DEMO_PROFILE, seedPreviewDemo } from "@/db/preview-demo";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { detectProfile } from "@/domain/profile";

const LABELS = ["Language", "Framework", "Package manager", "Build", "Test", "Lint", "Type check", "Browser tests"];
const pairs = (html: string) => [...html.matchAll(/<dt\b[^>]*>(.*?)<\/dt><dd\b[^>]*>(.*?)<\/dd>/g)].map((m) => [m[1]!, m[2]!]);
const render = (ps: { id: number; name: string; capabilityProfile: Record<string, unknown> | null }[]) =>
  renderToStaticMarkup(createElement(ProjectCapabilities, { projects: ps }));
const asRecord = (p: unknown) => p as Record<string, unknown>;

describe("Project Capabilities section", () => {
  it("shows the demo profile with the contract's labels, values and order", () => {
    const html = render([{ id: 1, name: "Demo Project", capabilityProfile: asRecord(PREVIEW_DEMO_PROFILE) }]);
    expect(html).toContain("<h2");
    expect(html).toContain(">Project Capabilities</h2>");
    expect((html.match(/<li\b/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<h3\b[^>]*>Demo Project<\/h3>/);
    expect(pairs(html)).toEqual([
      ["Language", "typescript"],
      ["Framework", "next"],
      ["Package manager", "npm"],
      ["Build", "npm run build"],
      ["Test", "npm run test"],
      ["Lint", "npm run lint"],
      ["Type check", "Not detected"],
      ["Browser tests", "Available"],
    ]);
  });

  it("lists a project without a profile and says so", () => {
    const html = render([
      { id: 1, name: "Alpha", capabilityProfile: null },
      { id: 2, name: "Beta", capabilityProfile: asRecord(PREVIEW_DEMO_PROFILE) },
    ]);
    expect((html.match(/<li\b/g) ?? []).length).toBe(2);
    expect((html.match(/<dl\b/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<h3\b[^>]*>Alpha<\/h3><p\b[^>]*>No capability profile detected yet\.<\/p>/);
  });

  it("joins several languages and marks every undetected value", () => {
    const rows = capabilityRows(asRecord(detectProfile("abc", { "composer.json": "{}", "requirements.txt": "", "go.mod": "" })))!;
    expect(rows.map((r) => r.label)).toEqual(LABELS);
    expect(rows[0]!.value).toBe("php, python, go");
    expect(rows.slice(1).map((r) => r.value)).toEqual(Array(7).fill("Not detected"));
    expect(capabilityRows(asRecord({ commit: "x" }))!.map((r) => r.value)).toEqual(Array(8).fill("Not detected"));
  });
});

describe("demo capability profile (gate preview data)", () => {
  it("is given to the preview Demo Project without overwriting a detected profile", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
    await seedPreviewDemo(db);
    const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(p!.capabilityProfile).toEqual(PREVIEW_DEMO_PROFILE);
    const real = detectProfile("c0ffee", { "package.json": "{}" });
    await db.update(projects).set({ capabilityProfile: asRecord(real) }).where(eq(projects.id, p!.id));
    await seedPreviewDemo(db);
    const [again] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(again!.capabilityProfile).toEqual(real);
  });
});
