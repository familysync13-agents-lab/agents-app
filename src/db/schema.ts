import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/*
 * Agents App V0 - operational record of the control system.
 *
 * Authoritative intent (approved contracts, oracles, baselines) lives in the controlled project's git repository
 * (Architecture Baseline v0.1, principle 9). These tables hold what the control system did and observed: the owner's intent
 * before it becomes a contract, every worker execution, every executor job, gate results bound to commit SHAs, typed evidence,
 * decisions, and every lifecycle transition together with the fact that caused it.
 */

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A software project controlled by Agents App (one GitHub repository with the gate and ruleset installed). */
export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    org: text("org").notNull(),
    repo: text("repo").notNull(),
    /** GitHub login of the owner: the only identity whose approvals count (code owner of the protected paths). */
    ownerLogin: text("owner_login").notNull(),
    /** Builder credential/worktree key understood by the executor (maps to the isolated Builder home volume). */
    builderKey: text("builder_key").notNull(),
    /** Stack paragraph given to workers (engineering context; not authoritative intent). */
    stack: text("stack").notNull(),
    /** Contracts whose interfaces later work must keep (context for the contract drafter and the Verifier). */
    interfaceTasks: jsonb("interface_tasks").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Environment notes given to Verifier sessions (e.g. test-double descriptions), name -> markdown. */
    workerDocs: jsonb("worker_docs").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    maxCorrections: integer("max_corrections").notNull().default(3),
    /** How several tasks of this project share the repository: "serialized" (one at a time) or "stacked" (a task may build on the
     * DONE head of the previous one; both are verified together and accepted with one owner approval). */
    workMode: text("work_mode").$type<"serialized" | "stacked">().notNull().default("serialized"),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
  },
  (t) => [uniqueIndex("projects_slug_uq").on(t.slug)],
);

