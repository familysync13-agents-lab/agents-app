import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { activity, contracts, decisions, projects, tasks, transitions } from "@/db/schema";

/*
 * The owner's write path. The owner holds product/design/security decision rights; these functions only RECORD decisions. The
 * control loop applies them, and anything the repository treats as protected still requires the owner's GitHub review.
 */

export const NewTask = z.object({
  projectId: z.coerce.number().int().positive(),
  title: z.string().trim().min(3, "Give the task a short title (at least 3 characters).").max(120, "Keep the title under 120 characters."),
  intent: z
    .string()
    .trim()
    .min(20, "Describe what should be built or changed (at least 20 characters).")
    .max(6000, "Keep the intent under 6000 characters."),
  tier: z.enum(["standard", "critical"]),
});

export async function createTask(db: Db, input: z.infer<typeof NewTask>): Promise<number> {
  const data = NewTask.parse(input);
  const [p] = await db.select().from(projects).where(and(eq(projects.id, data.projectId), eq(projects.active, true)));
  if (!p) throw new OwnerError("Unknown project.");
  const [t] = await db
    .insert(tasks)
    .values({ projectId: p.id, title: data.title, intent: data.intent, tier: data.tier, state: "PROPOSED", step: "draft_contract" })
    .returning({ id: tasks.id });
  await db.insert(transitions).values({
    taskId: t!.id,
    fromState: null,
    toState: "PROPOSED",
    reason: "Intent recorded by the owner",
    fact: { owner: "app", title: data.title, tier: data.tier },
  });
  await db.insert(activity).values({ taskId: t!.id, actor: "owner", message: `Intent recorded: “${data.title}” (${data.tier} tier).` });
  return t!.id;
}

export class OwnerError extends Error {}

export const ContractDecision = z.object({
  taskId: z.coerce.number().int().positive(),
  contractId: z.coerce.number().int().positive(),
  choice: z.enum(["approve", "changes", "reject"]),
  note: z.string().trim().max(4000).optional().default(""),
});

/** The owner's in-app contract review. Approval is bound to the exact contract hash that was shown. */
export async function decideContract(db: Db, input: z.infer<typeof ContractDecision> & { sha256: string }) {
  const d = ContractDecision.parse(input);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, d.taskId));
  if (!t || t.currentContractId !== d.contractId || t.step !== "await_owner_contract") throw new OwnerError("This contract is no longer awaiting your review.");
  const [c] = await db.select().from(contracts).where(eq(contracts.id, d.contractId));
  if (!c || c.status !== "review") throw new OwnerError("This contract is no longer awaiting your review.");
  if (c.sha256 !== input.sha256) throw new OwnerError("The contract changed since you opened it. Review the current version.");
  if (d.choice === "changes" && d.note.length < 3) throw new OwnerError("Say what should change.");
  const status = d.choice === "approve" ? "approved_app" : d.choice === "changes" ? "changes_requested" : "rejected";
  await db.update(contracts).set({ status, ownerNote: d.note || null }).where(eq(contracts.id, c.id));
  await db
    .update(decisions)
    .set({ status: "decided", choice: d.choice, note: d.note || null, decidedVia: "app", decidedAt: new Date() })
    .where(and(eq(decisions.taskId, t.id), eq(decisions.kind, "contract_approval"), eq(decisions.status, "open")));
  await db.insert(activity).values({
    taskId: t.id,
    actor: "owner",
    message:
      d.choice === "approve"
        ? `Contract v${c.version} approved in Agents App (sha256 ${c.sha256.slice(0, 12)}).`
        : d.choice === "changes"
          ? `Changes requested on contract v${c.version}: ${d.note.slice(0, 200)}`
          : `Intent rejected at contract review.`,
  });
}

export const BlockDecision = z.object({
  decisionId: z.coerce.number().int().positive(),
  choice: z.string().trim().min(1).max(40),
  note: z.string().trim().max(4000).optional().default(""),
});

/** The owner's answer to a block or a budget question. */
export async function decideBlock(db: Db, input: z.infer<typeof BlockDecision>) {
  const d = BlockDecision.parse(input);
  const [row] = await db.select().from(decisions).where(eq(decisions.id, d.decisionId));
  if (!row || row.status !== "open" || !["block", "budget"].includes(row.kind)) throw new OwnerError("This decision is no longer open.");
  if (!row.options.some((o) => o.id === d.choice) && d.choice !== "custom") throw new OwnerError("Choose one of the options.");
  if (d.choice === "custom" && d.note.length < 3) throw new OwnerError("Write your answer.");
  await db
    .update(decisions)
    .set({ status: "decided", choice: d.choice, note: d.note || null, decidedVia: "app", decidedAt: new Date() })
    .where(eq(decisions.id, row.id));
  const label = row.options.find((o) => o.id === d.choice)?.label ?? "Own answer";
  await db.insert(activity).values({ taskId: row.taskId, actor: "owner", message: `Decision: ${label}${d.note ? ` — ${d.note.slice(0, 200)}` : ""}` });
}

/** Reject a DONE result (closing the PR is done by the control loop through the abandon path). */
export async function rejectResult(db: Db, taskId: number, note: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t || t.state !== "DONE") throw new OwnerError("Only a DONE result can be rejected.");
  const [dec] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.taskId, taskId), eq(decisions.kind, "acceptance"), eq(decisions.status, "open")))
    .orderBy(desc(decisions.id));
  if (dec)
    await db
      .update(decisions)
      .set({ status: "decided", choice: "reject", note: note || null, decidedVia: "app", decidedAt: new Date() })
      .where(eq(decisions.id, dec.id));
  await db.insert(activity).values({ taskId, actor: "owner", message: `Result rejected${note ? `: ${note.slice(0, 200)}` : ""}.` });
}
