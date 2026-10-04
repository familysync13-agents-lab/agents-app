import "server-only";
import { and, desc, eq, gt, inArray, like, notInArray, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import {
  activity,
  adminActions,
  artifacts,
  backups,
  contracts,
  decisions,
  evidence,
  evidencePackages,
  executorJobs,
  gateResults,
  heartbeats,
  intentProposals,
  projects,
  qualificationRecords,
  runs,
  tasks,
  transitions,
  type TaskState,
} from "@/db/schema";
import { qualification, route, ROUTES, TASK_CLASSES, WORKERS, type QualRecord } from "@/domain/router";
import type { RoutingRow } from "@/components/routing-table";
import { residualGroups, withoutProofStatement } from "@/domain/decision";

const TERMINAL: TaskState[] = ["ACCEPTED", "REJECTED", "ABANDONED"];

/* Read models for the UI. Everything shown is read from the operational record - nothing is simulated. */

export async function systemStatus() {
  const db = await getDb();
  const hb = await db.select().from(heartbeats);
  const now = Date.now();
  const age = (name: string) => {
    const h = hb.find((x) => x.name === name);
    return h ? Math.round((now - h.at.getTime()) / 1000) : null;
  };
  const exec = hb.find((x) => x.name === "executor")?.info ?? {};
  const [lastBackup] = await db.select().from(backups).orderBy(desc(backups.id)).limit(1);
  return {
    worker: age("worker"),
    executor: age("executor"),
    kitRoot: typeof exec.kit_root === "string" ? exec.kit_root : null,
    operatorQueue: typeof exec.operator_queue === "number" ? exec.operator_queue : null,
    build: process.env.APP_BUILD_ID ?? "dev",
    lastBackup: lastBackup ? { at: lastBackup.at, verified: lastBackup.verified, file: lastBackup.file, bytes: lastBackup.bytes } : null,
  };
}

/** Everything the command view shows, in one read of the operational record. */
export async function commandCenter() {
  const db = await getDb();
  const ps = await db.select().from(projects).where(eq(projects.active, true)).orderBy(projects.name);
  const all = await db.select().from(tasks).orderBy(desc(tasks.updatedAt));
  const live = all.filter((t) => !TERMINAL.includes(t.state));
  const ids = live.map((t) => t.id);
  const running = await db.select().from(runs).where(inArray(runs.status, ["starting", "running"]));
  const openDecisions = await db
    .select({ d: decisions, t: tasks, p: projects })
    .from(decisions)
    .innerJoin(tasks, eq(tasks.id, decisions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(decisions.status, "open"))
    .orderBy(desc(decisions.createdAt));
  const events = await db
    .select({ a: activity, key: tasks.key, title: tasks.title, taskId: tasks.id })
    .from(activity)
    .innerJoin(tasks, eq(tasks.id, activity.taskId))
    .orderBy(desc(activity.id))
    .limit(40);
  const since = new Date(Date.now() - 90_000);
  const recentTransitions = await db.select().from(transitions).where(gt(transitions.at, since)).orderBy(desc(transitions.id)).limit(20);
  const gates = ids.length ? await db.select().from(gateResults).where(inArray(gateResults.taskId, ids)).orderBy(desc(gateResults.id)) : [];
  const attributions = ids.length
    ? await db
        .select({ taskId: evidence.taskId, detail: evidence.detail, commitSha: evidence.commitSha, id: evidence.id })
        .from(evidence)
        .where(and(inArray(evidence.taskId, ids), or(eq(evidence.kind, "attribution"), like(evidence.subject, "attribution:%"))))
        .orderBy(desc(evidence.id))
    : [];
  const accepted = all.filter((t) => t.state === "ACCEPTED").slice(0, 8);
  const proposals = await db
    .select({ p: intentProposals, project: projects.name })
    .from(intentProposals)
    .innerJoin(projects, eq(projects.id, intentProposals.projectId))
    .where(eq(intentProposals.status, "proposed"))
    .orderBy(intentProposals.id);
  return { projects: ps, tasks: all, live, running, openDecisions, events, recentTransitions, gates, attributions, accepted, proposals, system: await systemStatus() };
}

export async function systemPage() {
  const db = await getDb();
  const hb = await db.select().from(heartbeats);
  const bk = await db.select().from(backups).orderBy(desc(backups.id)).limit(20);
  const audit = await db
    .select({ a: adminActions, key: tasks.key, title: tasks.title })
    .from(adminActions)
    .leftJoin(tasks, eq(tasks.id, adminActions.taskId))
    .orderBy(desc(adminActions.id))
    .limit(50);
  const jobs = await db
    .select({ status: executorJobs.status, n: sql<number>`count(*)::int` })
    .from(executorJobs)
    .groupBy(executorJobs.status);
  const recentErrors = await db.select().from(executorJobs).where(eq(executorJobs.status, "error")).orderBy(desc(executorJobs.id)).limit(10);
  const capabilities = await db
    .select({ id: projects.id, name: projects.name, capabilityProfile: projects.capabilityProfile })
    .from(projects)
    .where(eq(projects.active, true))
    .orderBy(projects.name);
  const workerRuns = await recentWorkerRuns(db);
  const routing = await routingTable(db);
  return { heartbeats: hb, backups: bk, audit, jobs, recentErrors, capabilities, workerRuns, routing, system: await systemStatus() };
}

/** The 20 most recently started worker runs (newest first) with their task key - the System page's execution ledger. Read-only. */
export async function recentWorkerRuns(db?: Db) {
  const d = db ?? (await getDb());
  return d
    .select({
      id: runs.id,
      taskId: runs.taskId,
      key: tasks.key,
      purpose: runs.purpose,
      worker: runs.worker,
      taskClass: runs.taskClass,
      routeReason: runs.routeReason,
      contextBytes: runs.contextBytes,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(20);
}

/**
 * The Router's decision per task class for a standard-tier task with all enabled workers available, from the recorded qualification
 * records only (the Router itself is not changed), with each alternative's status and sample count - the System page's routing card.
 */
export async function routingTable(db?: Db): Promise<RoutingRow[]> {
  const d = db ?? (await getDb());
  const records: QualRecord[] = await d
    .select({ worker: qualificationRecords.worker, taskClass: qualificationRecords.taskClass, valid: qualificationRecords.valid, agree: qualificationRecords.agree, model: qualificationRecords.model, voided: qualificationRecords.voided, mode: qualificationRecords.mode })
    .from(qualificationRecords);
  return TASK_CLASSES.map((taskClass) => {
    const decision = route({ taskClass, risk: "standard", records });
    return {
      taskClass,
      worker: decision.worker,
      reason: decision.reason,
      alternatives: ROUTES[taskClass].alternatives.map((worker) => {
        const q = qualification(records, worker, taskClass);
        return { worker, status: WORKERS[worker]?.enabled ? q.status : ("disabled" as const), samples: q.samples };
      }),
    };
  });
}

export async function overview() {
  const db = await getDb();
  const ps = await db.select().from(projects).where(eq(projects.active, true)).orderBy(projects.name);
  const ts = await db.select().from(tasks).orderBy(desc(tasks.updatedAt));
  const open = await db
    .select({ d: decisions, t: tasks })
    .from(decisions)
    .innerJoin(tasks, eq(tasks.id, decisions.taskId))
    .where(eq(decisions.status, "open"))
    .orderBy(desc(decisions.createdAt));
  return { projects: ps, tasks: ts, decisions: open };
}

export async function projectBySlug(slug: string) {
  const db = await getDb();
  const [p] = await db.select().from(projects).where(eq(projects.slug, slug));
  if (!p) return null;
  const ts = await db.select().from(tasks).where(eq(tasks.projectId, p.id)).orderBy(desc(tasks.updatedAt));
  return { project: p, tasks: ts };
}

export async function taskDetail(id: number) {
  const db = await getDb();
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!t) return null;
  const [p] = await db.select().from(projects).where(eq(projects.id, t.projectId));
  const cs = await db.select().from(contracts).where(eq(contracts.taskId, id)).orderBy(desc(contracts.version));
  const rs = await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(desc(runs.id));
  const gs = await db.select().from(gateResults).where(eq(gateResults.taskId, id)).orderBy(desc(gateResults.id));
  const ev = await db.select().from(evidence).where(eq(evidence.taskId, id)).orderBy(desc(evidence.id));
  const ds = await db.select().from(decisions).where(eq(decisions.taskId, id)).orderBy(desc(decisions.id));
  const tr = await db.select().from(transitions).where(eq(transitions.taskId, id)).orderBy(transitions.id);
  const ac = await db.select().from(activity).where(eq(activity.taskId, id)).orderBy(desc(activity.id)).limit(200);
  const arts = await db
    .select({ id: artifacts.id, kind: artifacts.kind, name: artifacts.name, sha256: artifacts.sha256, createdAt: artifacts.createdAt, workerAuthored: artifacts.workerAuthored, size: sql<number>`length(${artifacts.content})` })
    .from(artifacts)
    .where(eq(artifacts.taskId, id))
    .orderBy(desc(artifacts.id));
  return { task: t, project: p!, contracts: cs, runs: rs, gates: gs, evidence: ev, decisions: ds, transitions: tr, activity: ac, artifacts: arts };
}

/**
 * The evidence package of the task's current head: the most recently stored package for (task, headSha), ordered by highest id exactly
 * as the control loop's latestPackage reads it. Null when the task has no head or no package is stored for its current head (a package
 * of an earlier head is never returned). Read-only: never assembles, stores or re-hashes a package.
 */
export async function currentEvidencePackage(taskId: number, db?: Db) {
  const d = db ?? (await getDb());
  const [t] = await d.select({ headSha: tasks.headSha }).from(tasks).where(eq(tasks.id, taskId));
  if (!t?.headSha) return null;
  const [p] = await d
    .select()
    .from(evidencePackages)
    .where(and(eq(evidencePackages.taskId, taskId), eq(evidencePackages.headSha, t.headSha)))
    .orderBy(desc(evidencePackages.id))
    .limit(1);
  return p ?? null;
}

export async function artifactBody(taskId: number, artifactId: number) {
  const db = await getDb();
  const [a] = await db.select().from(artifacts).where(and(eq(artifacts.id, artifactId), eq(artifacts.taskId, taskId)));
  return a ?? null;
}

export async function openDecisionsList() {
  const db = await getDb();
  return db
    .select({ d: decisions, t: tasks, p: projects })
    .from(decisions)
    .innerJoin(tasks, eq(tasks.id, decisions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(decisions.status, "open"))
    .orderBy(desc(decisions.createdAt));
}

type DecisionRow = { d: { id: number; taskId: number; kind: string; context: unknown } };

/**
 * The recorded decision record of each open acceptance decision, as its "accepted without proof" statement (decision id -> text).
 * Read from the decision-record artifact the decision's context references (same task, kind "decision-record"); a decision without
 * one (e.g. opened before decision records existed) is absent. Read-only.
 */
export async function acceptanceProofStatements(rows: DecisionRow[], db?: Db) {
  const out = new Map<number, string>();
  for (const [decisionId, content] of await recordedDecisionRecords(rows, db)) {
    const s = withoutProofStatement(content);
    if (s) out.set(decisionId, s);
  }
  return out;
}

/**
 * The residual lines listed in each acceptance decision's context, grouped by the kind of the matching item in its recorded
 * decision record (decision id -> groups; task page). A decision without a record, or whose lines cannot be matched to it, is
 * absent. Read-only.
 */
export async function acceptanceResidualGroups(rows: DecisionRow[], db?: Db) {
  const out = new Map<number, { review: string[]; noted: string[] }>();
  const records = await recordedDecisionRecords(rows, db);
  for (const { d } of rows) {
    const content = records.get(d.id);
    const lines = (d.context as { decisionRecord?: { residual?: unknown } } | null)?.decisionRecord?.residual;
    if (content === undefined || !Array.isArray(lines) || !lines.every((x) => typeof x === "string")) continue;
    const g = residualGroups(lines, content);
    if (g) out.set(d.id, g);
  }
  return out;
}

/** The stored decision-record artifact text of each acceptance decision (decision id -> content), as referenced by its context. */
async function recordedDecisionRecords(rows: DecisionRow[], db?: Db) {
  const refs = new Map<number, { taskId: number; artifactId: number }>();
  for (const { d } of rows) {
    if (d.kind !== "acceptance") continue;
    const id = (d.context as { decisionRecord?: { artifactId?: unknown } } | null)?.decisionRecord?.artifactId;
    if (typeof id === "number" && Number.isInteger(id)) refs.set(d.id, { taskId: d.taskId, artifactId: id });
  }
  const out = new Map<number, string>();
  if (!refs.size) return out;
  const dd = db ?? (await getDb());
  const arts = await dd
    .select({ id: artifacts.id, taskId: artifacts.taskId, content: artifacts.content })
    .from(artifacts)
    .where(and(inArray(artifacts.id, [...new Set([...refs.values()].map((r) => r.artifactId))]), eq(artifacts.kind, "decision-record")));
  const byId = new Map(arts.map((a) => [a.id, a]));
  for (const [decisionId, ref] of refs) {
    const a = byId.get(ref.artifactId);
    if (a && a.taskId === ref.taskId) out.set(decisionId, a.content);
  }
  return out;
}

export async function activeRunsByTask(taskIds: number[]) {
  if (taskIds.length === 0) return [];
  const db = await getDb();
  return db.select().from(runs).where(and(inArray(runs.taskId, taskIds), inArray(runs.status, ["starting", "running"])));
}


/** Read-only state for the future Agent Operations Interface: authoritative facts only. */
export async function stateSnapshot() {
  const db = await getDb();
  const live = await db.select().from(tasks).where(notInArray(tasks.state, TERMINAL)).orderBy(tasks.id);
  const ids = live.map((t) => t.id);
  const rs = await activeRunsByTask(ids);
  const ds = ids.length ? await db.select().from(decisions).where(and(inArray(decisions.taskId, ids), eq(decisions.status, "open"))) : [];
  const gs = ids.length ? await db.select().from(gateResults).where(inArray(gateResults.taskId, ids)).orderBy(desc(gateResults.id)) : [];
  return {
    at: new Date().toISOString(),
    system: await systemStatus(),
    tasks: live.map((t) => ({
      id: t.id,
      key: t.key,
      title: t.title,
      state: t.state,
      step: t.step,
      pr: t.prNumber,
      head: t.headSha,
      corrections: t.corrections,
      activeRuns: rs.filter((r) => r.taskId === t.id).map((r) => ({ role: r.role, purpose: r.purpose, since: r.startedAt })),
      latestGate: gs.find((g) => g.taskId === t.id) ?? null,
      ownerActionRequired: ds.filter((d) => d.taskId === t.id).map((d) => ({ kind: d.kind, title: d.title })),
    })),
  };
}