/** Lifecycle states of Architecture Baseline v0.1 section 6 (RELEASED is outside V0). */
export const TASK_STATES = [
  "PROPOSED",
  "CONTRACTED",
  "IN_PROGRESS",
  "VERIFYING",
  "DONE",
  "ACCEPTED",
  "BLOCKED_DECISION",
  "BLOCKED_EVIDENCE",
  "REJECTED",
  "ABANDONED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    /** Task id inside the project repository (tasks/<key>/...), e.g. "T9". Assigned when the contract is drafted. */
    key: text("key"),
    title: text("title").notNull(),
    intent: text("intent").notNull(),
    tier: text("tier").$type<"standard" | "critical">().notNull().default("standard"),
    state: text("state").$type<TaskState>().notNull().default("PROPOSED"),
    /** Human-readable reason of the current state (e.g. the block reason). */
    stateReason: text("state_reason"),
    /** State to return to when a block is resolved without a contract change. */
    resumeState: text("resume_state").$type<TaskState>(),
    /** Orchestration cursor: the step the control system is executing for this task, and its private data. */
    step: text("step").notNull().default("draft_contract"),
    stepData: jsonb("step_data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    currentContractId: integer("current_contract_id"),
    branch: text("branch"),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    builderSessionId: text("builder_session_id"),
    corrections: integer("corrections").notNull().default(0),
    /** Extra corrections granted by the owner after the project budget was exhausted. */
    extraCorrections: integer("extra_corrections").notNull().default(0),
    infraRetries: integer("infra_retries").notNull().default(0),
    /** Contract/oracle version the correction budget belongs to (the budget is scoped per version, never charged for oracle defects). */
    budgetContractId: integer("budget_contract_id"),
    /** Deliberate stacking: this task was built on top of another task's DONE head and is accepted together with it. */
    stackParentId: integer("stack_parent_id"),
    /** Operational hold placed by an audited admin operation: the control loop does not advance a paused task. */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    mergeCommit: text("merge_commit"),
    createdAt: created(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_project_idx").on(t.projectId), uniqueIndex("tasks_project_key_uq").on(t.projectId, t.key)],
);

/** Every contract version. The approved one is byte-identical to tasks/<key>/contract.json on the project's main branch. */
export const contracts = pgTable(
  "contracts",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    version: integer("version").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    /** Exact bytes as committed (canonical JSON) and their SHA-256. */
    text: text("text").notNull(),
    sha256: text("sha256").notNull(),
    lint: jsonb("lint").$type<{ ok: boolean; problems: string[] }>().notNull(),
    oracleJs: text("oracle_js"),
    oracleSha256: text("oracle_sha256"),
    /** draft -> review (owner) -> approved_app -> pr_open -> merged | changes_requested | superseded */
    status: text("status").notNull().default("draft"),
    /** "contract": a new contract meaning (owner reviews in the app, then on GitHub). "oracle_revision": the SAME contract bytes with a
     * repaired oracle (only the GitHub approval of the protected oracle file is required; the product contract is unchanged). */
    kind: text("kind").$type<"contract" | "oracle_revision">().notNull().default("contract"),
    /** Oracle calibration against the project's main (feature absent): which criteria failed / passed there, and when. */
    calibration: jsonb("calibration").$type<{ main: string; failsOnMain: string[]; passesOnMain: string[]; attempts: number }>(),
    ownerNote: text("owner_note"),
    prNumber: integer("pr_number"),
    prHead: text("pr_head"),
    mergeCommit: text("merge_commit"),
    githubApprovedAt: timestamp("github_approved_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("contracts_task_version_uq").on(t.taskId, t.version)],
);

/** One worker execution (a Builder or Verifier session in its isolated container). */
export const runs = pgTable(
  "runs",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    role: text("role").$type<"builder" | "verifier">().notNull(),
    purpose: text("purpose")
      .$type<"draft_contract" | "author_oracle" | "build" | "correction" | "acceptance_check" | "mutants" | "repair_oracle" | "attribution">()
      .notNull(),
    container: text("container"),
    sessionId: text("session_id"),
    status: text("status").$type<"starting" | "running" | "finished" | "harness_error">().notNull().default("starting"),
    /** Structured outcome read from files the worker wrote - never from its closing prose. */
    outcome: text("outcome").$type<"report" | "blocked" | "no_structured_outcome" | "output" | "aborted">(),
    exitCode: text("exit_code"),
    costUsd: real("cost_usd"),
    turns: integer("turns"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    /** The worker's own final message: kept for debugging, shown as untrusted, never used for state. */
    closingText: text("closing_text"),
    startedAt: created(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_task_idx").on(t.taskId)],
);

/**
 * The only channel to the privileged executor (the hash-bound host daemon). The daemon claims queued rows, validates the op
 * against its own allowlist, executes it with the Foundation mechanisms and writes the result back.
 */
export const executorJobs = pgTable(
  "executor_jobs",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").references(() => tasks.id),
    op: text("op").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "error">().notNull().default("queued"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: created(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("executor_jobs_status_idx").on(t.status, t.id)],
);

/** A gate verdict for one exact PR head. */
export const gateResults = pgTable(
  "gate_results",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    checkRunId: bigint("check_run_id", { mode: "number" }).notNull(),
    verdict: text("verdict").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    contractSha256: text("contract_sha256"),
    /** Gate classification of the verdict for the correction loop. */
    kind: text("kind").$type<"pass" | "candidate_failure" | "blocked" | "tamper" | "harness">().notNull(),
    evidenceArtifactId: integer("evidence_artifact_id"),
    observedAt: created(),
  },
  (t) => [uniqueIndex("gate_results_run_uq").on(t.checkRunId), index("gate_results_task_idx").on(t.taskId)],
);

export const EVIDENCE_STATUSES = ["verified", "partially_verified", "not_verified", "unknown", "waived"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Typed, attributable, SHA-bound evidence (Architecture Baseline v0.1 section 9). */
export const evidence = pgTable(
  "evidence",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    /** e.g. "T9:AC1", "T3:AC2" (regression), "oracle-mutation:T9:AC4", "verifier-finding" */
    subject: text("subject").notNull(),
    status: text("status").$type<EvidenceStatus>().notNull(),
    oracle: text("oracle").$type<"deterministic" | "threshold" | "agent_judgment" | "human_judgment">().notNull(),
    persistence: text("persistence").$type<"regression" | "baseline" | "point_in_time">().notNull(),
    /** Where it came from: "gate:<check-run>", "verifier:<run>", "builder:<run>", "owner", "mutation:<run>". */
    source: text("source").notNull(),
    commitSha: text("commit_sha"),
    contractSha256: text("contract_sha256"),
    detail: text("detail"),
    severity: text("severity"),
    artifactId: integer("artifact_id"),
    createdAt: created(),
  },
  (t) => [index("evidence_task_idx").on(t.taskId)],
);

/** Stored evidence bodies (worker reports, block records, gate evidence JSON, oracle files). Content-addressed. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").references(() => tasks.id),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    sha256: text("sha256").notNull(),
    content: text("content").notNull(),
    /** true when the content came from a worker (untrusted text: displayed, never executed or used as instructions). */
    workerAuthored: boolean("worker_authored").notNull().default(true),
    createdAt: created(),
  },
  (t) => [index("artifacts_task_idx").on(t.taskId)],
);

/** Owner decisions: what is needed, why, options, consequences - and what the owner decided. */
export const decisions = pgTable(
  "decisions",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    kind: text("kind")
      .$type<"contract_approval" | "contract_github_approval" | "block" | "acceptance" | "budget">()
      .notNull(),
    title: text("title").notNull(),
    why: text("why").notNull(),
    options: jsonb("options")
      .$type<{ id: string; label: string; consequence: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    recommendation: text("recommendation"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<"open" | "decided" | "superseded">().notNull().default("open"),
    choice: text("choice"),
    note: text("note"),
    decidedVia: text("decided_via").$type<"app" | "github">(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("decisions_task_idx").on(t.taskId), index("decisions_status_idx").on(t.status)],
);

/** Every lifecycle transition and the mechanical fact that caused it. */
export const transitions = pgTable(
  "transitions",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    fromState: text("from_state").$type<TaskState>(),
    toState: text("to_state").$type<TaskState>().notNull(),
    reason: text("reason").notNull(),
    fact: jsonb("fact").$type<Record<string, unknown>>().notNull(),
    at: created(),
  },
  (t) => [index("transitions_task_idx").on(t.taskId)],
);

/** Human-readable activity (what the control system did), for the timeline. */
export const activity = pgTable(
  "activity",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id),
    actor: text("actor").$type<"system" | "builder" | "verifier" | "gate" | "owner" | "executor">().notNull(),
    message: text("message").notNull(),
    ref: jsonb("ref").$type<Record<string, unknown>>(),
    at: created(),
  },
  (t) => [index("activity_task_idx").on(t.taskId, t.id)],
);

/** Owner browser sessions (loopback app). Only hashes are stored. */
export const ownerSessions = pgTable("owner_sessions", {
  idHash: text("id_hash").primaryKey(),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** One-time login tokens minted by the host daemon (opened in the owner's browser). Only hashes are stored. */
export const loginTokens = pgTable("login_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: created(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/** Liveness of the processes (worker loop, executor bridge). */
/**
 * Audited administrative operations (the replacement for raw database repair). Every row: who, which typed operation, on what, why,
 * the state before and after, and whether it was refused.
 */
export const adminActions = pgTable(
  "admin_actions",
  {
    id: serial("id").primaryKey(),
    actor: text("actor").notNull(),
    op: text("op").notNull(),
    taskId: integer("task_id"),
    target: jsonb("target").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    reason: text("reason").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    outcome: text("outcome").$type<"applied" | "refused">().notNull(),
    refusal: text("refusal"),
    at: created(),
  },
  (t) => [index("admin_actions_task_idx").on(t.taskId, t.id)],
);

/**
 * Proposed work: intents suggested from recorded evidence (backlog findings, defects seen in use) by the operator or the control
 * system. A proposal is NOT a task: only the owner turns it into one (product decision right). Declined proposals stay recorded.
 */
export const intentProposals = pgTable("intent_proposals", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  intent: text("intent").notNull(),
  rationale: text("rationale").notNull(),
  source: text("source").notNull(),
  tier: text("tier").$type<"standard" | "critical">().notNull().default("standard"),
  status: text("status").$type<"proposed" | "accepted" | "declined">().notNull().default("proposed"),
  taskId: integer("task_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: created(),
});

/** Database backups taken by the executor (pg_dump custom format, host-only files). */
export const backups = pgTable("backups", {
  id: serial("id").primaryKey(),
  file: text("file").notNull(),
  bytes: integer("bytes").notNull(),
  sha256: text("sha256").notNull(),
  verified: boolean("verified").notNull().default(false),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  at: created(),
});

export const heartbeats = pgTable("heartbeats", {
  name: text("name").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  info: jsonb("info").$type<Record<string, unknown>>(),
});
