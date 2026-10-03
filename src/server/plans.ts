import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { activity, contracts, plans } from "@/db/schema";
import type { Contract } from "@/domain/contract";
import { classifyShape, fulfilmentBlockers, integratedRequirement, validatePlan, PlanBody, type IntegratedVerification, type ShapeFacts } from "@/domain/plan";

export type ContractRow = typeof contracts.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;

/** The plan currently in force for a task, if any. */
export async function activePlan(db: Db, taskId: number): Promise<PlanRow | undefined> {
  const [p] = await db.select().from(plans).where(and(eq(plans.taskId, taskId), eq(plans.status, "active"))).orderBy(desc(plans.planVersion)).limit(1);
  return p;
}

/**
 * Record a plan for a contract version: classify its shape by the deterministic rules, attach the (optional) one-level task graph,
 * check coverage, and supersede the previous plan. (Re-)planning NEVER touches the contract: no contract row, hash or version
 * changes here. A decomposed plan that fails validation is refused - a requirement must never be lost in planning.
 */
export async function recordPlan(
  db: Db,
  c: ContractRow,
  input: { tasks?: unknown[]; integration?: string[]; facts?: ShapeFacts; reason: string },
): Promise<{ ok: true; plan: PlanRow } | { ok: false; problems: string[] }> {
  const body = c.body as unknown as Contract;
  const cls = classifyShape(body, input.facts ?? {});
  const [last] = await db.select().from(plans).where(eq(plans.taskId, c.taskId)).orderBy(desc(plans.planVersion)).limit(1);
  const decomposed = (input.tasks?.length ?? 0) > 0;
  const raw = {
    contract: body.id,
    contract_version: c.version,
    contract_sha256: c.sha256,
    plan_version: (last?.planVersion ?? 0) + 1,
    shape: decomposed ? "complex" : cls.shape,
    shape_reasons: cls.reasons,
    tasks: input.tasks ?? [],
    integration: input.integration ?? [],
  };
  let coverage: { ok: boolean; problems: string[] };
  let planBody: PlanBody;
  if (raw.shape === "complex" && !decomposed) {
    // classified complex, not (yet) decomposed: the contract is built as one job and judged by its full check, exactly as before.
    planBody = PlanBody.parse(raw);
    coverage = { ok: true, problems: ["complex by rule; not decomposed: built as one job against the full contract"] };
  } else {
    const v = validatePlan(body, c.sha256, raw);
    if (!v.ok || !v.plan) return { ok: false, problems: v.problems };
    planBody = v.plan;
    coverage = { ok: true, problems: [] };
  }
  await db.update(plans).set({ status: "superseded" }).where(and(eq(plans.taskId, c.taskId), eq(plans.status, "active")));
  const [row] = await db
    .insert(plans)
    .values({ taskId: c.taskId, contractId: c.id, planVersion: planBody.plan_version, body: planBody as unknown as Record<string, unknown>, coverage, integrated: integratedRequirement(planBody) as unknown as Record<string, unknown>, reason: input.reason })
    .returning();
  await db.insert(activity).values({
    taskId: c.taskId,
    actor: "system",
    message: `Plan v${planBody.plan_version} for contract v${c.version}: ${planBody.shape}${planBody.shape_reasons.length ? ` (${planBody.shape_reasons.join("; ")})` : ""}${decomposed ? `, ${planBody.tasks.length} tasks, integrated verification required` : ""}. ${input.reason}`.slice(0, 600),
    ref: { plan: row!.id, contract: c.id },
  });
  return { ok: true, plan: row! };
}

/** Why the task's contract cannot be declared fulfilled yet because of its plan (empty when nothing stands in the way). */
export async function planBlockers(db: Db, taskId: number): Promise<string[]> {
  const p = await activePlan(db, taskId);
  if (!p) return [];
  return fulfilmentBlockers(PlanBody.parse(p.body), p.integrated as unknown as IntegratedVerification);
}
