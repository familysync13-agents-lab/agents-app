import { and, desc, eq, isNotNull, isNull, like } from "drizzle-orm";
import type { Db } from "@/db/client";
import { evidence, executorJobs, qualificationRecords } from "@/db/schema";
import { sha256 } from "@/domain/contract";
import { qualification, ROUTES, route, TASK_CLASSES, WORKERS, type QualRecord, type Risk } from "@/domain/router";

/*
 * SHADOW MODE and the QUALIFICATION HARNESS for bounded semantic work (Builder phase).
 * A candidate path (the local model) receives the same bounded, structured input the trusted path decided - in production (shadow)
 * or as a replay of recorded historical cases (harness). Its output is schema-validated, recorded and compared. It controls nothing:
 * the trusted path's result is what the control system acts on. The Router promotes a candidate only from these records.
 */
const PARTIES = ["implementation", "oracle", "environment", "ambiguity"] as const;
const SYSTEM = `You classify who owns a failed acceptance check. Answer with JSON only: {"parties": [...]} where each element is one of "implementation" (the product is wrong), "oracle" (the check itself is defective or stale), "environment" (infrastructure), "ambiguity" (the contract allows two readings). List every party that applies, nothing else.`;

export const triagePrompt = (details: string) => `Gate findings:\n${details.slice(0, 6000)}`;
const norm = (ps: unknown) => (Array.isArray(ps) ? [...new Set(ps.map((x) => String(x)))].filter((x) => (PARTIES as readonly string[]).includes(x)).sort().join("+") : "");

/** Give the candidate the same bounded input (shadow or harness). Returns false when no candidate may receive this class. */
export async function submitCandidate(db: Db, i: { taskId: number; risk: Risk; details: string; expected: string; mode: "shadow" | "harness" }): Promise<boolean> {
  const records = await db.select({ worker: qualificationRecords.worker, taskClass: qualificationRecords.taskClass, valid: qualificationRecords.valid, agree: qualificationRecords.agree }).from(qualificationRecords);
  const d = route({ taskClass: "failure_triage", risk: i.risk, records });
  const candidates = i.mode === "harness" ? ROUTES.failure_triage.alternatives.filter((w) => WORKERS[w]!.enabled) : d.shadow;
  if (!candidates.includes("local-llm")) return false;
  const prompt = triagePrompt(i.details);
  const [job] = await db.insert(executorJobs).values({ taskId: i.taskId, op: "local_llm", params: { system: SYSTEM, prompt } }).returning({ id: executorJobs.id });
  await db.insert(qualificationRecords).values({ worker: "local-llm", taskClass: "failure_triage", mode: i.mode, taskId: i.taskId, inputSha256: sha256(prompt), expected: i.expected, jobId: job!.id });
  return true;
}

/** Read finished candidate jobs and record validity and agreement. Called by the control loop; never affects any task. */
export async function collectCandidates(db: Db): Promise<number> {
  const open = await db.select().from(qualificationRecords).where(and(isNotNull(qualificationRecords.jobId), isNull(qualificationRecords.valid))).limit(20);
  let n = 0;
  for (const r of open) {
    const [j] = await db.select().from(executorJobs).where(eq(executorJobs.id, r.jobId!));
    if (!j || j.status === "queued" || j.status === "running") continue;
    const res = (j.result ?? {}) as { ok?: boolean; available?: boolean; output?: { parties?: unknown } | null; ms?: number; model?: string; reason?: string };
    if (j.status === "error" || res.available === false) {
      // the candidate could not run at all: not evidence about its quality - the record is closed without a verdict
      await db.update(qualificationRecords).set({ valid: false, agree: null, note: `candidate unavailable: ${String(j.error ?? res.reason ?? "").slice(0, 160)}` }).where(eq(qualificationRecords.id, r.id));
    } else {
      const got = norm(res.output?.parties);
      const valid = res.ok === true && got.length > 0;
      await db.update(qualificationRecords).set({ valid, agree: valid && got === r.expected, output: (res.output ?? { raw: null }) as Record<string, unknown>, durationMs: res.ms ?? null, note: res.model ?? null }).where(eq(qualificationRecords.id, r.id));
    }
    n++;
  }
  return n;
}

/**
 * Qualification harness: replay recorded historical triage cases (the gate findings of a head and what the trusted arbiter decided
 * for it) through the candidate. No trusted worker is re-run - the original record is the baseline.
 */
export async function qualifyReplay(db: Db, limit = 30): Promise<{ submitted: number; cases: number }> {
  const arb = await db.select().from(evidence).where(like(evidence.source, "arbiter:%")).orderBy(desc(evidence.id)).limit(400);
  const cases = new Map<string, { taskId: number; commit: string; parties: Set<string> }>();
  for (const e of arb) {
    const k = `${e.taskId}|${e.source}`;
    const c = cases.get(k) ?? { taskId: e.taskId, commit: e.commitSha ?? "", parties: new Set<string>() };
    const p = String(e.detail ?? "").split(":")[0]!.toLowerCase();
    if ((PARTIES as readonly string[]).includes(p)) c.parties.add(p);
    cases.set(k, c);
  }
  let submitted = 0;
  for (const c of [...cases.values()].slice(0, limit)) {
    const gate = await db.select().from(evidence).where(and(eq(evidence.taskId, c.taskId), eq(evidence.commitSha, c.commit), eq(evidence.status, "not_verified"), eq(evidence.oracle, "deterministic")));
    if (gate.length === 0 || c.parties.size === 0) continue;
    const details = gate.map((g) => `- ${g.subject}: ${String(g.detail ?? "").slice(0, 900)}`).join("\n");
    if (await submitCandidate(db, { taskId: c.taskId, risk: "standard", details, expected: [...c.parties].sort().join("+"), mode: "harness" })) submitted++;
  }
  return { submitted, cases: cases.size };
}

/** The Router's current, reviewable rule table: for every task class the worker that would run now and why, with the evidence. */
export async function routeTable(db: Db) {
  const records: QualRecord[] = await db.select({ worker: qualificationRecords.worker, taskClass: qualificationRecords.taskClass, valid: qualificationRecords.valid, agree: qualificationRecords.agree }).from(qualificationRecords);
  return TASK_CLASSES.map((tc) => {
    const d = route({ taskClass: tc, risk: "standard", records });
    return { taskClass: tc, worker: d.worker, reason: d.reason, shadow: d.shadow, alternatives: ROUTES[tc].alternatives.map((w) => ({ worker: w, enabled: WORKERS[w]!.enabled, disabledReason: WORKERS[w]!.disabledReason ?? null, ...qualification(records, w, tc) })) };
  });
}
