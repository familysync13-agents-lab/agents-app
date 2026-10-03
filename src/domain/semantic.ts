/*
 * Bounded semantic work for a local general model (local-worker extension).
 * Every class is a small contract: a fixed instruction, a JSON schema, a bounded input and a DETERMINISTIC gate. The gate has two
 * parts: structural (schema, vocabulary, grounding: nothing the output states may be absent from the input) - applied to every
 * output, in production too - and, in qualification, agreement with the pinned reference of the case. Free-text classes
 * additionally go to the independent Verifier when the gate passes. The model gets no tools, no files and no network.
 */
import type { SemanticClass } from "./router";

export const FAILURE_CLASSES = ["quota", "credential", "access", "infrastructure", "check_defect", "timeout", "implementation", "owner_decision"] as const;
export const COMPONENTS = ["builder", "verifier", "gate", "executor", "github", "docker", "model_vendor", "app", "unknown"] as const;
export const TASK_STATES = ["PROPOSED", "CONTRACTED", "IN_PROGRESS", "VERIFYING", "DONE", "ACCEPTED", "BLOCKED_DECISION", "BLOCKED_EVIDENCE", "ABANDONED", "REJECTED"] as const;
export const ERROR_KINDS = ["timeout", "assertion", "http_status", "harness", "other"] as const;
export const SENSITIVE = ["authz", "data-loss", "money", "pii"] as const;

