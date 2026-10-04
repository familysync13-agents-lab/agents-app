import { describe, expect, it } from "vitest";
import { observationProblems, staticOracleProblems } from "@/domain/oracle-check";
import { VERIFIER_SCAFFOLD } from "@/domain/prompts";

/*
 * Regression test for the two check defects that recurred on T7 and T8 (four FAIL:ORACLE verdicts, none the implementation's).
 * The snippets are the defective observation patterns as the arbiter recorded them.
 */
describe("OB1 the recurring check defects are refused before a check becomes authoritative", () => {
  it("T7 AC6 / T8 AC1: a task-link pattern that demands a separator after the task key", () => {
    const t7 = "const re = new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`);\nconst link = page.getByRole('link').filter({ hasText: re });";
    expect(observationProblems(t7).join()).toMatch(/line 1: a text pattern demands a boundary.*NO separator/);
    expect(observationProblems("await page.getByRole('link', { name: /\\bT1\\b/ }).click();")).toHaveLength(1);
    expect(observationProblems("const l = page.locator('a').filter({ hasText: new RegExp(key + '(\\\\s|$)') });")).toHaveLength(1);
  });
  it("T7 AC1 / T8 AC5: rendered text compared case-sensitively with the contract's wording", () => {
    const t8 = "const terms = await packageCard.locator('dt').allInnerTexts();\nassert.deepEqual(terms, ['Status', 'Package hash']);";
    expect(observationProblems(t8).join()).toMatch(/line 1: reads rendered text \(innerText\), which carries CSS text-transform/);
    expect(observationProblems("const t = await card.innerText();")).toHaveLength(1);
    expect(observationProblems("const t = await page.evaluate(() => document.body.innerText);")).toHaveLength(1);
  });
  it("correct observation passes: own-element text, case-insensitive rendered text, role and href", () => {
    const ok = [
      "const terms = (await card.locator('dt').allTextContents()).map((s) => s.trim());",
      "const shown = (await card.innerText()).toLowerCase();",
      "const link = page.locator(`a[href='/tasks/${id}']`);",
      "await page.getByRole('link', { name: 'Demo: export a list as CSV' }).click();",
      "// innerText would be wrong here; [^A-Za-z0-9_] too",
      "const m = /^[0-9a-f]{64}$/.test(hash);",
    ].join("\n");
    expect(observationProblems(ok)).toEqual([]);
  });
  it("is part of the static validation every authored check passes through (oracle, regression repair, reproduction script)", () => {
    expect(staticOracleProblems("import { chromium } from 'playwright';\nconst t = await page.locator('dt').allInnerTexts();").join()).toMatch(/rendered text/);
  });
});

describe("OB2 the check author is told the two facts - and nothing about any task's expected answer", () => {
  it("the scaffold states both facts and no longer recommends innerText", () => {
    expect(VERIFIER_SCAFFOLD).toMatch(/Rendered text is not the text/);
    expect(VERIFIER_SCAFFOLD).toMatch(/join the text of its children with NO separator/);
    expect(VERIFIER_SCAFFOLD).not.toMatch(/`innerText\(\)` of that element/);
    expect(VERIFIER_SCAFFOLD).not.toMatch(/Evidence package|Demo: export/); // generic page facts only: no product content
  });
});
