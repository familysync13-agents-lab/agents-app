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
const headers = (h: string) => [...(/<thead\b[^>]*>(.*?)<\/thead>/.exec(h)?.[1] ?? "").matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => strip(m[1]!));
const rows = (h: string) =>
  [...(/<tbody\b[^>]*>(.*?)<\/tbody>/.exec(h)?.[1] ?? "").matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((x) => strip(x[1]!)));
const HEADERS = ["Project", "Language", "Framework", "Package manager", "Build", "Test", "Lint", "Type-check", "Browser tests"];

describe("Project Capabilities (System page)", () => {
  it("renders the heading and a table with one row for the preview demo profile", () => {
    const html = render([{ id: 1, name: "Demo Project", capabilityProfile: PREVIEW_CAPABILITY_PROFILE }]);
    expect(html).toMatch(/<h2\b[^>]*>Project Capabilities<\/h2>/);
    expect(headers(html)).toEqual(HEADERS);
    const body = rows(html);
    expect(body).toHaveLength(1);
    const [name, lang, fw, pm, build, test, lint, tc, bt] = body[0]!;
    expect([name, lang, fw, pm]).toEqual(["Demo Project", "typescript", "next", "npm"]);
    for (const c of [build, test, tc]) expect(c!.startsWith("Available")).toBe(true);
    expect(build).toBe("Available npm run build");
    expect([lint, bt]).toEqual(["Not available", "Not available"]);
  });

  it("keeps a row for a project without a recorded profile, saying Not detected yet and nothing Available", () => {
    const html = render([
      { id: 1, name: "Alpha", capabilityProfile: null },
      { id: 2, name: "Beta", capabilityProfile: detectProfile("abc", { "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }) }) },
    ]);
    const [alpha, beta] = rows(html);
    expect(alpha).toEqual(["Alpha", "Not detected yet"]);
    expect(alpha!.some((c) => c.includes("Available"))).toBe(false);
    expect(beta![0]).toBe("Beta");
    expect(beta![8]).toBe("Available");
  });

  it("shows Not detected for missing values and Not available for missing capabilities of an empty profile", () => {
    const profile = detectProfile("abc", {});
    expect(profile.languages).toEqual([]);
    const r = capabilityRow(profile)!;
    expect([r.language, r.framework, r.packageManager]).toEqual(["Not detected", "Not detected", "Not detected"]);
    expect([r.build, r.test, r.lint, r.typecheck, r.browserTests].every((c) => !c.available)).toBe(true);
    const [row] = rows(render([{ id: 1, name: "Empty", capabilityProfile: profile }]));
    expect(row).toEqual(["Empty", "Not detected", "Not detected", "Not detected", ...Array(5).fill("Not available")]);
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
    await db.update(projects).set({ capabilityProfile: { ...PREVIEW_CAPABILITY_PROFILE, browserTests: true } }).where(eq(projects.id, p!.id));
    await seedPreviewDemo(db);
    const [q] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(q!.capabilityProfile).toEqual(PREVIEW_CAPABILITY_PROFILE);
  });

  it("the demonstration profile has the values the contract states", () => {
    expect(PREVIEW_CAPABILITY_PROFILE).toMatchObject({
      languages: ["typescript"],
      framework: "next",
      packageManager: "npm",
      commands: { build: "npm run build", test: "npm run test", lint: null, typecheck: "npm run typecheck" },
      browserTests: false,
    });
  });
});