type Json = Record<string, unknown>;
export interface SemanticSpec {
  system: string;
  schema: Json;
  /** largest input the class accepts (characters); longer inputs are cut from the front (the end of a log matters most) */
  maxInput: number;
  maxTokens: number;
  /** free text that only an independent reader can judge: the Verifier sees gate-passing outputs */
  verifier: boolean;
  /** structural problems of an output for an input (empty = passes) */
  structural: (input: string, out: Json) => string[];
  /** disagreement with a case's pinned reference (empty = agrees) */
  agree: (out: Json, expect: Json) => string[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (o: Json, props: Json, required: string[]): Json => ({ type: "object", properties: props, required, ...o });
const en = (vs: readonly string[]) => ({ type: "string", enum: [...vs] });

/** Identifier-like tokens (task keys, criteria, PR numbers, commit prefixes, long numbers): a summary may only use ones its input contains. */
export function ungrounded(input: string, text: string): string[] {
  const hay = input.toLowerCase();
  const toks = text.match(/\bT\d+(?::AC\d+|\.[a-z])?\b|#\d+\b|\b[0-9a-f]{7,40}\b|\b\d{3,}\b/gi) ?? [];
  return [...new Set(toks)].filter((t) => !hay.includes(t.toLowerCase()) && !/^[a-f]+$/i.test(t));
}
/** Verbatim modulo JSON escaping, quote style and whitespace (a quote copied out of an escaped log line is still a quote). */
const plain = (s: string) => norm(s.replace(/\\n/g, " ").replace(/\\/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")).toLowerCase();
const verbatim = (input: string, quote: string) => plain(input).includes(plain(quote));

export const SEMANTIC: Record<SemanticClass, SemanticSpec> = {
  failure_triage: {
    system: `You classify why a step of an automated software-delivery system failed, from its error text. Answer with JSON only: {"class": "...", "evidence": "..."}.
class is exactly one of:
- "quota": a vendor usage or rate limit was reached; the work can continue later unchanged.
- "credential": a login, token or session of a worker is missing, expired or invalid.
- "access": a permission is missing (an app installation or repository access was not granted).
- "infrastructure": the machinery failed (containers, networks, disk, volumes, the executor's own code, GitHub answering with a rule or server error, a session that died); the work itself is not at fault.
- "check_defect": the automated check itself is broken (the check script crashed, used an undefined name, matched several elements, or was never written).
- "timeout": a step exceeded its time limit without another stated cause.
- "implementation": the product under test behaves wrongly, or its own build, types, lint or tests fail.
- "owner_decision": the worker stopped because a product, scope or contract question must be answered by the owner.
evidence is the shortest phrase copied VERBATIM from the text that justifies the class (at most 200 characters). Do not explain.`,
    schema: obj({}, { class: en(FAILURE_CLASSES), evidence: { type: "string" } }, ["class", "evidence"]),
    maxInput: 4000,
    maxTokens: 200,
    verifier: false,
    structural: (input, o) => {
      const p: string[] = [];
      if (!(FAILURE_CLASSES as readonly string[]).includes(str(o.class))) p.push("class is not in the vocabulary");
      const ev = str(o.evidence);
      if (!ev.trim() || ev.length > 240) p.push("evidence missing or longer than 240 characters");
      else if (!verbatim(input, ev)) p.push("evidence is not a verbatim quote of the input");
      return p;
    },
    agree: (o, e) => (str(o.class) === str(e.class) ? [] : [`class ${str(o.class)} differs from the reference ${str(e.class)}`]),
  },
  classification: {
    system: `You classify one acceptance criterion of a software contract by the sensitive areas it touches. Answer with JSON only: {"tags": [...]}.
tags lists every sensitive area the criterion itself is about, from this vocabulary only:
- "authz": who is allowed to see or do something - a request is refused or hidden because of who is (or is not) signed in, a role, a permission, or ownership of the data.
- "data-loss": stored data is deleted, overwritten or otherwise irreversibly changed.
- "money": payments, prices, charges, totals, balances, invoices.
- "pii": personal data of people is collected, stored, shown or exported: names with contact details, e-mail addresses, phone numbers, postal addresses, identity documents, health data.
Use [] when none applies. A criterion that only says "the owner is signed in" as the starting situation of a test, and is not about refusing or allowing access, is NOT "authz". Do not explain.`,
    schema: obj({}, { tags: { type: "array", items: en(SENSITIVE) } }, ["tags"]),
    maxInput: 3000,
    maxTokens: 80,
    verifier: false,
    structural: (_input, o) => (!Array.isArray(o.tags) || o.tags.some((t) => !(SENSITIVE as readonly string[]).includes(String(t))) ? ["tags are not from the vocabulary"] : []),
    agree: (o, e) => {
      const a = [...new Set((Array.isArray(o.tags) ? o.tags : []).map(String))].sort().join(",");
      const b = [...new Set((Array.isArray(e.tags) ? e.tags : []).map(String))].sort().join(",");
      return a === b ? [] : [`tags [${a}] differ from the reference [${b}]`];
    },
  },
  structured_extraction: {
    system: `You extract fields from one finding of an automated browser check. Answer with JSON only:
{"task": "...", "criterion": "...", "error_kind": "...", "timeout_ms": <integer or null>, "target_role": <string or null>, "target_name": <string or null>}
- task and criterion: the finding names a criterion as "<task>:<criterion>", e.g. "T4:AC1" -> task "T4", criterion "AC1".
- error_kind is exactly one of: "timeout" (a wait exceeded its time), "assertion" (an expected value differed from the actual value), "http_status" (an unexpected HTTP status code), "harness" (the check or its environment could not run: HARNESS, unreachable preview, a crashed or undefined check), "other".
- timeout_ms: the timeout in milliseconds when one is stated, otherwise null.
- target_role and target_name: when the finding contains getByRole('<role>', { name: '<name>' ... }), the role and the name of the FIRST such expression in the finding, exactly as written; otherwise null (a name that only appears in prose is not a target).
Copy values exactly. Do not explain.`,
    schema: obj({}, { task: { type: "string" }, criterion: { type: "string" }, error_kind: en(ERROR_KINDS), timeout_ms: { type: ["integer", "null"] }, target_role: { type: ["string", "null"] }, target_name: { type: ["string", "null"] } }, ["task", "criterion", "error_kind", "timeout_ms", "target_role", "target_name"]),
    maxInput: 3000,
    maxTokens: 200,
    verifier: false,
    structural: (input, o) => {
      const p: string[] = [];
      if (!/^T\d+$/.test(str(o.task)) || !/^[A-Z]+\d+$/.test(str(o.criterion))) p.push("task/criterion are not identifiers");
      else if (!input.includes(`${str(o.task)}:${str(o.criterion)}`)) p.push("task:criterion does not occur in the input");
      if (!(ERROR_KINDS as readonly string[]).includes(str(o.error_kind))) p.push("error_kind is not in the vocabulary");
      if (o.timeout_ms !== null && !(Number.isInteger(o.timeout_ms) && new RegExp(`(^|\\D)${String(o.timeout_ms)}(\\D|$)`).test(input))) p.push("timeout_ms is not an integer stated in the input");
      for (const k of ["target_role", "target_name"] as const) if (o[k] !== null && (typeof o[k] !== "string" || !input.includes(str(o[k])))) p.push(`${k} does not occur in the input`);
      return p;
    },
    agree: (o, e) => ["task", "criterion", "error_kind", "timeout_ms", "target_role", "target_name"].filter((k) => (o[k] ?? null) !== (e[k] ?? null)).map((k) => `${k} ${JSON.stringify(o[k] ?? null)} differs from the reference ${JSON.stringify(e[k] ?? null)}`),
  },
  log_summary: {
    system: `You analyse an excerpt of a log from an automated software-delivery system. Answer with JSON only:
{"status": "...", "component": "...", "first_error": "...", "summary": "..."}
- status: "failed" when the excerpt shows an error that stopped or failed the step, otherwise "ok".
- component: where the failure originated, exactly one of:
  "builder" (the coding worker did not deliver: no outcome files, a block it raised),
  "verifier" (the checking worker did not deliver: no check written, an invalid check),
  "gate" (the automated check run of the product: build, lint, types, tests, browser checks, a gate verdict FAIL:...),
  "executor" (the job runner: its own code such as bko.py, a Python Traceback or JobError inside an "app-job-start ... app-job-end" block that is not caused by GitHub or Docker, its allowlist),
  "github" (GitHub answered with an error: API status codes, repository rules, missing access, merges, branch updates),
  "docker" (containers, images, networks, volumes, disk space),
  "model_vendor" (the AI vendor refused a worker: usage or rate limits, expired or failed authentication, overload),
  "app" (the control application itself: the agents-app-web / agents-app-worker processes, its database migrations),
  "unknown". Use "unknown" when status is "ok".
- first_error: the first line (or part of a line) that shows the failure, copied VERBATIM from the excerpt, at most 300 characters; "" when status is "ok".
- summary: one or two plain sentences (at most 400 characters) saying what happened, using only facts, names and numbers that appear in the excerpt.`,
    schema: obj({}, { status: en(["failed", "ok"]), component: en(COMPONENTS), first_error: { type: "string" }, summary: { type: "string" } }, ["status", "component", "first_error", "summary"]),
    maxInput: 5000,
    maxTokens: 350,
    verifier: true,
    structural: (input, o) => {
      const p: string[] = [];
      if (!["failed", "ok"].includes(str(o.status))) p.push("status is not in the vocabulary");
      if (!(COMPONENTS as readonly string[]).includes(str(o.component))) p.push("component is not in the vocabulary");
      const fe = str(o.first_error);
      if (o.status === "failed" && (!fe.trim() || fe.length > 320 || !verbatim(input, fe))) p.push("first_error is missing, too long or not a verbatim quote of the input");
      if (o.status === "ok" && fe.trim()) p.push("first_error given although status is ok");
      const s = str(o.summary);
      if (s.trim().length < 20 || s.length > 450) p.push("summary shorter than 20 or longer than 450 characters");
      const u = ungrounded(input, s);
      if (u.length) p.push(`summary uses identifiers that are not in the input: ${u.slice(0, 5).join(", ")}`);
      return p;
    },
    agree: (o, e) => {
      const p: string[] = [];
      if (str(o.status) !== str(e.status)) p.push(`status ${str(o.status)} differs from the reference ${str(e.status)}`);
      const comps = Array.isArray(e.component) ? e.component.map(String) : [str(e.component)];
      if (!comps.includes(str(o.component))) p.push(`component ${str(o.component)} differs from the reference ${comps.join("|")}`);
      const any = Array.isArray(e.error_contains) ? e.error_contains.map(String) : [];
      if (any.length && !any.some((x) => norm(str(o.first_error)).toLowerCase().includes(x.toLowerCase()))) p.push("first_error is not the failing line of the reference");
      return p;
    },
  },
  summarization: {
    system: `You summarise the recorded timeline of one task of an automated software-delivery system for its owner. Each line is one recorded event, oldest first. State changes are written "A → B: reason". Answer with JSON only:
{"final_state": "...", "summary": "...", "incidents": [...]}
- final_state: the state the task is in after the LAST state change in the timeline, exactly one of: ${TASK_STATES.join(", ")}.
- summary: two to four plain sentences (80 to 600 characters): what was done, what went wrong if anything, and where the task stands. Use only facts, names and numbers that appear in the timeline. Do not invent causes.
- incidents: zero to five short phrases, one per distinct problem that occurred (a failed check, a block, a quota pause, a retry), each using words from the timeline; [] when nothing went wrong.`,
    schema: obj({}, { final_state: en(TASK_STATES), summary: { type: "string" }, incidents: { type: "array", items: { type: "string" } } }, ["final_state", "summary", "incidents"]),
    maxInput: 7000,
    maxTokens: 500,
    verifier: true,
    structural: (input, o) => {
      const p: string[] = [];
      if (!(TASK_STATES as readonly string[]).includes(str(o.final_state))) p.push("final_state is not in the vocabulary");
      const s = str(o.summary);
      if (s.trim().length < 80 || s.length > 650) p.push("summary shorter than 80 or longer than 650 characters");
      if (!Array.isArray(o.incidents) || o.incidents.length > 5 || o.incidents.some((x) => typeof x !== "string" || x.length > 200)) p.push("incidents is not a list of at most five short phrases");
      const u = ungrounded(input, `${s} ${Array.isArray(o.incidents) ? o.incidents.join(" ") : ""}`);
      if (u.length) p.push(`uses identifiers that are not in the input: ${u.slice(0, 5).join(", ")}`);
      return p;
    },
    agree: (o, e) => {
      const p: string[] = [];
      if (str(o.final_state) !== str(e.final_state)) p.push(`final_state ${str(o.final_state)} differs from the reference ${str(e.final_state)}`);
      const text = `${str(o.summary)} ${Array.isArray(o.incidents) ? o.incidents.join(" ") : ""}`.toLowerCase();
      for (const group of (Array.isArray(e.must_mention) ? e.must_mention : []) as unknown[]) {
        const alts = (Array.isArray(group) ? group : [group]).map((x) => String(x).toLowerCase());
        if (!alts.some((a) => text.includes(a))) p.push(`does not mention ${alts.join(" / ")}`);
      }
      if (e.clean === true && Array.isArray(o.incidents) && o.incidents.length > 0) p.push("reports incidents although nothing went wrong");
      return p;
    },
  },
};

/** The input a class receives: cut to its bound from the front (the end is the most recent part). */
export function boundInput(cls: SemanticClass, input: string): string {
  const max = SEMANTIC[cls].maxInput;
  return input.length <= max ? input : `…${input.slice(input.length - max + 1)}`;
}

export interface GateResult {
  pass: boolean;
  valid: boolean;
  problems: string[];
}
/** The deterministic gate of one output. `expect` present = qualification (reference agreement is part of the gate). */
export function semanticGate(cls: SemanticClass, input: string, out: unknown, expect?: Json | null): GateResult {
  if (!out || typeof out !== "object" || Array.isArray(out)) return { pass: false, valid: false, problems: ["output is not a JSON object"] };
  const spec = SEMANTIC[cls];
  const structural = spec.structural(input, out as Json);
  if (structural.length) return { pass: false, valid: false, problems: structural };
  const dis = expect ? spec.agree(out as Json, expect) : [];
  return { pass: dis.length === 0, valid: true, problems: dis };
}

// ---------------------------------------------------------------- coding classes -------------------------------------------------
export const CODE_SYSTEM = `You are a careful TypeScript engineer making one small, file-scoped change in an existing project.
Answer with JSON only: {"files": [{"path": "<path>", "content": "<the COMPLETE new content of that file>"}], "notes": "<one sentence: what you changed>"}.
Rules:
- Return only files you were told you may change, each with its complete content (never a fragment, never a diff, no placeholders such as "rest unchanged").
- Change as little as the task needs. Keep everything else in a file exactly as it is: names, exports, comments, formatting.
- Follow the conventions visible in the files you are shown (imports, types, naming). TypeScript is strict: no implicit any, handle undefined.
- Never change or weaken tests, and never special-case test inputs. Read-only reference files must not be returned.
- If the task cannot be done within the files you may change, return {"files": [], "notes": "<why>"}.`;

const SMALL_FILE = /^(src|tests)\/[A-Za-z0-9_./()[\]@-]+\.(ts|tsx)$/;
/**
 * Deterministic classification: is this plan task SMALL_CODE? Only a task the plan itself confines to at most three named source
 * files, on the standard tier, touching no sensitive criterion and no migration or interface change. Anything else is "build".
 */
export function isSmallCode(i: { tier: string; task: { scope_paths?: string[]; covers?: string[]; contributes?: string[]; requires?: string[] } | null; criteria: { id: string; tags?: string[] }[] }): { small: boolean; why: string } {
  const t = i.task;
  if (!t) return { small: false, why: "not a plan task with a declared file scope" };
  if (i.tier !== "standard") return { small: false, why: "critical tier" };
  const paths = t.scope_paths ?? [];
  if (paths.length < 1 || paths.length > 3) return { small: false, why: `${paths.length} files in scope (1 to 3 allowed)` };
  if (!paths.every((p) => SMALL_FILE.test(p) && !p.includes("..") && !p.includes("*"))) return { small: false, why: "scope is not a list of concrete source files" };
  if (paths.some((p) => /(^|\/)(schema|migrate|migrations?)\b|^src\/db\/schema|auth|session|secret|credential/i.test(p))) return { small: false, why: "scope touches schema, authentication or secrets" };
  if ((t.requires ?? []).length) return { small: false, why: "the task has special requirements" };
  const ids = new Set([...(t.covers ?? []), ...(t.contributes ?? [])]);
  const touched = i.criteria.filter((c) => ids.has(c.id));
  const bad = touched.flatMap((c) => c.tags ?? []).filter((x) => ["authz", "data-loss", "money", "pii", "security", "secret", "credential", "permission", "migration", "interface-change"].includes(x));
  if (bad.length) return { small: false, why: `sensitive or structural criteria (${[...new Set(bad)].join(", ")})` };
  return { small: true, why: `plan task confined to ${paths.length} named file(s)` };
}

/** Source files named by a failed check output (types, lint, tests), in order of appearance: the scope of a bounded repair. */
export function repairScope(details: string): string[] {
  const seen: string[] = [];
  for (const m of details.matchAll(/(?:^|[\s('"])((?:src|tests)\/[A-Za-z0-9_./()[\]@-]+\.(?:ts|tsx))(?=[:(\s'")]|$)/gm)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}
