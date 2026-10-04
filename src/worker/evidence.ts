import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { artifacts, contracts, evidence, evidencePackages, gateResults, plans, tasks, type EvidenceScope } from "@/db/schema";
import { Contract, sha256 } from "@/domain/contract";
import { buildPackage, linkage, recordHash, verifyChain, type ChainRow, type EvRow, type EvidencePackage, type SealedRow } from "@/domain/evidence";
import { gateScope, PlanBody } from "@/domain/plan";

/*
 * Evidence store operations (modernization phase 3): every write is structured, linked and sealed here; packages are assembled
 * here. Deterministic throughout - the rules are in domain/evidence.ts.
 */
type Task = typeof tasks.$inferSelect;
type EvidenceInsert = Omit<typeof evidence.$inferInsert, "taskId">;
type EvidenceRow = typeof evidence.$inferSelect;

/** Where the task's work stands in its plan: which plan task (or the integrated result) the current head belongs to. */
export async function evidenceScope(db: Db, taskId: number): Promise<{ scope: EvidenceScope; planTask: string | null; inScope: string[] | null; plan: { version: number; tasks: { id: string; status: string; covers: string[] }[]; integration: string[] } | null }> {
  const [row] = await db.select().from(plans).where(and(eq(plans.taskId, taskId), eq(plans.status, "active"))).orderBy(desc(plans.planVersion)).limit(1);
  const body = row ? PlanBody.safeParse(row.body) : null;
  if (!row || !body?.success || body.data.tasks.length === 0) return { scope: "task", planTask: null, inScope: null, plan: null };
  const p = body.data;
  const live = p.tasks.filter((t) => t.status !== "dropped").sort((a, b) => a.id.localeCompare(b.id));
  // same order rule as the plan execution (dependencies first, stable by id)
  const order: typeof live = [];
  const left = [...live];
  const done = new Set<string>();
  while (left.length) {
    const i = left.findIndex((t) => t.depends_on.every((d) => done.has(d) || !left.some((x) => x.id === d)));
    const [t] = left.splice(i < 0 ? 0 : i, 1);
    order.push(t!);
    done.add(t!.id);
  }
  const index = order.findIndex((t) => t.status !== "done");
  const plan = { version: row.planVersion, tasks: order.map((t) => ({ id: t.id, status: t.status, covers: t.covers })), integration: p.integration };
  // every task done, or the last one in progress: the head is the integrated result, judged against the complete contract
  if (index < 0 || index === order.length - 1) return { scope: "integrated", planTask: null, inScope: null, plan };
  const cur = order[index]!;
  const merged = order.slice(0, index).map((t) => t.id.split(".")[1]!);
  return { scope: "plan_task", planTask: cur.id, inScope: gateScope(p, cur.id.split(".")[1]!, merged, false), plan };
}

const sealedOf = (r: EvidenceRow, artifactSha: string | null): SealedRow => ({
  taskId: r.taskId, seq: r.seq ?? 0, subject: r.subject, status: r.status, oracle: r.oracle, persistence: r.persistence, source: r.source, commitSha: r.commitSha, contractSha256: r.contractSha256, detail: r.detail, severity: r.severity,
  kind: r.kind, criterionTask: r.criterionTask, criterionId: r.criterionId, contractVersion: r.contractVersion, planTask: r.planTask, scope: r.scope, collector: r.collector, runId: r.runId, gateResultId: r.gateResultId, checkName: r.checkName, artifactSha256: artifactSha,
});

async function artifactHashes(db: Db, ids: (number | null)[]): Promise<Map<number, string>> {
  const want = [...new Set(ids.filter((x): x is number => typeof x === "number"))];
  if (!want.length) return new Map();
  return new Map((await db.select({ id: artifacts.id, sha256: artifacts.sha256 }).from(artifacts).where(inArray(artifacts.id, want))).map((a) => [a.id, a.sha256]));
}

async function chainTail(db: Db, taskId: number): Promise<{ seq: number; hash: string | null }> {
  const [last] = await db.select({ seq: evidence.seq, hash: evidence.recordSha256 }).from(evidence).where(eq(evidence.taskId, taskId)).orderBy(desc(evidence.seq)).limit(1);
  return { seq: last?.seq ?? 0, hash: last?.hash ?? null };
}

/**
 * The ONLY way evidence is written. The caller states the observation (as before); structure, linkage, provenance and the seal are
 * added here: criterion linkage by id from the subject, the contract version the task is on, the plan task or integrated scope the
 * head belongs to, the gate result behind a "gate:<check run>" source, and the row's place in the task's hash chain.
 */
