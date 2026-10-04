import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { artifacts, decisions, evidencePackages, qualificationRecords, runs, tasks, transitions } from "@/db/schema";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { AcceptanceItem } from "@/components/acceptance-item";
import { withoutProofCount, withoutProofText } from "@/domain/decision";
import { recordedWithoutProof } from "@/server/queries";
import { createTask } from "@/server/owner";
import { clock, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { fixtureHandlers as scenario } from "./support/fixture-handlers";

/* T9: open acceptance decisions on the Decisions page show what the recorded decision record would accept without proof. */

type Db = Awaited<ReturnType<typeof createDb>>;

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  await seedPreviewDemo(db);
  return db;
}

const strip = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Whole visible text of every element (innermost-first is not needed: the statements are leaf elements). */
const leaves = (h: string) => [...h.matchAll(/<(span|p|div|a)\b[^>]*>((?:(?!<\/?(?:span|p|div|a)\b).)*)<\/\1>/g)].map((m) => strip(m[2]!));
const anchors = (h: string) => [...h.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => ({ attrs: m[1]!, text: strip(m[2]!) }));
const STATEMENT = /^(\d+ items? would be accepted without proof|Nothing is accepted without proof)$/;

const render = (withoutProof: number | undefined, key: string | null = "T4") =>
  renderToStaticMarkup(
    createElement(AcceptanceItem, {
      label: "Acceptance",
      project: "Demo Project",
      task: { id: 42, key, title: "Demo: share a list" },
      decision: { title: "Accept T4: Demo: share a list", why: "2 of 2 required criteria verified. 2 item(s) would be accepted without proof - listed below.", createdAt: new Date() },
      withoutProof,
    }),
  );

async function demoDecision(db: Db, key: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.key, key));
  const [d] = await db.select().from(decisions).where(and(eq(decisions.taskId, t!.id), eq(decisions.status, "open")));
  return { t: t!, d: d! };
}

describe("counting what a decision record would accept without proof", () => {
  it("counts every residual item except unverified should-criteria and advisory constraints (as ownerSummary does)", () => {
    expect(withoutProofCount([{ kind: "finding" }, { kind: "verifier" }, { kind: "should" }, { kind: "advisory_constraint" }])).toBe(2);
    expect(withoutProofCount([{ kind: "should" }])).toBe(0);
    expect(withoutProofCount([])).toBe(0);
  });

  it("words the count exactly: none, singular, plural", () => {
    expect(withoutProofText(0)).toBe("Nothing is accepted without proof");
    expect(withoutProofText(1)).toBe("1 item would be accepted without proof");
    expect(withoutProofText(2)).toBe("2 items would be accepted without proof");
    expect(withoutProofText(12)).toBe("12 items would be accepted without proof");
  });
});

describe("acceptance list item", () => {
  it("shows the kind label, meta line, title, explanation, one task link named by key and title, and the count", () => {
    const h = render(2);
    expect(h.startsWith("<li")).toBe(true);
    const text = strip(h);
    expect(text).toMatch(/^Acceptance Demo Project · T4 · \d+s ago Accept T4: Demo: share a list 2 of 2 required/);
    const links = anchors(h);
    expect(links).toEqual([{ attrs: expect.stringContaining('href="/tasks/42"'), text: "T4 · Demo: share a list" }]);
    expect(leaves(h).filter((x) => STATEMENT.test(x))).toEqual(["2 items would be accepted without proof"]);
  });

  it("says Nothing is accepted without proof for a count of 0 and the singular for 1", () => {
    expect(leaves(render(0)).filter((x) => STATEMENT.test(x))).toEqual(["Nothing is accepted without proof"]);
    expect(leaves(render(1)).filter((x) => STATEMENT.test(x))).toEqual(["1 item would be accepted without proof"]);
  });

  it("shows neither statement without a recorded decision record, but keeps the task link", () => {
    const h = render(undefined);
    expect(leaves(h).filter((x) => STATEMENT.test(x))).toEqual([]);
    expect(h).not.toContain("Nothing is accepted without proof");
    expect(anchors(h)).toHaveLength(1);
  });

  it("is read-only and plain: no button, form, input or select, no warning colour, animation or spinner", () => {
    const h = render(2);
    expect(h).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(h).not.toMatch(/animate-|pulse|spin|text-(bad|warn|danger|red)/);
  });

  it("is used by the Decisions page for acceptance decisions only; other kinds keep their item", () => {
    const page = readFileSync("src/app/(app)/decisions/page.tsx", "utf8");
    expect(page).toContain('d.kind === "acceptance" ? (');
    expect(page).toContain("<AcceptanceItem");
    expect(page).toContain("recordedWithoutProof(rows.map((r) => r.d))");
  });
});

