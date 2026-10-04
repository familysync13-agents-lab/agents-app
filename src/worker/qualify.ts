import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { activity, artifacts, executorJobs, qualificationBatches, qualificationRecords, runs } from "@/db/schema";
import { sha256 } from "@/domain/contract";
import { ALL_TASK_CLASSES, CANDIDATES, CODE_CLASSES, classifyFailure, HOLDOUT, modelOf, PROMOTABLE, promotion, QUALIFY, qualification, ROUTES, route, SEMANTIC_CLASSES, WORKERS, type AnyTaskClass, type CodeClass, type QualRecord, type Risk, type SemanticClass } from "@/domain/router";
import { RESEARCH, RESEARCH_CLASSES, type ResearchClass } from "@/domain/research";
import { boundInput, CODE_SYSTEM, PATCH_SYSTEM, SEMANTIC, semanticGate, type SemanticSpec } from "@/domain/semantic";

/*
 * QUALIFICATION HARNESS and production path of the LOCAL workers (local-worker extension).
 *
 * Qualification is per (worker, task class), from recorded evidence only. A sample is one pinned case (a file in the repository,
 * identified by its sha256) run through exactly the path production uses:
 *   contract (the class instruction / the case's task) -> bounded input -> the worker's permission envelope (one schema-bound
 *   request to the allowlisted model; for code, in-scope files of a controlled worktree) -> deterministic gate -> independent
 *   Verifier when the gate passed (free text and code).
 * A sample agrees only if every stage passed. Nothing here changes a threshold: the Router's rule (QUALIFY) decides.
 */
type Json = Record<string, unknown>;
const DIR = () => path.join(process.cwd(), "src", "qualification", "cases");
const isProdSemantic = (c: string): c is SemanticClass => (SEMANTIC_CLASSES as readonly string[]).includes(c);
const isResearch = (c: string): c is ResearchClass => (RESEARCH_CLASSES as readonly string[]).includes(c);
/** bounded text-in / JSON-out classes: the production semantic classes and the research pack */
const isSemantic = (c: string): c is SemanticClass | ResearchClass => isProdSemantic(c) || isResearch(c);
/**
 * EDIT-BASED coding classes: a separate qualification path. Same pinned tasks as the whole-file classes, but the worker answers
 * with exact search/replace edits, and the gate additionally requires that nothing outside the lines the task is about changed.
 */
export const PATCH_CLASSES = ["patch_repair", "patch_small_code"] as const;
export type PatchClass = (typeof PATCH_CLASSES)[number];
const isPatch = (c: string): c is PatchClass => (PATCH_CLASSES as readonly string[]).includes(c);
const PATCH_BASE: Record<PatchClass, CodeClass> = { patch_repair: "bounded_repair", patch_small_code: "small_code" };
const isCode = (c: string): c is CodeClass | PatchClass => (CODE_CLASSES as readonly string[]).includes(c) || isPatch(c);
const specOf = (c: SemanticClass | ResearchClass): SemanticSpec => (isResearch(c) ? RESEARCH[c] : SEMANTIC[c]);
/** every class that has a qualification harness */
export const HARNESS_CLASSES: readonly string[] = [...SEMANTIC_CLASSES, ...RESEARCH_CLASSES, ...CODE_CLASSES, ...PATCH_CLASSES];
export const HARNESS_VOL = "agents-qf-1";

export interface SemanticCase { id: string; source: string; input: string; expect: Json }
export interface CodeCase { id: string; source: string; instruction: string; scope: string[]; context?: string[]; setup?: { path: string; find: string; replace: string }[]; hidden?: { path: string; content: string }[]; pretest?: string[]; tests: string[] | "all" }
export interface CaseSet<T> { class: string; version: number; statement: string; base?: string; cases: T[]; sha: string }

export function loadCaseSet<T = SemanticCase | CodeCase>(cls: string, holdout = false): CaseSet<T> {
  // the edit-based classes use the SAME pinned tasks as the whole-file classes (one file, one sha): only the interface differs
  // holdout sets (cases no model has seen before their promotion check) live beside the pinned sets, in ../holdout
  const raw = fs.readFileSync(holdout ? path.join(DIR(), "..", "holdout", `${cls}.json`) : path.join(DIR(), `${isPatch(cls) ? PATCH_BASE[cls] : cls}.json`), "utf8");
  return { ...(JSON.parse(raw) as Omit<CaseSet<T>, "sha">), sha: sha256(raw) };
}

export const qualRecords = async (db: Db): Promise<QualRecord[]> =>
  db.select({ worker: qualificationRecords.worker, taskClass: qualificationRecords.taskClass, valid: qualificationRecords.valid, agree: qualificationRecords.agree, model: qualificationRecords.model, voided: qualificationRecords.voided, mode: qualificationRecords.mode }).from(qualificationRecords);

/** The local candidate of a class (first enabled alternative that runs on the host), or null. */
export function localCandidate(cls: AnyTaskClass): string | null {
  return ROUTES[cls].alternatives.find((w) => WORKERS[w]!.enabled && WORKERS[w]!.provider === "ollama-host") ?? null;
}

function semanticJob(cls: SemanticClass | ResearchClass, model: string, input: string) {
  const spec = specOf(cls);
  const prompt = isResearch(cls) ? input.slice(0, spec.maxInput) : boundInput(cls, input);
  return { prompt, params: { model, system: spec.system, prompt, schema: spec.schema, max_tokens: spec.maxTokens } };
}