export async function recordEvidence(db: Db, task: Task, e: EvidenceInsert): Promise<number> {
  await sealBacklog(db, task.id); // rows written before the Evidence phase are sealed first, so the chain has no gap
  const l = linkage({ subject: e.subject, source: e.source, detail: e.detail, taskKey: task.key });
  const [c] = task.currentContractId ? await db.select({ version: contracts.version, sha256: contracts.sha256 }).from(contracts).where(eq(contracts.id, task.currentContractId)) : [];
  const sc = await evidenceScope(db, task.id);
  const [g] = l.checkRun !== null ? await db.select({ id: gateResults.id }).from(gateResults).where(eq(gateResults.checkRunId, l.checkRun)) : [];
  const tail = await chainTail(db, task.id);
  const values = {
    ...e,
    taskId: task.id,
    kind: e.kind ?? l.kind,
    criterionTask: e.criterionTask ?? l.criterionTask,
    criterionId: e.criterionId ?? l.criterionId,
    contractVersion: e.contractVersion ?? c?.version ?? null,
    // evidence about a head is evidence about the plan task / integrated result that head belongs to
    planTask: e.planTask ?? (e.commitSha ? sc.planTask : null),
    scope: e.scope ?? (e.commitSha ? sc.scope : null),
    collector: e.collector ?? l.collector,
    runId: e.runId ?? l.runId,
    gateResultId: e.gateResultId ?? g?.id ?? null,
    checkName: e.checkName ?? l.checkName,
    seq: tail.seq + 1,
    prevSha256: tail.hash,
    sealed: "recorded" as const,
  };
  const art = (await artifactHashes(db, [values.artifactId ?? null])).get(values.artifactId ?? -1) ?? null;
  const recordSha256 = recordHash(tail.hash, sealedOf({ ...(values as unknown as EvidenceRow), commitSha: values.commitSha ?? null, contractSha256: values.contractSha256 ?? null, detail: values.detail ?? null, severity: values.severity ?? null }, art));
  const [row] = await db.insert(evidence).values({ ...values, recordSha256 }).returning({ id: evidence.id });
  return row!.id;
}

/**
 * Seal rows that predate the Evidence phase (idempotent): fill their structure from subject/source exactly as new rows get it, and
 * extend the task's chain over them in id order. They are marked "backfilled": the seal proves they have not changed SINCE the
 * migration, not since they were written.
 */
export async function sealBacklog(db: Db, taskId?: number): Promise<number> {
  const open = await db.select().from(evidence).where(taskId === undefined ? isNull(evidence.recordSha256) : and(isNull(evidence.recordSha256), eq(evidence.taskId, taskId))).orderBy(asc(evidence.id));
  if (!open.length) return 0;
  const keys = new Map((await db.select({ id: tasks.id, key: tasks.key }).from(tasks).where(inArray(tasks.id, [...new Set(open.map((r) => r.taskId))]))).map((t) => [t.id, t.key]));
  const arts = await artifactHashes(db, open.map((r) => r.artifactId));
  const gates = new Map((await db.select({ id: gateResults.id, checkRunId: gateResults.checkRunId }).from(gateResults)).map((g) => [g.checkRunId, g.id]));
  const versions = new Map((await db.select({ taskId: contracts.taskId, sha256: contracts.sha256, version: contracts.version }).from(contracts)).map((c) => [`${c.taskId}|${c.sha256}`, c.version]));
  const tails = new Map<number, { seq: number; hash: string | null }>();
  for (const r of open) {
    const tail = tails.get(r.taskId) ?? (await chainTail(db, r.taskId));
    const l = linkage({ subject: r.subject, source: r.source, detail: r.detail, taskKey: keys.get(r.taskId) ?? null });
    const next: EvidenceRow = {
      ...r,
      kind: r.kind ?? l.kind, criterionTask: r.criterionTask ?? l.criterionTask, criterionId: r.criterionId ?? l.criterionId, collector: r.collector ?? l.collector, runId: r.runId ?? l.runId,
      gateResultId: r.gateResultId ?? (l.checkRun !== null ? (gates.get(l.checkRun) ?? null) : null), checkName: r.checkName ?? l.checkName,
      contractVersion: r.contractVersion ?? (r.contractSha256 ? (versions.get(`${r.taskId}|${r.contractSha256}`) ?? null) : null),
      seq: tail.seq + 1, prevSha256: tail.hash, sealed: "backfilled",
    };
    const recordSha256 = recordHash(tail.hash, sealedOf(next, r.artifactId === null ? null : (arts.get(r.artifactId) ?? null)));
    await db.update(evidence).set({ kind: next.kind, criterionTask: next.criterionTask, criterionId: next.criterionId, collector: next.collector, runId: next.runId, gateResultId: next.gateResultId, checkName: next.checkName, contractVersion: next.contractVersion, seq: next.seq, prevSha256: next.prevSha256, sealed: "backfilled", recordSha256 }).where(eq(evidence.id, r.id));
    tails.set(r.taskId, { seq: next.seq!, hash: recordSha256 });
  }
  return open.length;
}

