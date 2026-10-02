import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectItem } from "@/components/project-item";

const render = (slug: string, name: string) =>
  renderToStaticMarkup(createElement("ul", null, createElement(ProjectItem, { slug, name, org: "preview-org", repo: "demo-repo", active: 2, accepted: 1 })));

const anchors = (html: string) => [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => ({ attrs: m[1]!, body: m[2]! }));

describe("Command page project item", () => {
  it("offers a New intent shortcut to the project's intent form next to the project link", () => {
    const html = render("demo", "Demo Project");
    const links = anchors(html);
    expect(links).toHaveLength(2);
    const [project, shortcut] = links;
    expect(project!.attrs).toContain('href="/projects/demo"');
    expect(project!.body).toContain("Demo Project");
    expect(project!.body).toContain("preview-org/demo-repo");
    expect(project!.body).toContain("2 active");
    expect(project!.body).toContain("1 accepted");
    expect(shortcut!.attrs).toContain('href="/projects/demo/new"');
    expect(shortcut!.attrs).toContain('aria-label="New intent for Demo Project"');
    expect(shortcut!.body).toContain("New intent");
  });

  it("never nests links and uses each project's own slug", () => {
    const html = render("books", "Books");
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<a\b/);
    expect((html.match(/<li\b/g) ?? []).length).toBe(1);
    expect(anchors(html).map((a) => /href="([^"]*)"/.exec(a.attrs)![1])).toEqual(["/projects/books", "/projects/books/new"]);
  });
});
