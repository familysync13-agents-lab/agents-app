import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidencePackageCard } from "@/components/evidence-package";
import { CardHeader } from "@/components/ui";

/*
 * T8: the task page fits a 375px-wide screen. No browser runs in the check stage, so these tests pin the layout rules that keep the
 * page inside the viewport: every grid on the page has bounded tracks at phone width (an implicit or "1fr" track grows to its
 * content's min-content width), and text containers wrap long unbroken values instead of widening their card.
 */

const PAGE = readFileSync("src/app/(app)/tasks/[id]/page.tsx", "utf8");
const HASH = "ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19";

/** All class strings of the page source (className="..." and the string literals of cx(...)). */
const classStrings = (src: string) =>
  [...src.matchAll(/className="([^"]*)"/g), ...src.matchAll(/cx\(\s*"([^"]*)"/g)].map((m) => m[1]!);
const unprefixed = (cls: string) => cls.split(/\s+/).filter((c) => c && !c.includes(":"));

describe("task page at phone width", () => {
  it("gives every grid explicit, bounded column tracks at the base (phone) width", () => {
    const grids = classStrings(PAGE).filter((c) => unprefixed(c).includes("grid"));
    expect(grids.length).toBeGreaterThan(3);
    for (const g of grids) {
      const cols = unprefixed(g).filter((c) => c.startsWith("grid-cols-"));
      expect(cols, g).toHaveLength(1);
      // grid-cols-<n> is repeat(n, minmax(0, 1fr)); an arbitrary template must not contain a bare 1fr / auto track
      if (cols[0]!.startsWith("grid-cols-[")) expect(cols[0], g).not.toMatch(/(^|[[_])(\d*\.?\d*fr|auto)(?=[_\]])/);
    }
  });

  it("keeps the two-column desktop arrangement and lets both columns shrink below their content width", () => {
    expect(PAGE).toContain('className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_1fr]"');
    expect(PAGE.match(/<div className="min-w-0 space-y-6">/g)).toHaveLength(2);
  });

  it("wraps long values in the page's text containers", () => {
    for (const marker of [
      "Your decision",
      "Your intent",
      "body.scope?.summary",
      "Independent check (blind",
      "PURPOSE[r.purpose]",
      "Intent recorded",
    ]) {
      const at = PAGE.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      const before = PAGE.slice(Math.max(0, at - 400), at);
      expect(before, marker).toMatch(/break-words/);
    }
    expect(PAGE).toContain("grid-cols-[92px_minmax(0,1fr)]");
  });

  it("keeps wide tables in their own horizontal scroll frame", () => {
    expect(PAGE).toMatch(/<div className="overflow-x-auto[^"]*">\s*<table className="w-full min-w-\[520px\]/);
  });

  it("card headers wrap long titles and meta instead of widening the card", () => {
    const h = renderToStaticMarkup(createElement(CardHeader, { title: "Contract", meta: "v1 · approved" }));
    expect(h).toMatch(/<div class="flex flex-wrap[^"]*">/);
    expect(h).toMatch(/<h2 class="[^"]*min-w-0[^"]*break-words[^"]*">Contract<\/h2>/);
    expect(h).toMatch(/<div class="[^"]*min-w-0[^"]*break-words[^"]*">v1 · approved<\/div>/);
  });

  it("Evidence package card: single column on phones, full hash as visible text that wraps, desktop description list unchanged", () => {
    const h = renderToStaticMarkup(
      createElement(EvidencePackageCard, {
        pkg: {
          status: "incomplete",
          summary: { must_total: 3, must: { verified: 2 }, verifier: "not_run" },
          sha256: HASH,
        },
      }),
    );
    const dl = h.match(/<dl class="([^"]*)"/)![1]!;
    expect(unprefixed(dl)).toContain("grid-cols-1");
    expect(unprefixed(dl)).toContain("break-words");
    expect(dl).toContain("sm:grid-cols-[max-content_minmax(0,1fr)]");
    expect(h).toMatch(new RegExp(`<code class="[^"]*break-all[^"]*">${HASH}</code>`));
  });
});