/** Integrity audit of one task's evidence: the chain, and every referenced artifact body against its recorded hash. Read-only. */
export async function auditEvidence(db: Db, taskId: number) {
  const rows = await db.select().from(evidence).where(eq(evidence.taskId, taskId)).orderBy(asc(evidence.seq), asc(evidence.id));
  const ids = [...new Set(rows.map((r) => r.artifactId).filter((x): x is number => typeof x === "number"))];
  const arts = ids.length ? await db.select().from(artifacts).where(inArray(artifacts.id, ids)) : [];
  const byId = new Map(arts.map((a) => [a.id, a]));
  const chain = verifyChain(rows.map((r): ChainRow => ({ ...sealedOf(r, r.artifactId === null ? null : (byId.get(r.artifactId)?.sha256 ?? null)), id: r.id, prevSha256: r.prevSha256, recordSha256: r.recordSha256 })));
  const bad = arts.filter((a) => sha256(a.content) !== a.sha256).map((a) => a.id);
  const missing = ids.filter((i) => !byId.has(i));
  return { taskId, chain, artifacts: { checked: ids.length, bad, missing }, backfilled: rows.filter((r) => r.sealed === "backfilled").length, ok: chain.ok && bad.length === 0 && missing.length === 0 };
}

const evRow = (r: EvidenceRow): EvRow => ({ id: r.id, seq: r.seq, subject: r.subject, status: r.status, oracle: r.oracle, persistence: r.persistence, source: r.source, commitSha: r.commitSha, contractSha256: r.contractSha256, detail: r.detail, severity: r.severity, artifactId: r.artifactId, kind: r.kind, criterionTask: r.criterionTask, criterionId: r.criterionId, collector: r.collector, runId: r.runId, gateResultId: r.gateResultId, checkName: r.checkName, recordSha256: r.recordSha256 });

/**
 * Assemble and store the evidence package of a judged head. Deterministic: the same evidence gives the same bytes and hash, and an
 * identical package for the same head is not stored twice. `scope` may be forced (e.g. the plan task that has just been judged).
 */
export async function assemblePackage(db: Db, task: Task, o: { head: string; stage: string; scope?: { scope: EvidenceScope; planTask: string | null; inScope: string[] | null }; /** judge against the contract version with this hash (history replay); default: the task's current contract */ contractSha256?: string | null }): Promise<{ id: number; sha256: string; artifactId: number; pkg: EvidencePackage }> {
  await sealBacklog(db, task.id);
  const sc = await evidenceScope(db, task.id);
  const use = o.scope ?? sc;
  const [byHash] = o.contractSha256 ? await db.select().from(contracts).where(and(eq(contracts.taskId, task.id), eq(contracts.sha256, o.contractSha256))).orderBy(desc(contracts.id)).limit(1) : [];
  const [c] = byHash ? [byHash] : task.currentContractId ? await db.select().from(contracts).where(eq(contracts.id, task.currentContractId)) : [];
  const parsed = c ? Contract.safeParse(c.body) : null;
  const [g] = await db.select().from(gateResults).where(and(eq(gateResults.taskId, task.id), eq(gateResults.headSha, o.head))).orderBy(desc(gateResults.id)).limit(1);
  const rows = await db.select().from(evidence).where(eq(evidence.taskId, task.id)).orderBy(asc(evidence.seq), asc(evidence.id));
  const ids = [...new Set([...rows.map((r) => r.artifactId), g?.evidenceArtifactId ?? null].filter((x): x is number => typeof x === "number"))];
  const arts = ids.length ? await db.select().from(artifacts).where(inArray(artifacts.id, ids)) : [];
  const byId = new Map(arts.map((a) => [a.id, a]));
  const chain = verifyChain(rows.map((r): ChainRow => ({ ...sealedOf(r, r.artifactId === null ? null : (byId.get(r.artifactId)?.sha256 ?? null)), id: r.id, prevSha256: r.prevSha256, recordSha256: r.recordSha256 })));
  const pkg = buildPackage({
    task: { id: task.id, key: task.key ?? `task-${task.id}`, title: task.title, tier: task.tier },
    scope: use.scope, planTask: use.planTask, inScope: use.inScope, head: o.head, stage: o.stage,
    contract: c && parsed?.success ? { version: c.version, sha256: c.sha256, body: parsed.data } : null,
    plan: sc.plan,
    gate: g ? { id: g.id, checkRunId: g.checkRunId, verdict: g.verdict, kind: g.kind, headSha: g.headSha, contractSha256: g.contractSha256, evidenceArtifactId: g.evidenceArtifactId } : null,
    rows: rows.map(evRow),
    artifacts: Object.fromEntries(arts.map((a) => [a.id, { sha256: a.sha256, intact: sha256(a.content) === a.sha256, kind: a.kind, name: a.name }])),
    chain,
  });
  const [same] = await db.select().from(evidencePackages).where(and(eq(evidencePackages.taskId, task.id), eq(evidencePackages.headSha, o.head), eq(evidencePackages.sha256, pkg.sha256))).limit(1);
  if (same) return { id: same.id, sha256: same.sha256, artifactId: same.artifactId, pkg };
  const [a] = await db.insert(artifacts).values({ taskId: task.id, kind: "evidence-package", name: `evidence package (${use.planTask ?? use.scope}, ${o.head.slice(0, 8)}, ${o.stage})`, content: pkg.text, sha256: pkg.sha256, workerAuthored: false }).returning({ id: artifacts.id });
  const [row] = await db.insert(evidencePackages).values({ taskId: task.id, scope: use.scope, planTask: use.planTask, headSha: o.head, contractVersion: c?.version ?? null, contractSha256: c?.sha256 ?? null, status: pkg.status, summary: pkg.summary, artifactId: a!.id, sha256: pkg.sha256, stage: o.stage }).returning({ id: evidencePackages.id });
  return { id: row!.id, sha256: pkg.sha256, artifactId: a!.id, pkg };
}

