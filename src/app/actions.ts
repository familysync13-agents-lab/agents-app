"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isOwner } from "@/server/auth";
import { createTask, decideBlock, decideContract, NewTask, OwnerError, rejectResult } from "@/server/owner";
import { runAdmin } from "@/server/admin";
import { acceptProposals, declineProposal } from "@/server/proposals";

export type FormState = { error?: string; fieldErrors?: Record<string, string>; ok?: boolean };

async function guard(): Promise<FormState | null> {
  return (await isOwner()) ? null : { error: "Your session has ended. Open Agents again from the daemon link." };
}

export async function createTaskAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  const parsed = NewTask.safeParse({
    projectId: form.get("projectId"),
    title: form.get("title"),
    intent: form.get("intent"),
    tier: form.get("tier"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    return { fieldErrors };
  }
  let id: number;
  try {
    id = await createTask(await getDb(), parsed.data);
  } catch (e) {
    return { error: e instanceof OwnerError ? e.message : "Could not record the intent. Try again." };
  }
  revalidatePath("/");
  redirect(`/tasks/${id}`);
}

const ContractForm = z.object({
  taskId: z.coerce.number().int(),
  contractId: z.coerce.number().int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  choice: z.enum(["approve", "changes", "reject"]),
  note: z.string().max(4000).optional().default(""),
});

export async function contractDecisionAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  const p = ContractForm.safeParse(Object.fromEntries(form));
  if (!p.success) return { error: "Choose an option." };
  try {
    await decideContract(await getDb(), p.data);
  } catch (e) {
    return { error: e instanceof OwnerError ? e.message : "Could not record your decision. Try again." };
  }
  revalidatePath(`/tasks/${p.data.taskId}`);
  return { ok: true };
}

export async function blockDecisionAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  const decisionId = form.get("decisionId");
  const taskId = Number(form.get("taskId"));
  try {
    await decideBlock(await getDb(), { decisionId: Number(decisionId), choice: String(form.get("choice") ?? ""), note: String(form.get("note") ?? "") });
  } catch (e) {
    return { error: e instanceof OwnerError ? e.message : e instanceof z.ZodError ? "Choose an option." : "Could not record your decision. Try again." };
  }
  revalidatePath(`/tasks/${taskId}`);
  return { ok: true };
}

export async function rejectResultAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  const taskId = Number(form.get("taskId"));
  try {
    await rejectResult(await getDb(), taskId, String(form.get("note") ?? "").slice(0, 2000));
  } catch (e) {
    return { error: e instanceof OwnerError ? e.message : "Could not record your decision." };
  }
  revalidatePath(`/tasks/${taskId}`);
  return { ok: true };
}

export async function adminAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  const taskId = Number(form.get("taskId"));
  const op = String(form.get("op") ?? "");
  const req: Record<string, unknown> = { op, taskId, reason: String(form.get("reason") ?? "").trim() };
  if (op === "stop_run") req.runId = Number(form.get("runId"));
  if (op === "reopen_decision") req.decisionId = Number(form.get("decisionId"));
  const r = await runAdmin(await getDb(), "owner", req);
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/system");
  return r.ok ? { ok: true } : { error: `Refused: ${r.refusal}${r.refusal === "invalid request" ? " (a reason of at least 8 characters is required)" : ""}` };
}

const BatchItems = z.array(z.object({ taskId: z.number().int(), contractId: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(2).max(10);

/** Approve several reviewed contracts in one sitting (each approval is still individual and sha-bound; GitHub gets one PR). */
export async function approveContractsAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  if (form.get("reviewed") !== "yes") return { error: "Confirm that you reviewed every contract in this group." };
  let items: z.infer<typeof BatchItems>;
  try {
    items = BatchItems.parse(JSON.parse(String(form.get("items") ?? "[]")));
  } catch {
    return { error: "The group changed; reload the page." };
  }
  const db = await getDb();
  const failed: string[] = [];
  for (const it of items) {
    try {
      await decideContract(db, { ...it, choice: "approve", note: "" });
    } catch (e) {
      failed.push(e instanceof OwnerError ? e.message : `task ${it.taskId}: could not record`);
    }
  }
  revalidatePath("/decisions");
  return failed.length ? { error: `Some approvals were not recorded: ${failed.join("; ")}` } : { ok: true };
}

export async function startProposalsAction(_: FormState, form: FormData): Promise<FormState> {
  const g = await guard();
  if (g) return g;
  const ids = form.getAll("proposal").map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { error: "Select at least one proposal to start." };
  const started = await acceptProposals(await getDb(), ids);
  revalidatePath("/");
  return { ok: true, error: undefined, fieldErrors: { started: String(started.length) } };
}

export async function declineProposalAction(form: FormData): Promise<void> {
  if (!(await isOwner())) return;
  await declineProposal(await getDb(), Number(form.get("proposal")));
  revalidatePath("/");
}