/** Run the pinned cases of a class through its local candidate (harness mode). Cases already recorded for this model and case set are skipped. */
export async function qualifyRun(db: Db, cls: string, opts: { ids?: string[]; repo?: string; worker?: string; holdout?: boolean } = {}): Promise<{ submitted: number; skipped: number; worker: string | null; model?: string; caseSet?: string }> {
  if (!isSemantic(cls) && !isCode(cls)) throw new Error(`no qualification harness for class ${cls}`);
  // an explicit worker may be a routable local worker or an evaluation candidate; without one, the class's own local alternative
  const worker = opts.worker ?? (cls in ROUTES ? localCandidate(cls as AnyTaskClass) : null);
  if (!worker) return { submitted: 0, skipped: 0, worker: null };
  const model = modelOf(worker);
  if (!model || (WORKERS[worker] && WORKERS[worker]!.provider !== "ollama-host")) throw new Error(`${worker} is not a local worker or evaluation candidate`);
  if (opts.holdout && !(isProdSemantic(cls) && (PROMOTABLE[cls as AnyTaskClass] ?? []).includes(worker))) throw new Error(`${worker} is not a promotion candidate for ${cls}`);
  const set = loadCaseSet(cls, opts.holdout);
  const had = await db.select({ caseId: qualificationRecords.caseId }).from(qualificationRecords).where(and(eq(qualificationRecords.worker, worker), eq(qualificationRecords.taskClass, cls), eq(qualificationRecords.model, model), eq(qualificationRecords.caseSetSha256, set.sha), eq(qualificationRecords.voided, false)));
  const done = new Set(had.map((h) => h.caseId));
  let pool = set.cases;
  if (opts.holdout) {
    // the holdout runs the first HOLDOUT.size cases (file order) whose reference the independent Verifier accepted in calibration
    const refs = await db.select({ caseId: qualificationRecords.caseId, verifier: qualificationRecords.verifier }).from(qualificationRecords).where(and(eq(qualificationRecords.worker, REFERENCE), eq(qualificationRecords.taskClass, cls), eq(qualificationRecords.caseSetSha256, set.sha), eq(qualificationRecords.voided, false)));
    const verdict = new Map(refs.map((r) => [r.caseId, r.verifier]));
    if (set.cases.some((c) => !verdict.get(c.id))) throw new Error("the holdout references are not calibrated yet (run holdout_reference and wait for the Verifier)");
    pool = set.cases.filter((c) => verdict.get(c.id) === "pass").slice(0, HOLDOUT.size);
    if (pool.length < HOLDOUT.size) throw new Error(`only ${pool.length} holdout cases have a reference the Verifier accepted (need ${HOLDOUT.size})`);
  }
  const todo = pool.filter((c) => !done.has(c.id) && (!opts.ids || opts.ids.includes(c.id)));
  if (todo.length && isCode(cls)) await db.insert(executorJobs).values({ op: "worktree", params: { vol: HARNESS_VOL, repo: opts.repo ?? "agents-app", ref: set.base } });
  for (const c of todo) {
    let op: string, params: Json, bytes: number, digestOf: string;
    if (isSemantic(cls)) {
      const j = semanticJob(cls, model, (c as SemanticCase).input);
      op = "local_llm"; params = j.params; bytes = j.prompt.length; digestOf = j.prompt;
    } else {
      const k = c as CodeCase;
      op = "local_code";
      params = { vol: HARNESS_VOL, model, reset: true, system: CODE_SYSTEM, instruction: k.instruction, scope: k.scope, context: k.context ?? [], setup: k.setup ?? [], hidden: k.hidden ?? [], pretest: k.pretest ?? [], checks: { typecheck: true, lint: true, tests: k.tests } };
      // edit-based interface: exact search/replace edits; everything outside the lines of the seeded defect / the removed function must stay byte-identical
      if (isPatch(cls)) params = { ...params, mode: "patch", system: PATCH_SYSTEM, preserve: (k.setup ?? []).map((s) => ({ path: s.path, anchor: s.replace })) };
      bytes = k.instruction.length; digestOf = JSON.stringify(params);
    }
    const [job] = await db.insert(executorJobs).values({ op, params }).returning({ id: executorJobs.id });
    await db.insert(qualificationRecords).values({ worker, taskClass: cls, mode: opts.holdout ? "holdout" : "harness", inputSha256: sha256(digestOf), expected: isSemantic(cls) ? JSON.stringify((c as SemanticCase).expect) : null, jobId: job!.id, model, caseId: c.id, caseSetSha256: set.sha, contextBytes: bytes });
  }
  return { submitted: todo.length, skipped: pool.length - todo.length, worker, model, caseSet: set.sha.slice(0, 12) };
}

type LlmResult = { ok?: boolean; available?: boolean; output?: Json | null; ms?: number; model?: string; digest?: string; reason?: string; usage?: { prompt_tokens?: number; output_tokens?: number }; raw?: string };
type CodeResult = LlmResult & { stage?: string; gate?: { pass?: boolean; stage?: string; reason?: string; checks?: { name: string; rc: number; ms: number; tail: string }[] }; diff?: string; diffstat?: string; notes?: string; written?: string[]; changed?: string[]; prompt_chars?: number; pretest_rc?: number | null };

/**
 * Read finished candidate jobs: run the deterministic gate, record what happened. A candidate that could not run at all (model
 * missing, host unreachable, the harness itself failed) is closed without a verdict - that says nothing about its quality.
 */
