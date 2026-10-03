import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ProjectCapabilities, type CapabilityProject } from "@/components/project-capabilities";
import { capabilityRow } from "@/domain/capabilities";
import { detectProfile } from "@/domain/profile";
import { PREVIEW_CAPABILITY_PROFILE, seedPreviewDemo } from "@/db/preview-demo";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { projects } from "@/db/schema";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";

const strip = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const render = (ps: CapabilityProject[]) => renderToStaticMarkup(createElement(ProjectCapabilities, { projects: ps }));
const items = (h: string) =>
  [...h.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((m) => {
    const li = m[1]!;
    const dl = /<dl\b[^>]*>(.*?)<\/dl>/.exec(li)?.[1];
    return {
      name: strip(/<h3\b[^>]*>(.*?)<\/h3>/.exec(li)?.[1] ?? ""),
      terms: dl ? [...dl.matchAll(/<dt\b[^>]*>(.*?)<\/dt>/g)].map((x) => strip(x[1]!)) : null,
      values: dl ? [...dl.matchAll(/<dd\b[^>]*>(.*?)<\/dd>/g)].map((x) => strip(x[1]!)) : null,
      text: strip(li),
    };
  });
const LABELS = ["Language", "Framework", "Package manager", "Build", "Test", "Lint", "Type check", "Browser tests"];

describe("Project Capabilities (System page)", () => {
  it("renders the heading and one list item with the preview demo profile in label order", () => {
    const html = render([{ id: 1, name: "Demo Project", capabilityProfile: PREVIEW_CAPABILITY_PROFILE }]);
    expect(html).toMatch(/<h2\b[^>]*>Project Capabilities<\/h2>/);
    const list = items(html);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Demo Project");
    expect(list[0]!.terms).toEqual(LABELS);
    expect(list[0]!.values).toEqual(["typescript", "next", "npm", "npm run build", "npm run test", "npm run lint", "Not detected", "Available"]);
    expect(html).not.toContain("<table");
  });

  it("lists a project without a recorded profile with its name and the no-profile message", () => {
    const html = render([
      { id: 1, name: "Alpha", capabilityProfile: null },
      { id: 2, name: "Beta", capabilityProfile: detectProfile("abc", { "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }) }) },
    ]);
    const [alpha, beta] = items(html);
    expect(alpha).toEqual({ name: "Alpha", terms: null, values: null, text: "Alpha No capability profile detected yet." });
    expect(beta!.name).toBe("Beta");
    expect(beta!.values![7]).toBe("Available");
  });

  it("shows Not detected for every value of an empty profile", () => {
    const profile = detectProfile("abc", {});
    expect(profile.languages).toEqual([]);
    const r = capabilityRow(profile)!;
    expect([r.language, r.framework, r.packageManager]).toEqual(["Not detected", "Not detected", "Not detected"]);
    expect([r.build, r.test, r.lint, r.typecheck, r.browserTests].every((c) => !c.available)).toBe(true);
    const [item] = items(render([{ id: 1, name: "Empty", capabilityProfile: profile }]));
    expect(item!.values).toEqual(LABELS.map(() => "Not detected"));
  });

  it("says so when no project is configured", () => {
    expect(strip(render([]))).toContain("No project is configured.");
  });

  it("joins several languages and tolerates malformed stored values", () => {
    expect(capabilityRow({ languages: ["typescript", "php"], framework: "", commands: { build: 3 } })).toMatchObject({
      language: "typescript, php",
      framework: "Not detected",
      packageManager: "Not detected",
      build: { available: false },
    });
    expect(capabilityRow([])).toBeNull();
    expect(capabilityRow("x")).toBeNull();
  });

  it("the preview seeds the demonstration profile once and never overwrites a recorded one", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
    await seedPreviewDemo(db);
    const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(p!.capabilityProfile).toEqual(PREVIEW_CAPABILITY_PROFILE);
    const other = { ...PREVIEW_CAPABILITY_PROFILE, commit: "a".repeat(40), framework: "vite" };
    await db.update(projects).set({ capabilityProfile: other }).where(eq(projects.id, p!.id));
    await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
    await seedPreviewDemo(db);
    const [q] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(q!.capabilityProfile).toEqual(other);
  });

  it("the preview brings an earlier demonstration profile up to date", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
    const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    await db.update(projects).set({ capabilityProfile: { ...PREVIEW_CAPABILITY_PROFILE, browserTests: false } }).where(eq(projects.id, p!.id));
    await seedPreviewDemo(db);
    const [q] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(q!.capabilityProfile).toEqual(PREVIEW_CAPABILITY_PROFILE);
  });

  it("the demonstration profile has the values the contract states", () => {
    expect(PREVIEW_CAPABILITY_PROFILE).toMatchObject({
      languages: ["typescript"],
      framework: "next",
      packageManager: "npm",
      commands: { build: "npm run build", test: "npm run test", lint: "npm run lint", typecheck: null },
      browserTests: true,
    });
  });
});
