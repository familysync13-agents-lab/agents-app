import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { artifacts, decisions, evidencePackages, projects, qualificationRecords, runs, tasks } from "@/db/schema";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { ownerSummary, recordText, withoutProofStatement, type DecisionRecord, type Residual } from "@/domain/decision";
import { acceptanceProofStatements } from "@/server/queries";
import { AcceptanceItem } from "@/components/acceptance-item";

type Db = Awaited<ReturnType<typeof createDb>>;

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  return db;
}

const record = (residual: Residual[]): string =>
  recordText({ schema: "agents-app/decision-record@1", task: "T9", head: "a".repeat(40), contract: null, evidence_package: { sha256: "0".repeat(64), status: "complete" }, outcome: "ready", blockers: [], basis: { must_verified: 1, must_total: 1, constraints_proven: [], regressions_verified: 0, gate: "PASS", verifier: "pass", verifier_coverage: "1/1" }, residual, attention: residual.some((r) => r.kind !== "should" && r.kind !== "advisory_constraint") ? "review" : "clean" } satisfies DecisionRecord);

const r = (kind: Residual["kind"]): Residual => ({ kind, id: null, text: kind });

/** Open decisions with their task as openDecisionsList returns them, keyed by task key. */
async function open(db: Db) {
  const rows = await db.select({ d: decisions, t: tasks }).from(decisions).innerJoin(tasks, eq(tasks.id, decisions.taskId)).where(eq(decisions.status, "open")).orderBy(asc(decisions.id));
  return rows;
}

describe("accepted-without-proof statement (A1)", () => {
  it("counts residual items other than should-criteria and advisory constraints, in the owner summary's wording", () => {
    expect(withoutProofStatement(record([]))).toBe("Nothing is accepted without proof");
    expect(withoutProofStatement(record([r("should"), r("advisory_constraint")]))).toBe("Nothing is accepted without proof");
    expect(withoutProofStatement(record([r("finding"), r("should")]))).toBe("1 item would be accepted without proof");
    expect(withoutProofStatement(record([r("finding"), r("verifier"), r("should")]))).toBe("2 items would be accepted without proof");
    expect(withoutProofStatement(record(["not_proven", "unconfirmed_finding", "finding", "verifier", "scan", "waiver", "advisory_constraint", "should", "finding", "scan", "scan", "waiver"].map((k) => r(k as Residual["kind"]))))).toBe(
      "10 items would be accepted without proof",
    );
  });

  it("agrees with the explanation the control loop writes for the same record", () => {
    const rec = JSON.parse(record([r("finding"), r("scan"), r("not_proven"), r("should")])) as DecisionRecord;
    expect(ownerSummary(rec).why).toContain("3 item(s) would be accepted without proof");
    expect(withoutProofStatement(recordText(rec))).toBe("3 items would be accepted without proof");
  });

  it("shows nothing for text that is not a decision record", () => {
    expect(withoutProofStatement("not json")).toBeNull();
    expect(withoutProofStatement("null")).toBeNull();
    expect(withoutProofStatement(JSON.stringify({ schema: "agents-app/evidence-package@1", residual: [] }))).toBeNull();
    expect(withoutProofStatement(JSON.stringify({ schema: "agents-app/decision-record@1" }))).toBeNull();
  });
});

describe("acceptanceProofStatements (read-only, recorded facts only)", () => {
  it("reads the decision-record artifact each open acceptance decision references; others are absent", async () => {
    const db = await previewDb();
    const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
    const mk = async (key: string) => (await db.insert(tasks).values({ projectId: p!.id, key, title: key, intent: "x", state: "DONE", step: "await_acceptance" }).returning())[0]!;
    const [a, b, c, e, f] = [await mk("A"), await mk("B"), await mk("C"), await mk("E"), await mk("F")];
    const art = async (taskId: number, kind: string, content: string) => (await db.insert(artifacts).values({ taskId, kind, name: "x", content, sha256: "0".repeat(64), workerAuthored: false }).returning())[0]!.id;
    const one = await art(a.id, "decision-record", record([r("waiver"), r("should")]));
    const foreign = await art(a.id, "decision-record", record([]));
    const notRecord = await art(e.id, "evidence-package", record([]));
    const ins = async (taskId: number, kind: "acceptance" | "block", context: Record<string, unknown>) => (await db.insert(decisions).values({ taskId, kind, title: "t", why: "w", options: [], context }).returning())[0]!;
    const da = await ins(a.id, "acceptance", { decisionRecord: { artifactId: one, sha256: "x", attention: "review", residual: [] } });
    const db_ = await ins(b.id, "acceptance", { pr: 1 }); // opened before decision records existed
    const dc = await ins(c.id, "acceptance", { decisionRecord: { artifactId: foreign } }); // another task's artifact
    const de = await ins(e.id, "acceptance", { decisionRecord: { artifactId: notRecord } });
    const df = await ins(f.id, "block", { decisionRecord: { artifactId: one } });
    const before = await db.select().from(artifacts).orderBy(asc(artifacts.id));
    const m = await acceptanceProofStatements((await open(db)), db);
    expect([...m.entries()]).toEqual([[da.id, "1 item would be accepted without proof"]]);
    for (const x of [db_, dc, de, df]) expect(m.has(x.id)).toBe(false);
    expect(await db.select().from(artifacts).orderBy(asc(artifacts.id))).toEqual(before);
    expect(await acceptanceProofStatements([], db)).toEqual(new Map());
  });
});

