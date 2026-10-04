import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { artifacts, decisions, projects, tasks } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { ownerSummary, recordText, residualGroups, type DecisionRecord, type Residual } from "@/domain/decision";
import { acceptanceResidualGroups } from "@/server/queries";
import { ResidualList, type ResidualGroups } from "@/components/residual-list";

/* T10: the task page splits an acceptance decision's residual into "Needs your review" and "Noted" by the recorded kind (A1, A2). */

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  return db;
}

const rec = (residual: Residual[]): DecisionRecord => ({
  schema: "agents-app/decision-record@1",
  task: "T10",
  head: "a".repeat(40),
  contract: null,
  evidence_package: { sha256: "0".repeat(64), status: "complete" },
  outcome: "ready",
  blockers: [],
  basis: {
    must_verified: 1,
    must_total: 1,
    constraints_proven: [],
    regressions_verified: 0,
    gate: "PASS",
    verifier: "pass",
    verifier_coverage: "1/1",
  },
  residual,
  attention: "review",
});

const ALL: Residual[] = [
  { kind: "not_proven", id: "C1", text: "regression constraint was not proven by anyone: x" },
  { kind: "advisory_constraint", id: "C2", text: "advisory (non-blocking by contract): not judged - y" },
  { kind: "unconfirmed_finding", id: null, text: "1 material finding(s) the control system could not reproduce" },
  { kind: "should", id: "AC4", text: "should-criterion, not gated - not verified" },
  { kind: "waiver", id: "AC2", text: "must-criterion waived by the owner" },
  { kind: "finding", id: "AC1", text: "[medium] something" },
  { kind: "verifier", id: null, text: "the independent Verifier did not check AC3 (the gate did)" },
  { kind: "scan", id: "gitleaks", text: "scanner gitleaks: z" },
];

const strip = (h: string) =>
  h
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const render = (lines: string[], groups: ResidualGroups | null) =>
  renderToStaticMarkup(createElement(ResidualList, { lines, groups }));
/** Each label element with the items of the list that is its next sibling. */
const groupsOf = (h: string) =>
  [...h.matchAll(/<div[^>]*>([^<]*)<\/div><ul[^>]*>(.*?)<\/ul>/g)].map((m) => [
    m[1],
    [...m[2]!.matchAll(/<li>(.*?)<\/li>/g)].map((x) => strip(x[1]!)),
  ]);
const items = (h: string) => [...h.matchAll(/<li>(.*?)<\/li>/g)].map((x) => strip(x[1]!));

describe("residualGroups (A1, A2)", () => {
  it("puts should-criteria and advisory constraints under Noted, every other kind under Needs your review, in the record's order", () => {
    const r = rec(ALL);
    const lines = ownerSummary(r).lines;
    expect(residualGroups(lines, recordText(r))).toEqual({
      review: [
        "C1: regression constraint was not proven by anyone: x",
        "1 material finding(s) the control system could not reproduce",
        "AC2: must-criterion waived by the owner",
        "AC1: [medium] something",
        "the independent Verifier did not check AC3 (the gate did)",
        "gitleaks: scanner gitleaks: z",
      ],
      noted: [
        "C2: advisory (non-blocking by contract): not judged - y",
        "AC4: should-criterion, not gated - not verified",
      ],
    });
  });

  it("is empty for a record without residual and null when the lines cannot be matched to a decision record", () => {
    expect(residualGroups([], recordText(rec([])))).toEqual({ review: [], noted: [] });
    expect(residualGroups(["x"], recordText(rec([])))).toBeNull();
    expect(residualGroups(["x"], "not json")).toBeNull();
    expect(
      residualGroups(
        ["x"],
        JSON.stringify({ schema: "agents-app/evidence-package@1", residual: [{ kind: "should" }] }),
      ),
    ).toBeNull();
  });
});