describe("recordedWithoutProof", () => {
  it("reads the gate preview's demo records: T4 -> 2, T5 -> 0; other kinds have no entry", async () => {
    const db = await previewDb();
    const all = await db.select().from(decisions).where(eq(decisions.status, "open"));
    const m = await recordedWithoutProof(all, db);
    const t4 = await demoDecision(db, "T4");
    const t5 = await demoDecision(db, "T5");
    expect([...m.entries()].sort()).toEqual([[t4.d.id, 2], [t5.d.id, 0]].sort());
    expect(withoutProofText(m.get(t4.d.id)!)).toBe("2 items would be accepted without proof");
    expect(withoutProofText(m.get(t5.d.id)!)).toBe("Nothing is accepted without proof");
  });

  it("shows nothing for an acceptance decision without a decision record, with a missing or foreign artifact, or a changed one", async () => {
    const db = await previewDb();
    const { t, d } = await demoDecision(db, "T4");
    const t5 = await demoDecision(db, "T5");
    const rec = (d.context as { decisionRecord: { artifactId: number; sha256: string } }).decisionRecord;
    const at = (context: Record<string, unknown>) => recordedWithoutProof([{ ...d, context }], db).then((m) => m.get(d.id));
    expect(await at({ pr: 7 })).toBeUndefined(); // opened before decision records existed
    expect(await at({ decisionRecord: { ...rec, artifactId: 999999 } })).toBeUndefined();
    expect(await at({ decisionRecord: { ...rec, sha256: "f".repeat(64) } })).toBeUndefined();
    const other = (t5.d.context as { decisionRecord: { artifactId: number; sha256: string } }).decisionRecord;
    expect(await at({ decisionRecord: other })).toBeUndefined(); // the record of another task
    const [pkg] = await db.insert(artifacts).values({ taskId: t.id, kind: "evidence-package", name: "x", content: "{}", sha256: "e".repeat(64), workerAuthored: false }).returning();
    expect(await at({ decisionRecord: { artifactId: pkg!.id } })).toBeUndefined(); // not a decision record
    expect(await at({ decisionRecord: rec })).toBe(2);
  });

  it("counts one item as one (singular)", async () => {
    const db = await previewDb();
    const { t, d } = await demoDecision(db, "T4");
    const content = JSON.stringify({ residual: [{ kind: "scan", id: "secrets", text: "x" }, { kind: "advisory_constraint", id: "C9", text: "y" }] });
    const [a] = await db.insert(artifacts).values({ taskId: t.id, kind: "decision-record", name: "d.json", content, sha256: "c".repeat(64), workerAuthored: false }).returning();
    const m = await recordedWithoutProof([{ ...d, context: { decisionRecord: { artifactId: a!.id } } }], db);
    expect(withoutProofText(m.get(d.id)!)).toBe("1 item would be accepted without proof");
  });

  it("agrees with the explanation the control loop writes for a real acceptance decision", async () => {
    const { db, project } = await setup();
    const clk = clock();
    const ex = new FakeExecutor(db, scenario({}).h);
    const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const [d] = await openDecisions(db, id);
    expect(d!.kind).toBe("acceptance");
    const n = (await recordedWithoutProof([d!], db)).get(d!.id);
    expect(n).toBeTypeOf("number");
    if (n === 0) expect(d!.why).toContain("Nothing is accepted without proof");
    else expect(d!.why).toContain(`${n} item(s) would be accepted without proof`);
  });
});

