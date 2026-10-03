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
const headers = (h: string) => [...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => strip(m[1]!));
const rows = (h: string) => [...(/<tbody\b[^>]*>(.*)<\/tbody>/.exec(h)?.[1] ?? "").matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1]!.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((c) => strip(c[1]!)));

describe("Project Capabilities (System page)", () => {
  it("renders the heading, the columns in order and the preview demo row", () => {
    const html = render([{ id: 1, name: "Demo Project", capabilityProfile: PREVIEW_CAPABILITY_PROFILE }]);
    expect(html).toMatch(/<h2\b[^>]*>Project Capabilities<\/h2>/);
    expect(headers(html)).toEqual(["Project", "Language", "Framework", "Package manager", "Build", "Test", "Lint", "Type-check", "Browser tests"]);
    const body = rows(html);
    expect(body).toHaveLength(1);
    const [name, lang, fw, pm, build, test, lint, tc, bt] = body[0]!;
    expect([name, lang, fw, pm]).toEqual(["Demo Project", "typescript", "next", "npm"]);
    for (const c of [build, test, tc]) expect(c).toMatch(/^Available/);
    expect(build).toBe("Available npm run build");
    expect(lint).toBe("Not available");
    expect(bt).toBe("Not available");
    expect(html).toContain("overflow-x-auto");
  });

  it("lists a project without a recorded profile as not detected yet, without any Available cell", () => {
    const html = render([
      { id: 1, name: "Alpha", capabilityProfile: null },
      { id: 2, name: "Beta", capabilityProfile: detectProfile("abc", { "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }) }) },
    ]);
    const [alpha, beta] = rows(html);
    expect(alpha).toEqual(["Alpha", "Not detected yet"]);
    expect(beta![0]).toBe("Beta");
    expect(beta![8]).toBe("Available");
  });

  it("shows Not detected for missing language, framework and package manager", () => {
    const profile = detectProfile("abc", {});
    expect(profile.languages).toEqual([]);
    const r = capabilityRow(profile)!;
    expect([r.language, r.framework, r.packageManager]).toEqual(["Not detected", "Not detected", "Not detected"]);
    expect([r.build, r.test, r.lint, r.typecheck, r.browserTests].every((c) => !c.available)).toBe(true);
    const [row] = rows(render([{ id: 1, name: "Empty", capabilityProfile: profile }]));
    expect(row!.slice(1, 4)).toEqual(["Not detected", "Not detected", "Not detected"]);
    expect(row!.slice(4).every((c) => c === "Not available")).toBe(true);
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
    const other = { ...PREVIEW_CAPABILITY_PROFILE, framework: "vite" };
    await db.update(projects).set({ capabilityProfile: other }).where(eq(projects.id, p!.id));
    await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
    await seedPreviewDemo(db);
    const [q] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    expect(q!.capabilityProfile).toEqual(other);
  });
});
