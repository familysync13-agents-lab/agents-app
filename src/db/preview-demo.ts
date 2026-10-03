import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import type { CapabilityProfile } from "@/domain/profile";
import { contracts, decisions, projects, qualificationRecords, runs, tasks, transitions } from "./schema";

/** Demonstration capability profile of the demo project (no control loop runs in a preview, so nothing would ever detect one). */
export const PREVIEW_CAPABILITY_PROFILE: CapabilityProfile = {
  commit: "0".repeat(40),
  languages: ["typescript"],
  framework: "next",
  packageManager: "npm",
  commands: { build: "npm run build", test: "npm run test", lint: "npm run lint", typecheck: null },
  checkStage: true,
  browserTests: true,
  database: "postgresql",
  tooling: [],
  unknown: ["typecheck command"],
};

/**
 * GATE PREVIEW ONLY (APP_ENV=preview): demonstration tasks in representative states so black-box checks can exercise the owner
 * screens that a preview without a control loop could never reach (open decisions, contract review, acceptance). Every row is
 * plainly demo data in the demo project; nothing here runs in production.
 */
export async function seedPreviewDemo(db: Db) {
  const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
  if (!p) return;
  // a profile carrying the demo commit is earlier demo data of this preview database and is brought up to date; a detected one is kept
  if (!p.capabilityProfile || p.capabilityProfile.commit === PREVIEW_CAPABILITY_PROFILE.commit)
    await db
      .update(projects)
      .set({ capabilityProfile: PREVIEW_CAPABILITY_PROFILE as unknown as Record<string, unknown> })
      .where(eq(projects.id, p.id));
  const existing = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, p.id)).limit(1);
  if (!existing.length) await seedDemoTasks(db, p.id);
  await seedDemoLedger(db, p.id);
}

async function seedDemoTasks(db: Db, projectId: number) {
  const body = {
    id: "T1",
    title: "Demo: export a list as CSV",
    version: 1,
    tier: "standard",
    traces_to: ["OWNER-INTENT-T1"],
    scope: { summary: "Owners can download a list as a CSV file.", paths: ["**"] },
    non_goals: [],
    open_questions: [],
    interface: { ui: 'On /lists/{id}: a button "Export CSV".' },
    criteria: [{ id: "AC1", type: "behavior", priority: "must", tags: [], given: "a list with two books", when: 'the owner presses "Export CSV"', then: "a CSV file with two rows downloads" }],
    canary_routes: ["/"],
  };
  const text = JSON.stringify(body);
  const mk = async (key: string, title: string, state: (typeof tasks.$inferInsert)["state"], step: string) => {
    const [t] = await db.insert(tasks).values({ projectId, key, title, intent: `Demo intent for ${title}.`, state, step }).returning();
    await db.insert(transitions).values({ taskId: t!.id, fromState: null, toState: "PROPOSED", reason: "Demo data (gate preview)", fact: { demo: true } });
    return t!;
  };
  const a = await mk("T1", "Demo: export a list as CSV", "PROPOSED", "await_owner_contract");
  const [c] = await db.insert(contracts).values({ taskId: a.id, version: 1, body, text, sha256: "0".repeat(64), lint: { ok: true, problems: [] }, oracleJs: "// demo", oracleSha256: "1".repeat(64), status: "review" }).returning();
  await db.update(tasks).set({ currentContractId: c!.id }).where(eq(tasks.id, a.id));
  await db.insert(decisions).values({ taskId: a.id, kind: "contract_approval", title: "Approve the contract for T1: Demo: export a list as CSV", why: "Demo decision.", options: [], context: { contractId: c!.id, sha256: c!.sha256, version: 1 } });
  const b = await mk("T2", "Demo: reading progress", "BLOCKED_DECISION", "await_decision");
  const [d] = await db
    .insert(decisions)
    .values({
      taskId: b.id,
      kind: "block",
      title:
        "Should reading progress be computed per book from the pages a reader marks as read, or per list from the number of books marked finished, and should it be visible to people who open the list through a share link or only to the owner of the list?",
      why: "Demo decision with a long worker-written title.",
      options: [
        { id: "o1", label: "Per book, owner only", consequence: "Smallest scope." },
        { id: "o2", label: "Per list, also on the share page", consequence: "Visible to share-link readers." },
      ],
      context: { stage: "build" },
    })
    .returning();
  await db.update(tasks).set({ stepData: { awaiting: d!.id } }).where(eq(tasks.id, b.id));
  await mk("T3", "Demo: list descriptions", "IN_PROGRESS", "build_poll");
}

/** Marker of the demonstration qualification records (they also reference a demo task, so they cannot be mistaken for evidence). */
const DEMO_NOTE = "Demo data (gate preview)";

/**
 * GATE PREVIEW ONLY: the execution ledger of the demo tasks (two finished Builder runs) and three shadow qualification records of the
 * local model for log_summary, so the System page's ledger and routing sections can be checked black-box. Idempotent, also on a
 * preview database whose demo tasks were seeded before these rows existed. Never called in production (see instrumentation.ts).
 */
async function seedDemoLedger(db: Db, projectId: number) {
  const demo = await db.select({ id: tasks.id, key: tasks.key }).from(tasks).where(and(eq(tasks.projectId, projectId), inArray(tasks.key, ["T1", "T3"])));
  const t1 = demo.find((t) => t.key === "T1");
  const t3 = demo.find((t) => t.key === "T3");
  if (!t1 || !t3) return;
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000);
  const hasRuns = await db.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, [t1.id, t3.id])).limit(1);
  if (!hasRuns.length) {
    const claude = { role: "builder", status: "finished", outcome: "report", worker: "claude-code", harness: "claude-code", provider: "anthropic-subscription", model: "opus" } as const;
    // the contract-drafting run of T1 (no context package), then - started later - the build run of T3 with its context package
    await db.insert(runs).values({ ...claude, taskId: t1.id, purpose: "draft_contract", taskClass: "contract_draft", routeReason: "trusted worker (no alternative is defined for this class)", contextBytes: null, startedAt: ago(120), finishedAt: ago(114) });
    await db.insert(runs).values({ ...claude, taskId: t3.id, purpose: "build", taskClass: "build", routeReason: "trusted worker (no alternative has qualified for this class)", contextBytes: 48213, contextFiles: ["src/db/schema.ts", "src/app/(app)/lists/[id]/page.tsx"], startedAt: ago(60), finishedAt: ago(38) });
  }
  const hasQual = await db.select({ id: qualificationRecords.id }).from(qualificationRecords).where(eq(qualificationRecords.note, DEMO_NOTE)).limit(1);
  if (!hasQual.length)
    await db.insert(qualificationRecords).values(
      [1, 2, 3].map((i) => ({ worker: "local-llm", taskClass: "log_summary", mode: "shadow" as const, taskId: t3.id, inputSha256: String(i).padStart(64, "0"), expected: "demo summary", output: { summary: "demo summary" }, valid: true, agree: true, durationMs: 1200, note: DEMO_NOTE })),
    );
}
