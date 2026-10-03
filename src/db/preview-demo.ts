import { eq } from "drizzle-orm";
import type { Db } from "./client";
import type { CapabilityProfile } from "@/domain/profile";
import { contracts, decisions, projects, tasks, transitions } from "./schema";

/** Demonstration capability profile of the demo project (no control loop runs in a preview, so nothing would ever detect one). */
export const PREVIEW_CAPABILITY_PROFILE: CapabilityProfile = {
  commit: "0".repeat(40),
  languages: ["typescript"],
  framework: "next",
  packageManager: "npm",
  commands: { build: "npm run build", test: "npm run test", lint: null, typecheck: "npm run typecheck" },
  checkStage: true,
  browserTests: false,
  database: "postgresql",
  tooling: [],
  unknown: ["lint command"],
};

/**
 * GATE PREVIEW ONLY (APP_ENV=preview): demonstration tasks in representative states so black-box checks can exercise the owner
 * screens that a preview without a control loop could never reach (open decisions, contract review, acceptance). Every row is
 * plainly demo data in the demo project; nothing here runs in production.
 */
export async function seedPreviewDemo(db: Db) {
  const [p] = await db.select().from(projects).where(eq(projects.slug, "demo"));
  if (!p) return;
  if (!p.capabilityProfile)
    await db
      .update(projects)
      .set({ capabilityProfile: PREVIEW_CAPABILITY_PROFILE as unknown as Record<string, unknown> })
      .where(eq(projects.id, p.id));
  const existing = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, p.id)).limit(1);
  if (existing.length) return;
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
    const [t] = await db.insert(tasks).values({ projectId: p.id, key, title, intent: `Demo intent for ${title}.`, state, step }).returning();
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