export async function collectCandidates(db: Db, now: () => Date = () => new Date()): Promise<number> {
  const open = await db.select().from(qualificationRecords).where(and(isNotNull(qualificationRecords.jobId), isNull(qualificationRecords.valid), eq(qualificationRecords.voided, false))).orderBy(asc(qualificationRecords.id)).limit(25);
  let n = 0;
  for (const r of open) {
    const [j] = await db.select().from(executorJobs).where(eq(executorJobs.id, r.jobId!));
    if (!j || j.status === "queued" || j.status === "running") continue;
    n++;
    const set = (v: Partial<typeof qualificationRecords.$inferInsert>) => db.update(qualificationRecords).set(v).where(eq(qualificationRecords.id, r.id));
    const res = (j.result ?? {}) as CodeResult;
    const harnessFailed = j.status === "error" || res.available === false || (j.op === "local_code" && res.ok === false);
    if (harnessFailed) {
      await set({ valid: false, agree: null, note: `candidate unavailable: ${String(j.error ?? res.reason ?? res.stage ?? "").slice(0, 200)}` });
      if (r.mode === "production") await finishProduction(db, r, null, `the local worker could not run (${String(j.error ?? res.reason ?? "").slice(0, 120)})`);
      continue;
    }
    const usage = { durationMs: res.ms ?? null, modelDigest: res.digest ?? null, promptTokens: res.usage?.prompt_tokens ?? null, outputTokens: res.usage?.output_tokens ?? null };
    if (j.op === "local_code") {
      const g = res.gate ?? {};
      const pass = g.pass === true;
      const checks = (g.checks ?? []).map((c) => ({ name: c.name, rc: c.rc, ms: c.ms, tail: c.rc === 0 ? "" : String(c.tail).slice(-1200) }));
      await set({ ...usage, valid: g.stage === "checks", gate: pass, gateDetail: { stage: g.stage, reason: g.reason ?? null, checks, diffstat: res.diffstat ?? null, numstat: (res as Json).numstat ?? null, edits: (res as Json).edits ?? null, loaded_bytes: (res as Json).loaded_bytes ?? null, pretest_rc: res.pretest_rc ?? null }, output: { notes: res.notes ?? null, changed: res.changed ?? [], diff: String(res.diff ?? "").slice(0, 30000) }, contextBytes: res.prompt_chars ?? r.contextBytes, ...(pass ? {} : { agree: r.mode === "production" ? null : false }) });
      continue;
    }
    const cls = r.taskClass as SemanticClass | ResearchClass;
    const input = String((j.params as Json).prompt ?? "");
    const expect = r.expected ? (JSON.parse(r.expected) as Json) : null;
    const g = isResearch(cls) ? researchGate(cls, input, res.ok ? res.output : null, expect) : semanticGate(cls, input, res.ok ? res.output : null, r.mode === "production" ? null : expect);
    // a holdout sample is always reviewed independently when its gate passes, whatever the class
    const needsVerifier = (specOf(cls).verifier || r.mode === "holdout") && g.pass;
    await set({ ...usage, valid: g.valid, gate: g.pass, gateDetail: { problems: g.problems, ...(res.ok ? {} : { raw: String(res.raw ?? "").slice(0, 400) }) }, output: (res.output ?? { raw: null }) as Json, verifier: g.pass && !needsVerifier ? "not_applicable" : null, ...(r.mode === "production" ? {} : needsVerifier ? {} : { agree: g.pass }) });
    if (r.mode === "production" && isProdSemantic(cls)) await finishProduction(db, r, g.pass ? (res.output as Json) : null, g.pass ? null : `the output failed its gate (${g.problems.slice(0, 2).join("; ")})`);
  }
  await qualifyVerify(db);
  n += await advanceBatches(db, now);
  return n;
}

// ---------------------------------------------------------------- independent Verifier (batches) ---------------------------------
const VERIFY_SEMANTIC = `You are an independent reviewer. The file /work/items.json holds a JSON array of items {id, instruction, input, output}. For every item decide whether the output is FAITHFUL to the input: every statement in its free text (summary, incidents) is supported by the input, nothing in the input is contradicted, nothing is invented, and the main event of the input is covered. Wording and brevity do not matter. Do not judge fields other than the free text.
Write /work/out/findings.json with exactly this shape and one verdict per item: {"verdicts": [{"id": "<item id>", "pass": true or false, "reason": "<one sentence>"}]}
Create the directory /work/out if needed. Do not create or change anything else. Finish with the single line VERIFIER-DONE.`;
const VERIFY_CODE = `You are an independent code reviewer. The file /work/items.json holds a JSON array of items {id, task, diff}. Each diff is a change a worker made for the task in a TypeScript project; the project's own type check, lint and tests already pass with it. For every item decide whether the change itself is acceptable: it does what the task states, it changes nothing unrelated, it does not special-case test inputs or weaken or remove checks, and it contains no evident defect. A different but correct solution passes.
Write /work/out/findings.json with exactly this shape and one verdict per item: {"verdicts": [{"id": "<item id>", "pass": true or false, "reason": "<one sentence>"}]}
Create the directory /work/out if needed. Do not create or change anything else. Finish with the single line VERIFIER-DONE.`;

const VERIFY_RESEARCH = `You are an independent reviewer of research work. The file /work/items.json holds a JSON array of items {id, task, rubric, input, output}. Each output was produced for the task from the input alone. For every item decide whether the output satisfies its rubric, judging strictly against the input: anything the output states that the input does not support is a failure, and so is a guessed or invented value. Style does not matter.
Write /work/out/findings.json with exactly this shape and one verdict per item: {"verdicts": [{"id": "<item id>", "pass": true or false, "reason": "<one sentence naming the decisive point>"}]}
Create the directory /work/out if needed. Do not create or change anything else. Finish with the single line VERIFIER-DONE.`;

