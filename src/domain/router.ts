/*
 * Static Router (Builder phase). A deterministic, reviewable rule table: which worker runs which class of work, and why.
 * Quality rule: an alternative path is used ONLY for task classes it has qualified for with recorded evidence; otherwise the trusted
 * path runs and the alternative may at most receive the same bounded input in SHADOW mode (recorded and compared, controlling
 * nothing). There is no learned or AI router, no paid fallback, and private repository code never goes to a cloud model other than
 * the approved workers.
 */

export const TASK_CLASSES = [
  "contract_draft", // intent -> contract (reads the repository)
  "plan", // decompose a complex contract into a one-level task graph
  "build", // implement a contract or a plan task
  "correction", // repair after verification findings
  "mutants", // write realistic defects to test a check
  "check_author", // write / repair the black-box check of record (blind to code)
  "acceptance_check", // independent post-build verification
  "attribution", // who owns a failure: reproduce against a preview
  "failure_triage", // bounded text -> failure class, when deterministic classification has no answer
  "log_summary", // bounded text -> summary
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/*
 * Local-worker extension. These classes exist only as work a LOCAL model may qualify for; the trusted worker for all of them is
 * Claude Code. They are routed by the same rule as every other class (NO QUALIFIED LOCAL PATH = TRUSTED WORKER) but are not part of
 * the ten primary classes above (the System page's routing table lists exactly those).
 */
export const EXT_TASK_CLASSES = [
  "classification", // bounded text -> labels from a fixed vocabulary
  "summarization", // bounded record of events -> grounded summary
  "structured_extraction", // bounded text -> fixed fields
  "small_code", // a plan task confined to a few named files
  "bounded_repair", // repair of a failed check confined to a few named files
] as const;
export type ExtTaskClass = (typeof EXT_TASK_CLASSES)[number];
export type AnyTaskClass = TaskClass | ExtTaskClass;
export const ALL_TASK_CLASSES: readonly AnyTaskClass[] = [...TASK_CLASSES, ...EXT_TASK_CLASSES];
/** Bounded semantic classes a local general model may qualify for; coding classes a local coding model may qualify for. */
export const SEMANTIC_CLASSES = ["failure_triage", "log_summary", "classification", "summarization", "structured_extraction"] as const;
export type SemanticClass = (typeof SEMANTIC_CLASSES)[number];
export const CODE_CLASSES = ["small_code", "bounded_repair"] as const;
export type CodeClass = (typeof CODE_CLASSES)[number];
/** Installed on the host but embedding-only: never a worker, never selected for generative work (the executor refuses it too). */
export const EMBEDDING_ONLY_MODELS = ["bge-m3"];

export type Risk = "standard" | "critical";

/** What a worker may touch. The executor enforces these; the Router records which envelope a run had. */
export interface Envelope {
  filesystem: string;
  network: string;
  repository: string;
  tools: string;
  credentials: string;
}

export interface WorkerDef {
  id: string;
  harness: string;
  provider: string;
  model: string;
  /** may private repository code be given to this worker? */
  privateCode: boolean;
  /** does using it add usage-based cost? (a worker with true is never routable) */
  meteredCost: boolean;
  enabled: boolean;
  disabledReason?: string;
  envelope: Envelope;
  /** evaluation-candidate ids whose recorded evidence belongs to this worker (same model, recorded before it became a worker) */
  evidenceFrom?: string[];
}

export const WORKERS: Record<string, WorkerDef> = {
  "claude-code": {
    id: "claude-code",
    harness: "claude-code",
    provider: "anthropic-subscription",
    model: "opus",
    privateCode: true,
    meteredCost: false,
    enabled: true,
    envelope: {
      filesystem: "assigned worktree volume (read/write); own isolated home; nothing else",
      network: "Builder gateway allowlist only (vendor API, package registries, documentation hosts)",
      repository: "no GitHub access; changes leave only through the transport (protected paths refused)",
      tools: "Claude Code tools inside the container; dev database and test doubles as sidecars",
      credentials: "its own vendor login in an isolated volume; no other credential",
    },
  },
  "codex-verifier": {
    id: "codex-verifier",
    harness: "codex",
    provider: "openai-subscription",
    model: "default",
    privateCode: false,
    meteredCost: false,
    enabled: true,
    envelope: {
      filesystem: "only the job's input files; no repository, no Builder material",
      network: "Verifier gateway allowlist; optionally one preview network",
      repository: "none",
      tools: "Codex CLI inside the container; Playwright against the preview",
      credentials: "verifier-only vendor login in an isolated volume",
    },
  },
  // The general local model: bounded semantic work only (one structured request, no tools).
  "local-llm": {
    id: "local-llm",
    harness: "local-provider",
    provider: "ollama-host",
    model: "qwen3:14b",
    privateCode: true,
    meteredCost: false,
    enabled: true,
    envelope: {
      filesystem: "none",
      network: "none (the executor calls the model on the host loopback)",
      repository: "none",
      tools: "none: one bounded structured request, schema-validated output",
      credentials: "none",
    },
  },
  // The larger general local model (second Ollama server on the external SSD). Same envelope as local-llm. It was qualified as the
  // evaluation candidate "cand-qwen38"; that evidence counts for it. Routed only where the owner approved it (see ROUTES, PROMOTABLE).
  "local-qwen38": {
    id: "local-qwen38",
    harness: "local-provider",
    provider: "ollama-host",
    model: "qwen3.8:27b",
    privateCode: true,
    meteredCost: false,
    enabled: true,
    evidenceFrom: ["cand-qwen38"],
    envelope: {
      filesystem: "none",
      network: "none (the executor calls the model on the host loopback)",
      repository: "none",
      tools: "none: one bounded structured request, schema-validated output",
      credentials: "none",
    },
  },
  // The local coding model: small, file-scoped changes only. It has no agent harness: the executor reads the files in scope from
  // the controlled worktree, the model returns complete replacement files, the executor writes only in-scope paths and runs the
  // project's own checks. Everything after that is the normal path (transport, gate, independent Verifier).
  "local-coder": {
    id: "local-coder",
    harness: "local-provider",
    provider: "ollama-host",
    model: "qwen3-coder:30b",
    privateCode: true,
    meteredCost: false,
    enabled: true,
    envelope: {
      filesystem: "none for the model; the executor reads and writes only the files named in the task scope on the worktree volume",
      network: "none (the executor calls the model on the host loopback); the check container reaches the package registry only",
      repository: "no GitHub access; changes leave only through the transport (protected paths refused)",
      tools: "none: one bounded structured request returning complete files, schema-validated",
      credentials: "none",
    },
  },
  // Codex as a second CODING worker: not enabled. The only Codex login that exists is the Verifier's. Using it to build would make
  // Builder and Verifier the same identity (independence lost), and a second login is an owner credential action. No bake-off ran.
  "codex-builder": {
    id: "codex-builder",
    harness: "codex",
    provider: "openai-subscription",
    model: "default",
    privateCode: true,
    meteredCost: false,
    enabled: false,
    disabledReason: "no separate Builder login exists; reusing the Verifier's would break Builder/Verifier independence",
    envelope: { filesystem: "assigned worktree", network: "gateway allowlist", repository: "none (transport only)", tools: "Codex CLI", credentials: "its own vendor login" },
  },
  // OpenCode + local model as a coding harness: only if Codex cannot be used AND a local model first qualifies for small coding.
  "opencode-local": {
    id: "opencode-local",
    harness: "opencode",
    provider: "ollama-host",
    model: "configured-on-host",
    privateCode: true,
    meteredCost: false,
    enabled: false,
    disabledReason: "no local model has qualified for any coding class; not installed",
    envelope: { filesystem: "assigned worktree", network: "host loopback model only", repository: "none (transport only)", tools: "OpenCode", credentials: "none" },
  },
};

/*
 * EVALUATION CANDIDATES. Models under qualification that are NOT workers: they appear in no route, so the Router can never select
 * them. Their evidence is recorded and reported exactly like a worker's; adding one to a route is an owner decision.
 */
export const CANDIDATES: Record<string, { id: string; model: string; kind: "semantic" | "code"; note: string }> = {
  // the evidence id of the worker local-qwen38 (its records were made under this id); on its own it is still in no route
  "cand-qwen38": { id: "cand-qwen38", model: "qwen3.8:27b", kind: "semantic", note: "evaluation records of local-qwen38: semantic and research classes" },
  "cand-devstral": { id: "cand-devstral", model: "devstral-small-2:24b", kind: "code", note: "evaluation only: coding classes" },
};
/** The exact model a worker or an evaluation candidate runs. */
export const modelOf = (id: string): string | undefined => WORKERS[id]?.model ?? CANDIDATES[id]?.model;

/** The trusted path per class, and which alternatives may be considered for it (in order). */
export const ROUTES: Record<AnyTaskClass, { trusted: string; alternatives: string[] }> = {
  // owner decision 2026-10-03: qwen3.8:27b takes classification (20/20 on the pinned set); qwen3:14b stays qualified behind it
  classification: { trusted: "claude-code", alternatives: ["local-qwen38", "local-llm"] },
  summarization: { trusted: "claude-code", alternatives: ["local-llm"] },
  structured_extraction: { trusted: "claude-code", alternatives: ["local-llm"] },
  small_code: { trusted: "claude-code", alternatives: ["local-coder"] },
  bounded_repair: { trusted: "claude-code", alternatives: ["local-coder"] },
  contract_draft: { trusted: "claude-code", alternatives: [] },
  plan: { trusted: "claude-code", alternatives: [] },
  build: { trusted: "claude-code", alternatives: ["codex-builder", "opencode-local"] },
  correction: { trusted: "claude-code", alternatives: ["codex-builder", "opencode-local"] },
  mutants: { trusted: "claude-code", alternatives: [] },
  check_author: { trusted: "codex-verifier", alternatives: [] },
  acceptance_check: { trusted: "codex-verifier", alternatives: [] },
  attribution: { trusted: "codex-verifier", alternatives: [] },
  failure_triage: { trusted: "codex-verifier", alternatives: ["local-llm"] },
  log_summary: { trusted: "claude-code", alternatives: ["local-llm"] },
};

/** Initial calibration values for qualification (to be revised from data). */
export const QUALIFY = { minSamples: 20, minAgreement: 0.95, rejectBelow: 0.8 };

/*
 * PROMOTION BY HOLDOUT (owner decision 2026-10-03). A worker listed here is NOT an alternative of the class: it is routed only
 * after a fresh holdout of at least HOLDOUT.size previously unseen cases reached QUALIFY.minAgreement AND a promotion decision was
 * recorded in the qualification records (mode "promoted"). A recorded rejection (mode "promotion_rejected") is final for that
 * model. Until then the trusted path runs and nothing is sent to the worker by the Router.
 */
export const HOLDOUT = { size: 50 };
export const PROMOTABLE: Partial<Record<AnyTaskClass, string[]>> = { structured_extraction: ["local-qwen38"], failure_triage: ["local-qwen38"] };
export type PromotionStatus = { status: "holdout_pending" | "awaiting_decision" | "promoted" | "rejected"; samples: number; agree: number; agreement: number | null };
/** Promotion status of one worker for one class, from the holdout samples and the recorded decision only. */
export function promotion(records: QualRecord[], worker: string, taskClass: string): PromotionStatus {
  const model = modelOf(worker);
  const mine = records.filter((r) => r.worker === worker && r.taskClass === taskClass && !r.voided && (r.model == null || r.model === model));
  const hs = mine.filter((r) => r.mode === "holdout" && r.agree !== null);
  const agree = hs.filter((r) => r.agree === true && r.valid === true).length;
  const base = { samples: hs.length, agree, agreement: hs.length ? agree / hs.length : null };
  if (mine.some((r) => r.mode === "promotion_rejected")) return { status: "rejected", ...base };
  const enough = hs.length >= HOLDOUT.size && agree / hs.length >= QUALIFY.minAgreement;
  if (mine.some((r) => r.mode === "promoted") && enough) return { status: "promoted", ...base };
  return { status: hs.length >= HOLDOUT.size ? "awaiting_decision" : "holdout_pending", ...base };
}

export interface QualRecord {
  worker: string;
  taskClass: string;
  valid: boolean | null;
  agree: boolean | null;
  /** the exact model that produced the record; evidence counts only for the model the worker runs now */
  model?: string | null;
  /** a record kept for audit but excluded from qualification (e.g. produced by a model that cannot generate) */
  voided?: boolean | null;
  mode?: string | null;
}
export type QualStatus = { status: "unqualified" | "shadow" | "qualified" | "rejected"; samples: number; agreement: number | null };

/** Qualification of one worker for one task class, from recorded evidence only (never from reputation). */
export function qualification(records: QualRecord[], worker: string, taskClass: string): QualStatus {
  const model = modelOf(worker);
  const ids = [worker, ...(WORKERS[worker]?.evidenceFrom ?? [])];
  // production runs, holdout samples and promotion decisions are not qualification samples
  const rs = records.filter((r) => ids.includes(r.worker) && r.taskClass === taskClass && r.agree !== null && !r.voided && !["production", "holdout", "promoted", "promotion_rejected"].includes(r.mode ?? "") && (r.model == null || r.model === model));
  if (rs.length === 0) return { status: "unqualified", samples: 0, agreement: null };
  const agreement = rs.filter((r) => r.agree === true && r.valid === true).length / rs.length;
  if (rs.length < QUALIFY.minSamples) return { status: "shadow", samples: rs.length, agreement };
  if (agreement >= QUALIFY.minAgreement) return { status: "qualified", samples: rs.length, agreement };
  if (agreement < QUALIFY.rejectBelow) return { status: "rejected", samples: rs.length, agreement };
  return { status: "shadow", samples: rs.length, agreement };
}

export interface RouteInput {
  taskClass: AnyTaskClass;
  risk: Risk;
  records: QualRecord[];
  /** workers that can run right now (e.g. the local model answers) */
  available?: string[];
  /** workers paused for quota: a qualified alternative may take over; an unqualified one may not */
  unavailable?: string[];
}
export interface RouteDecision {
  worker: string;
  harness: string;
  provider: string;
  model: string;
  reason: string;
  envelope: Envelope;
  /** candidates that receive the same bounded input in shadow mode (recorded, compared, never used) */
  shadow: string[];
  /** true when the chosen worker cannot run now: the job must PAUSE, never fail and never fall to an unqualified path */
  mustWait: boolean;
}

export function route(i: RouteInput): RouteDecision {
  const r = ROUTES[i.taskClass];
  const shadow: string[] = [];
  const usable = (id: string) => WORKERS[id]!.enabled && !WORKERS[id]!.meteredCost && (!i.available || i.available.includes(id) || id === r.trusted) && !(i.unavailable ?? []).includes(id);
  let pick: { id: string; reason: string } | null = null;
  // a worker promoted by holdout takes the class (standard tier only); before promotion it receives nothing
  for (const w of PROMOTABLE[i.taskClass] ?? []) {
    const p = promotion(i.records, w, i.taskClass);
    if (!pick && p.status === "promoted" && WORKERS[w]!.enabled && i.risk !== "critical" && usable(w)) pick = { id: w, reason: `promoted for ${i.taskClass} by holdout: ${p.agree} of ${p.samples} unseen cases agreed (${Math.round((p.agreement ?? 0) * 100)}%)` };
  }
  for (const alt of r.alternatives) {
    const w = WORKERS[alt]!;
    if (!w.enabled) continue;
    const q = qualification(i.records, alt, i.taskClass);
    if (q.status === "qualified" && i.risk !== "critical" && usable(alt)) {
      if (!pick) pick = { id: alt, reason: `qualified for ${i.taskClass}: ${q.samples} samples, ${Math.round((q.agreement ?? 0) * 100)}% agreement` };
    } else if (q.status !== "rejected" && usable(alt)) shadow.push(alt);
  }
  if (!pick) {
    const why = r.alternatives.length === 0 ? "no alternative is defined for this class" : i.risk === "critical" ? "critical tier always uses the trusted worker" : "no alternative has qualified for this class";
    pick = { id: r.trusted, reason: `trusted worker (${why})` };
  }
  const w = WORKERS[pick.id]!;
  return { worker: w.id, harness: w.harness, provider: w.provider, model: w.model, reason: pick.reason, envelope: w.envelope, shadow, mustWait: (i.unavailable ?? []).includes(pick.id) };
}

/** Deterministic failure classification of a worker's closing text / executor error. "unknown" = needs semantic triage. */
export type FailureClass = "quota" | "credential" | "access" | "infrastructure" | "check_defect" | "timeout" | "unknown";
export function classifyFailure(text: string, now: number = Date.now()): { cls: FailureClass; resetAt?: number } {
  const t = String(text ?? "");
  if (/usage limit|limit reached|limit will reset|out of (extra )?usage|rate.?limit(ed)?|quota (exceeded|exhausted)|\b429\b|overloaded_error/i.test(t)) {
    const m = /\|(\d{10})\b/.exec(t) ?? /resets? at (\d{10})\b/i.exec(t);
    if (m) return { cls: "quota", resetAt: Number(m[1]) * 1000 };
    // "try again at 6:06 AM" (Codex): a time of day, read as UTC (the worker container's clock); the next occurrence
    const c = /try again at (\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(t);
    if (c) {
      const d = new Date(now);
      d.setUTCHours((Number(c[1]) % 12) + (String(c[3]).toUpperCase() === "PM" ? 12 : 0), Number(c[2]), 0, 0);
      if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
      return { cls: "quota", resetAt: d.getTime() };
    }
    return { cls: "quota" };
  }
  if (/Failed to authenticate|OAuth session expired|Invalid API key|Please run \/login|401 Unauthorized/i.test(t)) return { cls: "credential" };
  if (/ACCESS:|installation does not include|Resource not accessible by integration/i.test(t)) return { cls: "access" };
  if (/HARNESS:|ReferenceError|strict mode violation|oracle exit \d+/.test(t)) return { cls: "check_defect" };
  if (/timed out|timeout|exceeded \d+ minutes/i.test(t)) return { cls: "timeout" };
  if (/docker|connection refused|ECONNRESET|no space left|network is unreachable|daemon/i.test(t)) return { cls: "infrastructure" };
  return { cls: "unknown" };
}
