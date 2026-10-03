import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoutingTable, type RoutingRow } from "@/components/routing-table";
import { routingTable } from "@/server/queries";
import { PREVIEW_PROJECTS, seedProjects } from "@/db/seed";
import { seedPreviewDemo } from "@/db/preview-demo";
import { executorJobs, qualificationRecords } from "@/db/schema";
import { createDb } from "@/db/client";
import { migrate } from "@/db/migrate";
import { route, TASK_CLASSES } from "@/domain/router";

const strip = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const render = (rs: RoutingRow[]) => renderToStaticMarkup(createElement(RoutingTable, { rows: rs }));
const headers = (h: string) => [...h.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => strip(m[1]!));
const rows = (h: string) =>
  [...(/<tbody\b[^>]*>(.*?)<\/tbody>/.exec(h)?.[1]?.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g) ?? [])].map((m) =>
    [...m[1]!.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((c) => c[1]!),
  );
const entries = (cell: string) => [...cell.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((m) => strip(m[1]!));

const DEFINED = "trusted worker (no alternative is defined for this class)";
const NOT_QUALIFIED = "trusted worker (no alternative has qualified for this class)";

async function previewDb() {
  const db = await createDb("pglite://memory");
  await migrate(db, "pglite://memory");
  await seedProjects(db, JSON.stringify(PREVIEW_PROJECTS));
  return db;
}

describe("Routing and qualification (System page)", () => {
  it("shows the Router's choice per task class from the preview demo qualification records", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    const html = render(await routingTable(db));
    expect(html.match(/<h2\b[^>]*>Routing and qualification<\/h2>/g)).toHaveLength(1);
    expect(headers(html)).toEqual(["Task class", "Worker", "Reason", "Alternatives"]);
    const body = rows(html);
    expect(body.map((r) => strip(r[0]!))).toEqual([
      "contract_draft",
      "plan",
      "build",
      "correction",
      "mutants",
      "check_author",
      "acceptance_check",
      "attribution",
      "failure_triage",
      "log_summary",
    ]);
    const byClass = Object.fromEntries(
      body.map((r) => [strip(r[0]!), { worker: strip(r[1]!), reason: strip(r[2]!), alts: r[3]! }]),
    );
    for (const c of ["contract_draft", "plan", "mutants"])
      expect(byClass[c]).toMatchObject({ worker: "claude-code", reason: DEFINED });
    for (const c of ["check_author", "acceptance_check", "attribution"])
      expect(byClass[c]).toMatchObject({ worker: "codex-verifier", reason: DEFINED });
    for (const c of ["build", "correction", "log_summary"])
      expect(byClass[c]).toMatchObject({ worker: "claude-code", reason: NOT_QUALIFIED });
    expect(byClass.failure_triage).toMatchObject({ worker: "codex-verifier", reason: NOT_QUALIFIED });
    for (const c of ["build", "correction"])
      expect(entries(byClass[c]!.alts)).toEqual([
        "codex-builder disabled 0 samples",
        "opencode-local disabled 0 samples",
      ]);
    expect(entries(byClass.failure_triage!.alts)).toEqual(["local-llm unqualified 0 samples"]);
    expect(entries(byClass.log_summary!.alts)).toEqual(["local-llm shadow 3 samples"]);
    for (const c of ["contract_draft", "plan", "mutants", "check_author", "acceptance_check", "attribution"])
      expect(strip(byClass[c]!.alts)).toBe("—");
    expect(html).not.toMatch(/<(button|form|input|select)\b/);
  });

  it("shows a qualified alternative as the chosen worker with the Router's reason", async () => {
    const db = await previewDb();
    await seedPreviewDemo(db);
    await db
      .insert(qualificationRecords)
      .values(
        Array.from({ length: 20 }, (_, i) => ({
          worker: "local-llm",
          taskClass: "log_summary",
          mode: "harness" as const,
          inputSha256: `q${i}`,
          valid: true,
          agree: true,
        })),
      );
    const table = await routingTable(db);
    const row = table.find((r) => r.taskClass === "log_summary")!;
    expect(row.worker).toBe("local-llm");
    expect(row.reason).toMatch(/^qualified for log_summary/);
    expect(row.alternatives).toEqual([{ worker: "local-llm", status: "qualified", samples: 23 }]);
    const records = await db.select().from(qualificationRecords);
    expect(row.reason).toBe(route({ taskClass: "log_summary", risk: "standard", records }).reason);
    const cell = rows(render(table))[TASK_CLASSES.indexOf("log_summary")]!;
    expect(strip(cell[1]!)).toBe("local-llm");
    expect(entries(cell[3]!)).toEqual(["local-llm qualified 23 samples"]);
  });

  it("reports a disabled alternative as disabled even with recorded samples, and never writes", async () => {
    const db = await previewDb();
    await db
      .insert(qualificationRecords)
      .values(
        Array.from({ length: 25 }, (_, i) => ({
          worker: "codex-builder",
          taskClass: "build",
          mode: "harness" as const,
          inputSha256: `b${i}`,
          valid: true,
          agree: true,
        })),
      );
    const before = await db.select().from(qualificationRecords);
    const table = await routingTable(db);
    const build = table.find((r) => r.taskClass === "build")!;
    expect(build).toMatchObject({ worker: "claude-code", reason: NOT_QUALIFIED });
    expect(build.alternatives[0]).toEqual({ worker: "codex-builder", status: "disabled", samples: 25 });
    expect(await db.select().from(qualificationRecords)).toEqual(before);
    expect(await db.select().from(executorJobs)).toEqual([]);
  });

  it("does not change the Router", () => {
    // the card reads the Router's exports; the rule table itself stays as reviewed
    const src = readFileSync("src/domain/router.ts", "utf8");
    expect(src).toContain('log_summary: { trusted: "claude-code", alternatives: ["local-llm"] }');
  });
});