describe("ResidualList", () => {
  it("shows Needs your review before Noted, each label followed by its list", () => {
    const h = render(["AC1: f", "v", "AC3: s"], { review: ["AC1: f", "v"], noted: ["AC3: s"] });
    expect(groupsOf(h)).toEqual([
      ["Needs your review", ["AC1: f", "v"]],
      ["Noted", ["AC3: s"]],
    ]);
    expect(items(h)).toHaveLength(3);
    // the section's existing look: same text size and colour as the list, no new colours, no controls
    expect(h).toContain("text-sm text-ink-2");
    expect(h).not.toMatch(/text-owner|text-bad|text-warn|<(button|form|input|a)\b|data-|\sid=/);
  });

  it("omits an empty group and shows nothing without items", () => {
    expect(groupsOf(render(["AC2: s"], { review: [], noted: ["AC2: s"] }))).toEqual([["Noted", ["AC2: s"]]]);
    expect(groupsOf(render(["f"], { review: ["f"], noted: [] }))).toEqual([["Needs your review", ["f"]]]);
    expect(render([], { review: [], noted: [] })).toBe("");
    expect(render([], null)).toBe("");
  });

  it("keeps the flat list as before when no kinds are known", () => {
    const h = render(["a", "b"], null);
    expect(h).toBe('<ul class="mt-2 max-w-3xl list-disc pl-5 text-sm text-ink-2"><li>a</li><li>b</li></ul>');
  });
});

describe("acceptanceResidualGroups (recorded facts only)", () => {
  it("groups the gate preview demo decisions T4 and T5 as the contract states; T1 and T2 have none", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    const rows = await db
      .select({ d: decisions, t: tasks })
      .from(decisions)
      .innerJoin(tasks, eq(tasks.id, decisions.taskId))
      .where(eq(decisions.status, "open"))
      .orderBy(asc(decisions.id));
    const m = await acceptanceResidualGroups(rows, db);
    const by = (key: string) => m.get(rows.find((x) => x.t.key === key)!.d.id);
    expect(by("T4")).toEqual({
      review: [
        "AC1: [low] Demo finding: the share link is not shortened",
        "the independent Verifier did not check AC2 (the gate did)",
      ],
      noted: ["AC3: should-criterion not verified"],
    });
    expect(by("T5")).toEqual({ review: [], noted: ["AC2: should-criterion not verified"] });
    expect(by("T1")).toBeUndefined();
    expect(by("T2")).toBeUndefined();
  });

  it("skips decisions without a matching record of the same task and never writes", async () => {
    const db = await previewDb();
    const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    const mk = async (key: string) =>
      (
        await db
          .insert(tasks)
          .values({ projectId: p!.id, key, title: key, intent: "x", state: "DONE", step: "await_acceptance" })
          .returning()
      )[0]!;
    const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
    const r = rec(ALL.slice(0, 2));
    const art = (
      await db
        .insert(artifacts)
        .values({
          taskId: a.id,
          kind: "decision-record",
          name: "x",
          content: recordText(r),
          sha256: "0".repeat(64),
          workerAuthored: false,
        })
        .returning()
    )[0]!.id;
    const ins = async (taskId: number, context: Record<string, unknown>) =>
      (
        await db
          .insert(decisions)
          .values({ taskId, kind: "acceptance", title: "t", why: "w", options: [], context })
          .returning()
      )[0]!;
    const da = await ins(a.id, { decisionRecord: { artifactId: art, residual: ownerSummary(r).lines } });
    const dm = await ins(a.id, { decisionRecord: { artifactId: art, residual: ["only one"] } }); // lines do not match the record
    const db_ = await ins(b.id, { decisionRecord: { artifactId: art, residual: ownerSummary(r).lines } }); // another task's artifact
    const dc = await ins(c.id, { pr: 1 });
    const before = await db.select().from(artifacts).orderBy(asc(artifacts.id));
    const m = await acceptanceResidualGroups(await db.select({ d: decisions }).from(decisions), db);
    expect([...m.keys()]).toEqual([da.id]);
    expect(m.get(da.id)).toEqual({ review: [ownerSummary(r).lines[0]], noted: [ownerSummary(r).lines[1]] });
    for (const x of [dm, db_, dc]) expect(m.has(x.id)).toBe(false);
    expect(await db.select().from(artifacts).orderBy(asc(artifacts.id))).toEqual(before);
  });
});
