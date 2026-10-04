import { describe, expect, it } from "vitest";
import { parseTaskId, shortenTitle, TASK_ID_MAX, TITLE_MAX } from "@/domain/text";

const LONG =
  "Should reading progress be computed per book from the pages a reader marks as read, or per list from the number of books marked finished, and should it be visible to people who open the list through a share link or only to the owner of the list?";
const len = (s: string) => Array.from(s).length;

describe("shortened decision titles", () => {
  it("keeps titles of at most 100 code points unchanged", () => {
    const t = "Approve the contract for T1: Demo: export a list as CSV";
    expect(shortenTitle(t)).toBe(t);
    expect(shortenTitle("x".repeat(100))).toBe("x".repeat(100));
    expect(shortenTitle("")).toBe("");
  });
  it("shortens long titles to a prefix ending in an ellipsis at a word boundary", () => {
    const s = shortenTitle(LONG);
    expect(len(s)).toBeLessThanOrEqual(TITLE_MAX);
    expect(s.endsWith("…")).toBe(true);
    const head = s.slice(0, -1).trimEnd();
    expect(head.length).toBeGreaterThan(0);
    expect(LONG.startsWith(head)).toBe(true);
    expect(s).not.toContain(LONG);
    expect(/\s/.test(LONG[head.length]!)).toBe(true); // no half word
    expect(s).toBe("Should reading progress be computed per book from the pages a reader marks as read, or per list…");
  });
  it("cuts mid-word only when no word boundary fits", () => {
    const s = shortenTitle("y".repeat(150));
    expect(s).toBe(`${"y".repeat(99)}…`);
    expect(shortenTitle(`${"a".repeat(98)} bcdef`)).toBe(`${"a".repeat(98)}…`);
    expect(shortenTitle(`${"a".repeat(99)} bcdef`)).toBe(`${"a".repeat(99)}…`);
  });
  it("counts Unicode code points and never splits a surrogate pair", () => {
    const s = shortenTitle("😀".repeat(120));
    expect(len(s)).toBe(100);
    expect(s).toBe(`${"😀".repeat(99)}…`);
    expect(len(shortenTitle(`${"é ".repeat(60)}`))).toBeLessThanOrEqual(100);
  });
});

describe("task identifiers from the address", () => {
  it("accepts decimal digits with a value of at least 1", () => {
    expect(parseTaskId("1")).toBe(1);
    expect(parseTaskId("42")).toBe(42);
    expect(parseTaskId("999999")).toBe(999999);
    expect(parseTaskId("2147483647")).toBe(TASK_ID_MAX);
  });
  it("rejects numbers too large for the tasks id column", () => {
    for (const id of ["2147483648", "99999999999", "9".repeat(400)]) {
      expect(parseTaskId(id), id).toBeNull();
    }
  });
  it("rejects every other identifier", () => {
    for (const id of ["", "invalid", "1.5", "-3", "0", "00", "+5", "1e3", "0x10", "NaN", "Infinity", "12abc", " 1", "1 ", "١٢"]) {
      expect(parseTaskId(id), id).toBeNull();
    }
  });
});
