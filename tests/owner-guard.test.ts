import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The (app) layout's requireOwner() renders concurrently with the page, so a page that reads data before its own check streams that
 * data into the body of the anonymous redirect. Every owner page must therefore check the session first.
 */
const ROOT = join(__dirname, "..", "src", "app", "(app)");
const pages = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? pages(join(dir, e.name)) : e.name === "page.tsx" ? [join(dir, e.name)] : []));

describe("owner pages check the session before reading any data", () => {
  const all = pages(ROOT);
  it("finds the owner pages", () => {
    expect(all.length).toBeGreaterThanOrEqual(7);
  });
  it.each(all.map((f) => [f.slice(ROOT.length)]))("%s", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).not.toMatch(/export (async )?function generateMetadata/);
    const body = /export default async function [^\n]*\{\n([\s\S]*)/.exec(src)?.[1] ?? "";
    const first = body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//"));
    expect(first).toBe("await requireOwner();");
  });
});