describe("gate preview demo acceptances (T9, A3)", () => {
  it("adds T4 and T5 in state DONE with one open acceptance decision each and a stored decision record", async () => {
    const db = await previewDb();
    const t4 = await demoDecision(db, "T4");
    const t5 = await demoDecision(db, "T5");
    expect(t4.t).toMatchObject({ title: "Demo: share a list", state: "DONE" });
    expect(t5.t).toMatchObject({ title: "Demo: book covers", state: "DONE" });
    expect(t4.d).toMatchObject({ kind: "acceptance", title: "Accept T4: Demo: share a list" });
    expect(t5.d).toMatchObject({ kind: "acceptance", title: "Accept T5: Demo: book covers" });
    expect(t4.d.why).toContain("2 item(s) would be accepted without proof");
    expect(t5.d.why).toContain("Nothing is accepted without proof");
    for (const x of [t4, t5]) {
      const rec = (x.d.context as { decisionRecord: { artifactId: number; sha256: string } }).decisionRecord;
      const [a] = await db.select().from(artifacts).where(eq(artifacts.id, rec.artifactId));
      expect(a).toMatchObject({ taskId: x.t.id, kind: "decision-record", sha256: rec.sha256, workerAuthored: false });
    }
    const r4 = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.taskId, t4.t.id)))[0]!.content);
    expect(r4.attention).toBe("review");
    expect(r4.residual.map((x: { kind: string }) => x.kind)).toEqual(["finding", "verifier", "should"]);
    const r5 = JSON.parse((await db.select().from(artifacts).where(eq(artifacts.taskId, t5.t.id)))[0]!.content);
    expect(r5).toMatchObject({ attention: "clean", residual: [{ kind: "should" }] });
  });

  it("adds no worker runs, evidence packages or qualification records", async () => {
    const db = await previewDb();
    const ids = (await db.select().from(tasks).where(inArray(tasks.key, ["T4", "T5"]))).map((t) => t.id);
    expect(await db.select().from(runs).where(inArray(runs.taskId, ids))).toHaveLength(0);
    expect(await db.select().from(evidencePackages).where(inArray(evidencePackages.taskId, ids))).toHaveLength(0);
    expect(await db.select().from(qualificationRecords).where(inArray(qualificationRecords.taskId, ids))).toHaveLength(0);
  });

  it("is idempotent, also on a preview database seeded before T4 and T5 existed, leaving T1-T3 as they were", async () => {
    const db = await previewDb();
    const ids = (await db.select().from(tasks).where(inArray(tasks.key, ["T4", "T5"]))).map((t) => t.id);
    await db.delete(decisions).where(inArray(decisions.taskId, ids));
    await db.delete(artifacts).where(inArray(artifacts.taskId, ids));
    await db.delete(transitions).where(inArray(transitions.taskId, ids));
    await db.delete(tasks).where(inArray(tasks.id, ids));
    const before = await db.select().from(tasks).orderBy(asc(tasks.id));
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const after = await db.select().from(tasks).orderBy(asc(tasks.id));
    expect(after.map((t) => t.key)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(after.slice(0, 3)).toEqual(before);
    expect((await db.select().from(decisions).where(eq(decisions.kind, "acceptance"))).map((d) => d.title).sort()).toEqual(["Accept T4: Demo: share a list", "Accept T5: Demo: book covers"]);
    expect(await db.select().from(artifacts).where(eq(artifacts.kind, "decision-record"))).toHaveLength(2);
  });

  it("adds nothing without the demo project (production)", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedPreviewDemo(db);
    expect(await db.select().from(tasks)).toHaveLength(0);
    expect(await db.select().from(decisions)).toHaveLength(0);
    expect(await db.select().from(artifacts)).toHaveLength(0);
  });
});
