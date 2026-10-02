import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { adminActions, intentProposals, projects } from "@/db/schema";
import { createTask } from "./owner";

/*
 * Proposed work. The operator (or the control system, from evidence such as backlog findings) may PROPOSE an intent; only the owner
 * turns proposals into tasks - one click per selection, the same product decision right as writing the intent. Proposals are
 * recorded in the admin audit trail.
 */
export const Proposal = z.object({
  project: z.string().regex(/^[a-z0-9-]{2,40}$/),
  title: z.string().min(3).max(120),
  intent: z.string().min(20).max(6000),
  rationale: z.string().min(10).max(2000),
  source: z.string().min(3).max(200),
  tier: z.enum(["standard", "critical"]).default("standard"),
});

export async function proposeIntent(db: Db, actor: string, input: unknown) {
  const p = Proposal.parse(input);
  const [proj] = await db.select().from(projects).where(eq(projects.slug, p.project));
  if (!proj) throw new Error(`unknown project ${p.project}`);
  const [row] = await db
    .insert(intentProposals)
    .values({ projectId: proj.id, title: p.title, intent: p.intent, rationale: p.rationale, source: p.source, tier: p.tier })
    .returning();
  await db.insert(adminActions).values({ actor, op: "propose_intent", taskId: null, target: { proposal: row!.id, project: p.project }, reason: p.rationale, outcome: "applied", after: { title: p.title } });
  return row!;
}

/** The owner starts the selected proposals: each becomes a task exactly as if the owner had written the intent. */
export async function acceptProposals(db: Db, ids: number[]): Promise<number[]> {
  const rows = await db.select().from(intentProposals).where(and(inArray(intentProposals.id, ids), eq(intentProposals.status, "proposed")));
  const tasks: number[] = [];
  for (const r of rows.sort((a, b) => a.id - b.id)) {
    const id = await createTask(db, { projectId: r.projectId, title: r.title, intent: r.intent, tier: r.tier });
    await db.update(intentProposals).set({ status: "accepted", taskId: id, decidedAt: new Date() }).where(eq(intentProposals.id, r.id));
    tasks.push(id);
  }
  return tasks;
}

export async function declineProposal(db: Db, id: number) {
  await db.update(intentProposals).set({ status: "declined", decidedAt: new Date() }).where(and(eq(intentProposals.id, id), eq(intentProposals.status, "proposed")));
}
