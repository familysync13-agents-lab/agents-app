import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { artifacts, evidence, evidencePackages, executorJobs, tasks } from "@/db/schema";
import { EvidencePackageCard, requiredVerified, verifierStatus, type EvidencePackageView } from "@/components/evidence-package";
import { createTask } from "@/server/owner";
import { currentEvidencePackage } from "@/server/queries";
import { setup } from "./support/harness";

/* T7.b: the read-only "Evidence package" card on the task page. */

const HASH = "ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19";
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
type Db = Awaited<ReturnType<typeof setup>>["db"];

const strip = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const render = (pkg: EvidencePackageView | null) => renderToStaticMarkup(createElement(EvidencePackageCard, { pkg }));
const terms = (h: string) => [...h.matchAll(/<dt\b[^>]*>(.*?)<\/dt>/g)].map((m) => strip(m[1]!));
const values = (h: string) => [...h.matchAll(/<dd\b[^>]*>(.*?)<\/dd>/g)].map((m) => strip(m[1]!));
const value = (h: string, term: string) => values(h)[terms(h).indexOf(term)];
const TERMS = ["Status", "Required criteria verified", "Verifier", "Package hash"];

const demo: EvidencePackageView = { status: "incomplete", summary: { must_total: 3, must: { verified: 2, waived: 1 }, verifier: "not_run" }, sha256: HASH };

describe("EvidencePackageCard", () => {
  it("shows the recorded status, counts, Verifier identifier and full hash in a description list, in order", () => {
    const h = render(demo);
    expect([...h.matchAll(/<h2\b[^>]*>(.*?)<\/h2>/g)].map((m) => strip(m[1]!))).toEqual(["Evidence package"]);
    expect(terms(h)).toEqual(TERMS);
    expect(value(h, "Status")).toBe("incomplete");
    expect(value(h, "Required criteria verified")).toBe("2 of 3");
    expect(value(h, "Verifier")).toBe("not_run");
    expect(value(h, "Package hash")!.replace(/\s/g, "")).toBe(HASH);
    expect(h).not.toContain("No evidence package yet.");
  });

  it("uses the task page look: Card with CardHeader, muted labels, monospace Verifier and wrapping monospace hash", () => {
    const h = render(demo);
    expect(h).toMatch(/^<section class="rounded-2xl border border-line/);
    for (const m of h.matchAll(/<dt\b[^>]*class="([^"]*)"/g)) expect(m[1]).toContain("text-mute");
    expect(h).toMatch(/<code class="[^"]*font-mono[^"]*">not_run<\/code>/);
    expect(h).toMatch(new RegExp(`<code class="[^"]*font-mono[^"]*break-all[^"]*">${HASH}</code>`));
    expect(h).not.toMatch(/animate-|spin|progress/);
  });

  it("says \"No evidence package yet.\" and shows no description list when there is no package", () => {
    const h = render(null);
    expect(strip(h)).toBe("Evidence package No evidence package yet.");
    expect(h).not.toMatch(/<dl\b|<dt\b|<dd\b/);
  });

  it("contains no button, form, input or select", () => {
    for (const h of [render(demo), render(null)]) expect(h).not.toMatch(/<(button|form|input|select|textarea)\b/);
  });

  it("shows only recorded values: a summary field that was not recorded is a dash, never an estimate", () => {
    expect(requiredVerified({ must_total: 3, must: { verified: 0 } })).toBe("0 of 3");
    expect(requiredVerified({ must_total: 3 })).toBeNull();
    expect(requiredVerified({ must: { verified: 2 } })).toBeNull();
    expect(verifierStatus({})).toBeNull();
    const h = render({ status: "blocked", summary: {}, sha256: HASH });
    expect(value(h, "Required criteria verified")).toBe("—");
    expect(value(h, "Verifier")).toBe("—");
  });

  it("is rendered on the task page from the read-only query, alongside the existing cards", () => {
    const src = readFileSync("src/app/(app)/tasks/[id]/page.tsx", "utf8");
    expect(src).toContain("currentEvidencePackage(d.task.id)");
    expect(src).toContain("<EvidencePackageCard pkg={pkg} />");
    for (const title of ["Contract", "Verification", "Workers", "Timeline", "Evidence files", "Operations"]) expect(src).toContain(`title="${title}"`);
  });
});

async function start() {
  const { db, project } = await setup();
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, id };
}

async function store(db: Db, taskId: number, head: string, o: { status: "complete" | "incomplete" | "blocked" | "inconsistent"; sha256: string; total: number; verified: number; verifier: string; stage: string }) {
  const [a] = await db.insert(artifacts).values({ taskId, kind: "evidence-package", name: "pkg", content: "{}", sha256: o.sha256, workerAuthored: false }).returning({ id: artifacts.id });
  await db.insert(evidencePackages).values({ taskId, scope: "task", planTask: null, headSha: head, contractVersion: 1, contractSha256: null, status: o.status, summary: { must_total: o.total, must: { verified: o.verified }, verifier: o.verifier }, artifactId: a!.id, sha256: o.sha256, stage: o.stage });
}

const card = async (db: Db, id: number) => {
  const p = await currentEvidencePackage(id, db);
  return render(p);
};

describe("Evidence package card from stored packages", () => {
  it("does not show an earlier head's package as the current one", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "complete", sha256: "a".repeat(64), total: 4, verified: 4, verifier: "no_defect_found", stage: "done" });
    await db.update(tasks).set({ headSha: H2 }).where(eq(tasks.id, id));
    const h = await card(db, id);
    expect(strip(h)).toContain("No evidence package yet.");
    for (const leaked of ["complete", "4 of 4", "no_defect_found", "a".repeat(64)]) expect(h).not.toContain(leaked);
    await db.update(tasks).set({ headSha: null }).where(eq(tasks.id, id));
    expect(strip(await card(db, id))).toBe("Evidence package No evidence package yet.");
  });

  it("shows the most recently stored package of the current head", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "incomplete", sha256: "c".repeat(64), total: 3, verified: 1, verifier: "defects", stage: "gate" });
    await store(db, id, H1, { status: "complete", sha256: "d".repeat(64), total: 3, verified: 3, verifier: "no_defect_found_partial_coverage", stage: "done" });
    await db.update(tasks).set({ headSha: H1 }).where(eq(tasks.id, id));
    const h = await card(db, id);
    expect(values(h)).toEqual(["complete", "3 of 3", "no_defect_found_partial_coverage", "d".repeat(64)]);
  });

  it("rendering stores, changes or queues nothing", async () => {
    const { db, id } = await start();
    await store(db, id, H1, { status: "incomplete", sha256: HASH, total: 3, verified: 2, verifier: "not_run", stage: "gate" });
    await db.update(tasks).set({ headSha: H1 }).where(eq(tasks.id, id));
    const snap = async () => ({ p: await db.select().from(evidencePackages), a: await db.select().from(artifacts), e: await db.select().from(evidence), j: await db.select().from(executorJobs) });
    const before = await snap();
    const first = await card(db, id);
    const again = await card(db, id);
    expect(again).toBe(first);
    expect(await snap()).toEqual(before);
  });
});