describe("gate preview demo acceptances (A3)", () => {
  it("gives T4 and T5 one open acceptance decision each, with recorded decision records, once", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const rows = await open(db);
    const acc = rows.filter((x) => x.d.kind === "acceptance");
    expect(acc.map((x) => [x.t.key, x.t.title, x.t.state])).toEqual([
      ["T4", "Demo: share a list", "DONE"],
      ["T5", "Demo: book covers", "DONE"],
    ]);
    // the only open decisions of other kinds remain those of T1 and T2
    expect(rows.filter((x) => x.d.kind !== "acceptance").map((x) => [x.t.key, x.d.kind])).toEqual([
      ["T1", "contract_approval"],
      ["T2", "block"],
    ]);
    const m = await acceptanceProofStatements(rows, db);
    expect(m.get(acc[0]!.d.id)).toBe("2 items would be accepted without proof");
    expect(m.get(acc[1]!.d.id)).toBe("Nothing is accepted without proof");
    const recs = await db.select().from(artifacts).where(eq(artifacts.kind, "decision-record"));
    expect(recs).toHaveLength(2);
    const t4 = JSON.parse(recs.find((x) => x.taskId === acc[0]!.t.id)!.content) as DecisionRecord;
    expect(t4.attention).toBe("review");
    expect(t4.residual.map((x) => x.kind).sort()).toEqual(["finding", "should", "verifier"]);
    const t5 = JSON.parse(recs.find((x) => x.taskId === acc[1]!.t.id)!.content) as DecisionRecord;
    expect(t5).toMatchObject({ attention: "clean", residual: [{ kind: "should" }] });
    // no worker runs, evidence packages or qualification records for the new demo tasks
    const ids = acc.map((x) => x.t.id);
    for (const table of [runs, evidencePackages, qualificationRecords]) expect((await db.select().from(table)).filter((x) => ids.includes(x.taskId!))).toEqual([]);
  });

  it("adds T4 and T5 to a preview database seeded before they existed, leaving the earlier demo data as it was", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    const later = (await db.select().from(tasks)).filter((t) => t.key === "T4" || t.key === "T5").map((t) => t.id);
    await db.delete(decisions).where(eq(decisions.kind, "acceptance"));
    await db.delete(artifacts).where(eq(artifacts.kind, "decision-record"));
    for (const id of later) {
      await db.execute(`delete from transitions where task_id = ${id}`);
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    const before = (await db.select().from(tasks).orderBy(asc(tasks.id))).map(({ updatedAt: _u, ...t }) => t);
    await seedPreviewDemo(db);
    await seedPreviewDemo(db);
    const after = (await db.select().from(tasks).orderBy(asc(tasks.id))).map(({ updatedAt: _u, ...t }) => t);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((t) => t.key)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(await db.select().from(decisions).where(eq(decisions.kind, "acceptance"))).toHaveLength(2);
    expect(await db.select().from(runs)).toHaveLength(2);
    expect(await db.select().from(evidencePackages)).toHaveLength(1);
  });

  it("seeds nothing without the demo project (production has none)", async () => {
    const db = await createDb("pglite://memory");
    await migrate(db, "pglite://memory");
    await seedPreviewDemo(db);
    expect(await db.select().from(tasks)).toHaveLength(0);
    expect(await db.select().from(decisions)).toHaveLength(0);
    expect(await db.select().from(artifacts)).toHaveLength(0);
  });
});

describe("Decisions page acceptance item", () => {
  const props = { taskId: 42, taskKey: "T4", taskTitle: "Demo: share a list", project: "Demo Project", title: "Accept T4: Demo: share a list", why: "Demo.", createdAt: new Date() };
  const render = (proof: string | null) => renderToStaticMarkup(createElement("ul", null, createElement(AcceptanceItem, { ...props, proof })));
  const anchors = (html: string) => [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => ({ attrs: m[1]!, body: m[2]!.replace(/<!-- -->/g, "") }));

  it("has exactly one link, to the task by key and title, the kind badge and the statement as its own element", () => {
    const html = render("2 items would be accepted without proof");
    const links = anchors(html);
    expect(links).toHaveLength(1);
    expect(links[0]!.attrs).toContain('href="/tasks/42"');
    expect(links[0]!.body).toBe("T4 · Demo: share a list");
    expect(html).toMatch(/<span[^>]*>Acceptance<\/span>/);
    expect(html).toMatch(/<p[^>]*>2 items would be accepted without proof<\/p>/);
    expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/);
    expect(html).not.toMatch(/animate-|text-bad|text-warn|text-owner[^"]*">2 items/);
  });

  it("shows neither statement without a recorded decision record", () => {
    const html = render(null);
    expect(html).not.toContain("accepted without proof");
    expect(html).toMatch(/<span[^>]*>Acceptance<\/span>/);
    expect(anchors(html)).toHaveLength(1);
  });
});