const VERIFY_FIELDS = `You are an independent reviewer. The file /work/items.json holds a JSON array of items {id, instruction, input, output}. Each output was produced for the instruction from the input alone. For every item decide whether the output is CORRECT for its input: every field has the value the instruction prescribes for this input, a label is one the instruction's definitions select for this input, and copied values are exact and present in the input. Fail an item only for a material error: a wrong label, or a wrong, missing or invented value. When the instruction's definitions genuinely allow the output's label for this input, pass it. Formatting does not matter.
Write /work/out/findings.json with exactly this shape and one verdict per item: {"verdicts": [{"id": "<item id>", "pass": true or false, "reason": "<one sentence naming the decisive point>"}]}
Create the directory /work/out if needed. Do not create or change anything else. Finish with the single line VERIFIER-DONE.`;

/** The research gate: structural problems make an output invalid; reference problems make a valid output disagree. */
function researchGate(cls: ResearchClass, input: string, out: unknown, expect: Json | null) {
  if (!out || typeof out !== "object" || Array.isArray(out)) return { pass: false, valid: false, problems: ["[schema] output is not a JSON object"] };
  const structural = RESEARCH[cls].structural(input, out as Json);
  if (structural.length) return { pass: false, valid: false, problems: structural };
  const dis = expect ? RESEARCH[cls].agree(out as Json, expect) : [];
  return { pass: dis.length === 0, valid: true, problems: dis };
}