/**
 * Replay over history (read-only apart from storing audit packages): for every recorded gate result, assemble the package of that
 * head and compare it with the verdict the gate gave at the time. A passing verdict must be carried by a complete package and a
 * non-passing one must not be: any disagreement is reported. The scope of a head is the one the gate itself recorded for it.
 */
export async function replayEvidence(db: Db, taskId?: number) {
  const gs = await db.select().from(gateResults).where(taskId ? eq(gateResults.taskId, taskId) : undefined).orderBy(asc(gateResults.id));
  const out: { task: string; gate: number; head: string; verdict: string; scope: string; status: string; agrees: boolean; why: string }[] = [];
  const latest = new Map<string, number>();
  for (const g of gs) latest.set(`${g.taskId}|${g.headSha}`, g.id);
  for (const g of gs) {
    if (latest.get(`${g.taskId}|${g.headSha}`) !== g.id) continue; // an earlier run of the same head was replaced by a later one
    const [t] = await db.select().from(tasks).where(eq(tasks.id, g.taskId));
    if (!t) continue;
    const [art] = g.evidenceArtifactId ? await db.select({ content: artifacts.content }).from(artifacts).where(eq(artifacts.id, g.evidenceArtifactId)) : [];
    let reported: string[] | null = null;
    try { const ps = (JSON.parse(art?.content ?? "{}") as { checks?: { plan_scope?: Record<string, string[] | null> } }).checks?.plan_scope; const v = ps && t.key ? ps[t.key] : null; reported = Array.isArray(v) ? v : null; } catch { reported = null; }
    const p = await assemblePackage(db, t, { head: g.headSha, stage: "audit", contractSha256: g.contractSha256, scope: reported ? { scope: "plan_task", planTask: null, inScope: reported } : { scope: "task", planTask: null, inScope: null } });
    const agrees = g.kind === "pass" ? p.pkg.status === "complete" : p.pkg.status !== "complete";
    out.push({ task: t.key ?? String(t.id), gate: g.id, head: g.headSha.slice(0, 8), verdict: g.verdict, scope: reported ? `plan task (${reported.join(",") || "none"})` : "whole contract", status: p.pkg.status, agrees, why: agrees ? "" : [...p.pkg.body.inconsistencies, ...p.pkg.body.gaps].join("; ").slice(0, 300) });
  }
  return { heads: out.length, agree: out.filter((x) => x.agrees).length, disagreements: out.filter((x) => !x.agrees), results: out.map((x) => `${x.task} ${x.head} ${x.verdict} -> ${x.status}${x.agrees ? "" : " (DISAGREES)"}`) };
}

/** The latest stored package of a head (what a downstream stage reads instead of querying evidence rows by text). */
export async function latestPackage(db: Db, taskId: number, head: string) {
  const [p] = await db.select().from(evidencePackages).where(and(eq(evidencePackages.taskId, taskId), eq(evidencePackages.headSha, head))).orderBy(desc(evidencePackages.id)).limit(1);
  return p;
}
