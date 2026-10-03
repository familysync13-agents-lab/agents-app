import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkerRuns, NO_RUNS, type WorkerRun } from "@/components/worker-runs";
import { recentWorkerRuns } from "@/server/queries";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { runs, tasks } from "@/db/schema";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";

const strip = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const render = (rs: WorkerRun[]) => renderToStaticMarkup(createElement(WorkerRuns, { runs: rs }));
const headers = (h: string) => [...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => strip(m[1]!));
const rows = (h: string) =>
  [.../<tbody\b[^>]*>(.*?)<\/tbody>/.exec(h)?.[1]?.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g) ?? []].map((m) =>
    [...m[1]!.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((c) => strip(c[1]!)),
  );
const HEADERS = ["Task", "Purpose", "Worker", "Task class", "Reason", "Context bytes"];

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  return db;
}

describe("Recent worker runs (System page)", () => {
  it("shows the preview demo runs newest first with their recorded values", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    const html = render(await recentWorkerRuns(db));
    expect(html.match(/<h2\b[^>]*>Recent worker runs<\/h2>/g)).toHaveLength(1);
    expect(headers(html)).toEqual(HEADERS);
    expect(rows(html)).toEqual([
      ["T3", "build", "claude-code", "build", "trusted worker (no alternative has qualified for this class)", "48213"],
      ["T1", "draft_contract", "claude-code", "contract_draft", "trusted worker (no alternative is defined for this class)", "—"],
    ]);
    expect(html).not.toMatch(/<(button|form|input|select)\b/);
  });

  it("lists only the 20 most recently started runs, the most recent first", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    const [t] = await db.select().from(tasks).limit(1);
    const base = Date.UTC(2030, 0, 1);
    // inserted out of start order: the order shown follows the start time, not the insertion order
    for (const i of [5, 22, 0, 13, 7, 1, 19, 3, 21, 9, 11, 2, 17, 15, 4, 20, 6, 10, 8, 14, 12, 16, 18]) {
      await db.insert(runs).values({ taskId: t!.id, role: "builder", purpose: "build", worker: `w${i}`, startedAt: new Date(base + i * 60_000) });
    }
    const rs = await recentWorkerRuns(db);
    expect(rs).toHaveLength(20);
    expect(rs.map((r) => r.worker)).toEqual(Array.from({ length: 20 }, (_, k) => `w${22 - k}`));
    const body = rows(render(rs));
    expect(body).toHaveLength(20);
    expect(body[0]).toEqual([t!.key, "build", "w22", "—", "—", "—"]);
  });

  it("shows the heading and the empty-state text, without rows, when no run is recorded", async () => {
    const db = await previewDb();
    expect(await recentWorkerRuns(db)).toEqual([]);
    const html = render([]);
    expect(html).toMatch(/<h2\b[^>]*>Recent worker runs<\/h2>/);
    expect(strip(html)).toContain(NO_RUNS);
    expect(NO_RUNS).toBe("No worker runs yet");
    expect(rows(html)).toEqual([]);
  });

  it("shows a dash for every unrecorded value", () => {
    const html = render([{ id: 1, taskId: 7, key: "T9", purpose: "plan", worker: null, taskClass: null, routeReason: null, contextBytes: null }]);
    expect(rows(html)).toEqual([["T9", "plan", "—", "—", "—", "—"]]);
    expect(html).toContain('href="/tasks/7"');
  });
});