/** Hand every gate-passing output that still lacks an independent verdict to the Verifier, in batches. */
export async function qualifyVerify(db: Db, cls?: string): Promise<{ batches: number; records: number }> {
  const rows = await db.select().from(qualificationRecords).where(and(eq(qualificationRecords.gate, true), isNull(qualificationRecords.verifier), eq(qualificationRecords.voided, false)));
  const busy = new Set((await db.select().from(qualificationBatches).where(inArray(qualificationBatches.state, ["start", "started", "poll", "dump", "quota"]))).flatMap((b) => b.recordIds));
  const groups = new Map<string, typeof rows>();
  // a class is batched once all of its submitted candidates have been collected (one Verifier session per batch, not per sample)
  const pending = new Set((await db.select({ worker: qualificationRecords.worker, taskClass: qualificationRecords.taskClass }).from(qualificationRecords).where(and(isNotNull(qualificationRecords.jobId), isNull(qualificationRecords.valid), eq(qualificationRecords.voided, false)))).map((x) => `${x.worker}|${x.taskClass}`));
  for (const r of rows) {
    if (busy.has(r.id) || (cls && r.taskClass !== cls) || pending.has(`${r.worker}|${r.taskClass}`)) continue;
    const k = `${r.worker}|${r.taskClass}|${r.mode === "holdout" ? "h" : ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let batches = 0, records = 0;
  for (const [k, rs] of groups) {
    const [worker, taskClass] = k.split("|") as [string, string, string];
    const size = isCode(taskClass) ? 7 : 20;
    for (let i = 0; i < rs.length; i += size) {
      const part = rs.slice(i, i + size);
      await db.insert(qualificationBatches).values({ worker, taskClass, recordIds: part.map((r) => r.id) });
      batches++; records += part.length;
    }
  }
  return { batches, records };
}

async function batchItems(db: Db, b: typeof qualificationBatches.$inferSelect): Promise<Json[]> {
  const rs = await db.select().from(qualificationRecords).where(inArray(qualificationRecords.id, b.recordIds));
  const items: Json[] = [];
  for (const r of rs) {
    const [j] = r.jobId ? await db.select().from(executorJobs).where(eq(executorJobs.id, r.jobId)) : [];
    const p = (j?.params ?? {}) as Json;
    if (r.mode === "holdout" && isProdSemantic(r.taskClass)) {
      // holdout review: the full class instruction, the bounded input (of the job, or of the case for a reference record) and the output
      const input = j ? String(p.prompt ?? "") : boundInput(r.taskClass, loadCaseSet<SemanticCase>(r.taskClass, true).cases.find((c) => c.id === r.caseId)?.input ?? "");
      items.push({ id: `r${r.id}`, instruction: SEMANTIC[r.taskClass].system, input, output: r.output });
    } else if (isCode(r.taskClass)) items.push({ id: `r${r.id}`, task: String(p.instruction ?? "").slice(0, 6000), diff: String((r.output as Json | null)?.diff ?? "").slice(0, 30000) });
    else if (isResearch(r.taskClass)) items.push({ id: `r${r.id}`, task: loadCaseSetSafe(r.taskClass)?.statement ?? r.taskClass, rubric: RESEARCH[r.taskClass].rubric, input: String(p.prompt ?? ""), output: r.output });
    else items.push({ id: `r${r.id}`, instruction: loadCaseSetSafe(r.taskClass)?.statement ?? r.taskClass, input: String(p.prompt ?? ""), output: r.output });
  }
  return items;
}
const isHoldoutBatch = async (db: Db, ids: number[]) => (await db.select({ mode: qualificationRecords.mode }).from(qualificationRecords).where(inArray(qualificationRecords.id, ids))).every((r) => r.mode === "holdout");
const loadCaseSetSafe = (cls: string) => {
  try { return loadCaseSet(cls); } catch { return null; }
};

/** Advance Verifier batches by one step each (called from the control loop; never blocks, never touches a task). */
export async function advanceBatches(db: Db, now: () => Date = () => new Date()): Promise<number> {
  const live = await db.select().from(qualificationBatches).where(inArray(qualificationBatches.state, ["start", "started", "poll", "dump", "quota"])).orderBy(asc(qualificationBatches.id)).limit(4);
  let n = 0;
  for (const b of live) {
    const d = b.data;
    const upd = (state: (typeof b)["state"], data: Json, extra: Json = {}) => db.update(qualificationBatches).set({ state, data: { ...d, ...data }, ...extra }).where(eq(qualificationBatches.id, b.id));
    const job = async (id: unknown) => (id ? (await db.select().from(executorJobs).where(eq(executorJobs.id, Number(id))))[0] : undefined);
    if (b.state === "quota") {
      if (now().getTime() >= Number(d.until ?? 0)) { await upd("start", { jobId: null, sessJob: null, dumpJob: null, container: null }); n++; }
      continue;
    }
    if (b.state === "start") {
      // one Verifier at a time for qualification, and never while a task's own Verifier job is queued
      const others = live.filter((x) => x.id !== b.id && ["started", "poll", "dump"].includes(x.state));
      if (others.length) continue;
      const items = await batchItems(db, b);
      const [j] = await db.insert(executorJobs).values({ op: "verifier", params: { work_vol: `agents-vw-0-q${b.id}`, files: { "items.json": Buffer.from(JSON.stringify(items, null, 1)).toString("base64") }, prompt: items.length && items.every((x) => typeof x.instruction === "string" && String(x.instruction).startsWith("You ")) && (await isHoldoutBatch(db, b.recordIds)) ? VERIFY_FIELDS : isCode(b.taskClass) ? VERIFY_CODE : isResearch(b.taskClass) ? VERIFY_RESEARCH : VERIFY_SEMANTIC } }).returning({ id: executorJobs.id });
      await upd("started", { jobId: j!.id, items: items.length }); n++;
      continue;
    }
    if (b.state === "started") {
      const j = await job(d.jobId);
      if (!j || j.status === "queued" || j.status === "running") continue;
      if (j.status === "error") { await upd("failed", { error: String(j.error).slice(0, 300) }, { finishedAt: now() }); n++; continue; }
      await upd("poll", { container: String(j.result?.detached ?? ""), pollAt: now().getTime() + 20_000 }); n++;
      continue;
    }
    if (b.state === "poll") {
      if (!d.sessJob) {
        if (now().getTime() < Number(d.pollAt ?? 0)) continue;
        const [j] = await db.insert(executorJobs).values({ op: "session", params: { name: d.container, tail_lines: 2 } }).returning({ id: executorJobs.id });
        await upd("poll", { sessJob: j!.id }); n++;
        continue;
      }
      const j = await job(d.sessJob);
      if (!j || j.status === "queued" || j.status === "running") continue;
      const r = (j.result ?? {}) as Json;
      if (j.status === "done" && r.running) { await upd("poll", { sessJob: null, pollAt: now().getTime() + 20_000 }); continue; }
      const errs = typeof r.stderr_tail === "string" ? r.stderr_tail.split("\n").filter((l) => /^ERROR:/.test(l)).join("\n") : "";
      const f = classifyFailure(errs, now().getTime());
      if (f.cls === "quota") { await upd("quota", { until: f.resetAt && f.resetAt > now().getTime() ? f.resetAt + 60_000 : now().getTime() + 30 * 60_000, quota: errs.slice(0, 160) }); n++; continue; }
      const [dj] = await db.insert(executorJobs).values({ op: "dump", params: { vol: `agents-vw-0-q${b.id}`, paths: ["out/findings.json"] } }).returning({ id: executorJobs.id });
      await upd("dump", { dumpJob: dj!.id, exit: r.exit ?? null }); n++;
      continue;
    }
    if (b.state === "dump") {
      const j = await job(d.dumpJob);
      if (!j || j.status === "queued" || j.status === "running") continue;
      n++;
      type Verdict = { id?: string; pass?: boolean; reason?: string };
      let verdicts = null as Verdict[] | null;
      try {
        const raw = Buffer.from(String((j.result as Json | null)?.["out/findings.json"] ?? ""), "base64").toString("utf8");
        const v = (JSON.parse(raw) as { verdicts?: unknown }).verdicts;
        if (Array.isArray(v)) verdicts = v as Verdict[];
      } catch { verdicts = null; }
      if (!verdicts) { await upd("failed", { error: "the Verifier wrote no readable out/findings.json" }, { finishedAt: now() }); continue; }
      let applied = 0;
      for (const id of b.recordIds) {
        const v = verdicts.find((x) => x.id === `r${id}`);
        if (!v || typeof v.pass !== "boolean") continue;
        const [r] = await db.select().from(qualificationRecords).where(eq(qualificationRecords.id, id));
        if (!r || r.verifier) continue;
        await db.update(qualificationRecords).set({ verifier: v.pass ? "pass" : "fail", verifierNote: String(v.reason ?? "").slice(0, 400), ...(r.mode === "production" ? {} : { agree: v.pass }) }).where(eq(qualificationRecords.id, id));
        applied++;
      }
      await upd("done", { applied }, { finishedAt: now() });
    }
  }
  return n;
}

// ---------------------------------------------------------------- status ---------------------------------------------------------
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

export type FinalStatus = "QUALIFIED_CANDIDATE" | "PENDING_VERIFICATION" | "FAILED_GATE" | "REJECTED_BY_VERIFIER" | "PATCH_BASED_LOCAL_CODING" | "DISABLED" | "NOT_RUN";
/**
 * The qualification status of one (worker or candidate, class), from its recorded samples only. Gate and Verifier are reported
 * separately; the threshold is the Router's (QUALIFY.minAgreement over at least QUALIFY.minSamples samples) and is not relaxed.
 */
export function finalStatus(i: { enabled: boolean; cls: string; samples: number; gatePass: number; verifierPending: number; agree: number }): FinalStatus {
  if (!i.enabled) return "DISABLED";
  if (i.samples === 0) return "NOT_RUN";
  const need = QUALIFY.minAgreement;
  // a class already below the threshold on the gate alone cannot recover, whatever is still pending
  if (i.samples >= QUALIFY.minSamples && i.gatePass / i.samples < need) return "FAILED_GATE";
  if (i.samples < QUALIFY.minSamples || i.verifierPending > 0) return "PENDING_VERIFICATION";
  if (i.agree / i.samples >= need) return isPatch(i.cls) ? "PATCH_BASED_LOCAL_CODING" : "QUALIFIED_CANDIDATE";
  return "REJECTED_BY_VERIFIER";
}

/** Per (worker or evaluation candidate, class) with a harness: gate, Verifier, agreement and final status, with every failed case. Read-only. */
export async function qualifyStatus(db: Db) {
  const all = await db.select().from(qualificationRecords);
  const recs: QualRecord[] = all;
  const pairs = new Map<string, { worker: string; cls: string }>();
  for (const cls of ALL_TASK_CLASSES) for (const w of ROUTES[cls].alternatives) if (WORKERS[w]!.provider === "ollama-host") pairs.set(`${w}|${cls}`, { worker: w, cls });
  for (const r of all) if (!r.voided && modelOf(r.worker) && (WORKERS[r.worker]?.provider === "ollama-host" || CANDIDATES[r.worker])) pairs.set(`${r.worker}|${r.taskClass}`, { worker: r.worker, cls: r.taskClass });
  const out = [];
  for (const { worker: w, cls } of pairs.values()) {
    const model = modelOf(w)!;
    const mine = all.filter((r) => r.worker === w && r.taskClass === cls && !r.voided && r.model === model);
    const ev = mine.filter((r) => r.mode !== "production" && r.gate !== null);
    const routable = cls in ROUTES && ROUTES[cls as AnyTaskClass].alternatives.includes(w);
    const q = qualification(recs, w, cls);
    const d = cls in ROUTES ? route({ taskClass: cls as AnyTaskClass, risk: "standard", records: recs }) : null;
    const gatePass = ev.filter((r) => r.gate === true).length;
    const verifierPending = ev.filter((r) => r.gate === true && r.verifier === null).length;
    const agree = ev.filter((r) => r.agree === true).length;
    out.push({
      taskClass: cls, worker: w, model, candidateOnly: !routable, digest: mine.find((r) => r.modelDigest)?.modelDigest ?? null,
      status: WORKERS[w] && !WORKERS[w]!.enabled ? "disabled" : q.status, samples: ev.length, agreement: ev.length ? agree / ev.length : null,
      finalStatus: finalStatus({ enabled: WORKERS[w] ? WORKERS[w]!.enabled : true, cls, samples: ev.length, gatePass, verifierPending, agree }),
      gatePass, gateFail: ev.filter((r) => r.gate === false).length, schemaInvalid: ev.filter((r) => r.valid === false).length,
      verifierPass: ev.filter((r) => r.verifier === "pass").length, verifierFail: ev.filter((r) => r.verifier === "fail").length, verifierPending, verifierNotApplicable: ev.filter((r) => r.verifier === "not_applicable").length,
      unavailable: mine.filter((r) => r.mode !== "production" && r.valid === false && r.gate === null).length, production: mine.filter((r) => r.mode === "production").length,
      medianMs: median(ev.map((r) => r.durationMs).filter((x): x is number => typeof x === "number")), maxMs: Math.max(0, ...ev.map((r) => r.durationMs ?? 0)), medianContextBytes: median(ev.map((r) => r.contextBytes).filter((x): x is number => typeof x === "number")),
      promptTokens: ev.reduce((a, r) => a + (r.promptTokens ?? 0), 0), outputTokens: ev.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
      routedTo: d?.worker ?? null, routeReason: d?.reason ?? "evaluation only: this class is not routed",
      failures: ev.filter((r) => r.agree === false).map((r) => ({ case: r.caseId, gate: r.gate, verifier: r.verifier, stage: (r.gateDetail as Json | null)?.stage ?? null, why: r.gate === false ? JSON.stringify((r.gateDetail as Json | null)?.problems ?? (r.gateDetail as Json | null)?.reason ?? r.gateDetail).slice(0, 500) : r.verifierNote, checks: r.gate === false && isCode(cls) ? ((r.gateDetail as Json | null)?.checks as { name: string; rc: number; tail: string }[] | undefined)?.filter((c) => c.rc !== 0).map((c) => `${c.name}: ${c.tail.slice(-300)}`) : undefined, diffstat: isCode(cls) ? (r.gateDetail as Json | null)?.diffstat : undefined })),
      unavailableNotes: mine.filter((r) => r.valid === false && r.gate === null).map((r) => `${r.caseId}: ${r.note}`).slice(0, 5),
    });
  }
  return out;
}

/** The Router's rule table over ALL classes (the ten primary ones and the local-worker classes). */
export async function routeTableAll(db: Db) {
  const records = await qualRecords(db);
  return ALL_TASK_CLASSES.map((tc) => {
    const d = route({ taskClass: tc, risk: "standard", records });
    return { taskClass: tc, worker: d.worker, model: d.model, reason: d.reason, shadow: d.shadow, alternatives: ROUTES[tc].alternatives.map((w) => ({ worker: w, model: WORKERS[w]!.model, enabled: WORKERS[w]!.enabled, disabledReason: WORKERS[w]!.disabledReason ?? null, ...qualification(records, w, tc) })), promotable: (PROMOTABLE[tc] ?? []).map((w) => ({ worker: w, model: WORKERS[w]!.model, ...promotion(records, w, tc) })) };
  });
}

// ---------------------------------------------------------------- promotion by holdout ------------------------------------------
export const REFERENCE = "reference";
/**
 * Calibration of a holdout set BEFORE any model sees it: the pinned reference outputs go to the independent Verifier as records of
 * the pseudo-worker "reference". A reference the Verifier rejects marks a case whose expected answer is not clearly prescribed by
 * the instruction; such a case is repaired or replaced before the candidate runs (never after).
 */
export async function holdoutReference(db: Db, cls: string): Promise<{ inserted: number; caseSet: string }> {
  if (!isProdSemantic(cls)) throw new Error(`no holdout for class ${cls}`);
  const set = loadCaseSet<SemanticCase>(cls, true);
  const had = new Set((await db.select({ caseId: qualificationRecords.caseId }).from(qualificationRecords).where(and(eq(qualificationRecords.worker, REFERENCE), eq(qualificationRecords.taskClass, cls), eq(qualificationRecords.caseSetSha256, set.sha), eq(qualificationRecords.voided, false)))).map((h) => h.caseId));
  const todo = set.cases.filter((c) => !had.has(c.id));
  for (const c of todo) {
    const input = boundInput(cls, c.input);
    const g = semanticGate(cls, input, c.expect, c.expect);
    if (!g.pass) throw new Error(`holdout reference ${c.id} does not pass its own gate: ${g.problems.join("; ")}`);
    await db.insert(qualificationRecords).values({ worker: REFERENCE, taskClass: cls, mode: "holdout", inputSha256: sha256(input), expected: JSON.stringify(c.expect), output: c.expect, valid: true, gate: true, model: REFERENCE, caseId: c.id, caseSetSha256: set.sha, contextBytes: input.length, note: "reference output of the holdout case (calibration of the Verifier, no model involved)" });
  }
  return { inserted: todo.length, caseSet: set.sha.slice(0, 12) };
}

/** Holdout evidence and promotion status per (class, worker), with every failed case. Small and read-only. */
export async function holdoutStatus(db: Db) {
  const all = await db.select().from(qualificationRecords).where(eq(qualificationRecords.voided, false));
  const recs: QualRecord[] = all;
  const out = [];
  for (const [cls, workers] of Object.entries(PROMOTABLE)) for (const w of [...(workers ?? []), REFERENCE]) {
    const model = w === REFERENCE ? REFERENCE : modelOf(w);
    const hs = all.filter((r) => r.worker === w && r.taskClass === cls && r.mode === "holdout" && r.model === model);
    const sets = [...new Set(hs.map((r) => r.caseSetSha256?.slice(0, 12)))];
    const d = all.filter((r) => r.worker === w && r.taskClass === cls && (r.mode === "promoted" || r.mode === "promotion_rejected")).map((r) => ({ id: r.id, decision: r.mode, note: r.note, at: r.createdAt }));
    out.push({
      taskClass: cls, worker: w, model, required: HOLDOUT.size, threshold: QUALIFY.minAgreement, caseSets: sets, samples: hs.length, collected: hs.filter((r) => r.gate !== null).length,
      unavailable: hs.filter((r) => r.valid === false && r.gate === null).length, gatePass: hs.filter((r) => r.gate === true).length, schemaInvalid: hs.filter((r) => r.valid === false && r.gate === false).length,
      verifierPass: hs.filter((r) => r.verifier === "pass").length, verifierFail: hs.filter((r) => r.verifier === "fail").length, verifierPending: hs.filter((r) => r.gate === true && r.verifier === null).length,
      agree: hs.filter((r) => r.agree === true).length, promotion: w === REFERENCE ? null : promotion(recs, w, cls), decisions: d,
      routedTo: route({ taskClass: cls as AnyTaskClass, risk: "standard", records: recs }).worker,
      failures: hs.filter((r) => r.agree === false).map((r) => ({ case: r.caseId, gate: r.gate, valid: r.valid, verifier: r.verifier, why: r.gate === false ? JSON.stringify((r.gateDetail as Json | null)?.problems ?? null).slice(0, 300) : String(r.verifierNote ?? "").slice(0, 300), output: JSON.stringify(r.output).slice(0, 300) })),
    });
  }
  return out;
}

/**
 * Record the promotion decision of a class for a worker IN the qualification records (so it cannot be forgotten). "promoted" is
 * refused unless the holdout is complete, fully verified and at the threshold; the Router reads this record together with the samples.
 */
export async function holdoutDecide(db: Db, i: { cls: string; worker: string; decision: "promoted" | "rejected"; note: string }) {
  if (!(PROMOTABLE[i.cls as AnyTaskClass] ?? []).includes(i.worker)) throw new Error(`${i.worker} is not a promotion candidate for ${i.cls}`);
  const model = modelOf(i.worker)!;
  const all = await db.select().from(qualificationRecords).where(and(eq(qualificationRecords.worker, i.worker), eq(qualificationRecords.taskClass, i.cls), eq(qualificationRecords.voided, false)));
  if (all.some((r) => r.mode === "promoted" || r.mode === "promotion_rejected")) throw new Error("a promotion decision is already recorded for this class and worker");
  const hs = all.filter((r) => r.mode === "holdout" && r.model === model);
  const open = hs.filter((r) => r.agree === null).length;
  const agree = hs.filter((r) => r.agree === true && r.valid === true).length;
  if (hs.length < HOLDOUT.size || open > 0) throw new Error(`the holdout is not complete: ${hs.length} samples, ${open} without a verdict (need ${HOLDOUT.size})`);
  if (i.decision === "promoted" && agree / hs.length < QUALIFY.minAgreement) throw new Error(`cannot promote: ${agree} of ${hs.length} agreed, below ${QUALIFY.minAgreement}`);
  const [row] = await db.insert(qualificationRecords).values({ worker: i.worker, taskClass: i.cls, mode: i.decision === "promoted" ? "promoted" : "promotion_rejected", inputSha256: sha256(`${i.worker}|${i.cls}|${hs.map((r) => r.id).join(",")}`), model, caseSetSha256: hs[0]?.caseSetSha256 ?? null, note: `holdout ${agree}/${hs.length} agreed (threshold ${QUALIFY.minAgreement}); decision: ${i.decision}. ${i.note}`.slice(0, 900) }).returning({ id: qualificationRecords.id });
  const recs = await qualRecords(db);
  return { record: row!.id, samples: hs.length, agree, promotion: promotion(recs, i.worker, i.cls), routedTo: route({ taskClass: i.cls as AnyTaskClass, risk: "standard", records: recs }).worker };
}

// ---------------------------------------------------------------- production: bounded semantic jobs ------------------------------
const PURPOSE: Record<SemanticClass, string> = { summarization: "What happened (local summary)", log_summary: "Log analysis (local)", failure_triage: "Failure triage (local)", classification: "Classification (local)", structured_extraction: "Extraction (local)" };

/**
 * A bounded semantic job for a task, through the Router. It runs ONLY when a local worker has qualified for the class; otherwise
 * nothing is started (the deterministic text the control plane already has stands) and the reason is returned. The job never
 * blocks the task: its gated result is attached to the task as an artifact and a ledger row when it arrives.
 */
export async function submitSemantic(db: Db, i: { taskId: number; cls: SemanticClass; input: string; risk?: Risk }): Promise<{ routed: boolean; worker: string; reason: string; record?: number }> {
  const d = route({ taskClass: i.cls, risk: i.risk ?? "standard", records: await qualRecords(db) });
  const w = WORKERS[d.worker]!;
  if (w.provider !== "ollama-host") return { routed: false, worker: d.worker, reason: d.reason };
  const j = semanticJob(i.cls, w.model, i.input);
  const [job] = await db.insert(executorJobs).values({ taskId: i.taskId, op: "local_llm", params: j.params }).returning({ id: executorJobs.id });
  const [run] = await db.insert(runs).values({ taskId: i.taskId, role: "builder", purpose: "semantic", container: `local:${job!.id}`, status: "running", taskClass: i.cls, worker: w.id, harness: w.harness, model: w.model, provider: w.provider, routeReason: d.reason, envelope: w.envelope as unknown as Json, contextBytes: j.prompt.length }).returning({ id: runs.id });
  const [rec] = await db.insert(qualificationRecords).values({ worker: w.id, taskClass: i.cls, mode: "production", taskId: i.taskId, inputSha256: sha256(j.prompt), jobId: job!.id, model: w.model, contextBytes: j.prompt.length, note: `run ${run!.id}` }).returning({ id: qualificationRecords.id });
  return { routed: true, worker: w.id, reason: d.reason, record: rec!.id };
}

async function finishProduction(db: Db, r: typeof qualificationRecords.$inferSelect, output: Json | null, problem: string | null) {
  if (!r.taskId) return;
  const runId = Number(/run (\d+)/.exec(r.note ?? "")?.[1] ?? 0);
  const [j] = r.jobId ? await db.select().from(executorJobs).where(eq(executorJobs.id, r.jobId)) : [];
  const ms = Number((j?.result as Json | null)?.ms ?? 0) || null;
  if (runId) await db.update(runs).set({ status: "finished", outcome: output ? "output" : "aborted", durationMs: ms, finishedAt: new Date(), closingText: output ? JSON.stringify(output).slice(0, 4000) : problem, ...(output ? {} : { failureClass: "check_defect" }) }).where(eq(runs.id, runId));
  const cls = r.taskClass as SemanticClass;
  if (!output) {
    // a production output that fails its gate is discarded: the deterministic text stands, nothing is retried on the local model
    await db.insert(activity).values({ taskId: r.taskId, actor: "system", message: `${PURPOSE[cls]}: discarded - ${problem}. The recorded text stands.`, ref: { record: r.id, run: runId } });
    return;
  }
  const content = JSON.stringify(output, null, 1);
  const [a] = await db.insert(artifacts).values({ taskId: r.taskId, kind: "local-semantic", name: `${PURPOSE[cls]} (${r.model}, run ${runId})`, content, sha256: sha256(content), workerAuthored: true }).returning({ id: artifacts.id });
  const line = cls === "summarization" || cls === "log_summary" ? String(output.summary ?? "") : cls === "failure_triage" ? `${String(output.class)} - "${String(output.evidence ?? "").slice(0, 160)}"` : content.replace(/\s+/g, " ").slice(0, 300);
  await db.insert(activity).values({ taskId: r.taskId, actor: "system", message: `${PURPOSE[cls]}, advisory: ${line.slice(0, 600)}`, ref: { record: r.id, run: runId, artifact: a!.id, worker: r.worker, model: r.model } });
}
