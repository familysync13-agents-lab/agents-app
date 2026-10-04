import type { Handler } from "./harness";

const b64 = (s: string) => Buffer.from(s).toString("base64");

export const CONTRACT = (key: string) => ({
  id: key,
  title: "Sort lists",
  traces_to: [`OWNER-INTENT-${key}`],
  tier: "standard",
  scope: { summary: "Owners can sort their lists alphabetically.", paths: ["**"] },
  non_goals: [],
  open_questions: [],
  interface: { ui: 'GET /lists: button "Sort A–Z"' },
  criteria: [
    { id: "AC1", type: "behavior", priority: "must", tags: [], given: "alice with lists B, A", when: "she clicks Sort A–Z", then: "A is listed before B", verify: "blackbox", trace: { source: "intent", ref: "Let owners" } },
    { id: "AC2", type: "experience", priority: "should", tags: [], statement: "Feels quick", refs: ["DESIGN"], trace: { source: "necessary", ref: "AC1: sorting must not feel slow" } },
  ],
  canary_routes: ["/"],
  version: 1,
});

const ORACLE = `import { chromium } from 'playwright';\nconst base = process.argv[2];\nconsole.log(JSON.stringify({ criterion: 'AC1', result: 'pass' }));\n`;

/** Gate phase fixture: a structural must proven by a repository fact, and one constraint of every verification path. */
export const V3_EXTRA = {
  criterion: { id: "AC3", type: "structural", priority: "must", tags: [], statement: "The sort order is defined in one module.", check: "repository fact", verify: "static", fact: { kind: "path_exists", path: "src/domain/sort.ts" }, trace: { source: "intent", ref: "sort their lists alphabetically" } },
  constraints: [
    { id: "C1", kind: "regression", statement: "Everything else on the list index stays as it is.", verify: "blackbox", trace: { source: "project", ref: "earlier accepted contracts" } },
    { id: "C2", kind: "prohibited", statement: "No database migration is added.", verify: "static", fact: { kind: "unchanged", paths: ["drizzle/**"] }, trace: { source: "necessary", ref: "AC1: sorting is a view of existing data" } },
    { id: "C3", kind: "design", statement: "Nothing is estimated or animated.", verify: "judgment", advisory: true, trace: { source: "intent", ref: "Let owners" } },
    { id: "C4", kind: "security", statement: "The sort parameter is never reflected unescaped.", verify: "blackbox", trace: { source: "necessary", ref: "AC1: the sort choice travels in the URL" } },
  ],
};

export function fixtureHandlers(opts: { repairUnchangedOnce?: boolean; v3?: { staticFailsFirst?: boolean }; verifierLegacy?: boolean; verifierSkips?: string[]; judgmentNo?: boolean; verifierExtra?: Record<string, unknown>[]; verifierBlocked?: { class: string; reason: string }; repro?: "reproduced" | "not_reproduced" | "none"; draftBlocked?: boolean; draftBlockedTwice?: boolean; smokeDefectOnce?: boolean; oracleCrash?: boolean; arbiter?: "implementation" | "oracle" | "environment"; regressFail?: boolean; badImport?: boolean; failFirstGate?: boolean; verifierHigh?: boolean; repoRequiresOwner?: boolean; rulesetRefusesMerge?: boolean; draftClass?: "routine"; sensitiveTag?: boolean; draftBlocks?: Record<string, unknown>[]; noTrace?: boolean; draftSequence?: { tag?: string; assumptions?: number; then?: string }[]; complex?: { plans: unknown[]; failFirstHeadOf?: string }; quotaOnBuild?: number; verifierQuota?: number; mainMovedOnce?: boolean; taskBehindOnce?: boolean; localLlm?: (p: Record<string, unknown>) => Record<string, unknown>; localCode?: (p: Record<string, unknown>) => Record<string, unknown>; verdicts?: (items: { id: string }[]) => { id: string; pass: boolean; reason: string }[] } = {}) {
  const state = {
    main: "m0",
    sessions: new Map<string, number>(),
    n: 0,
    contractPr: 0,
    taskPrHead: "",
    gateCalls: 0,
    refreshed: false,
    ownerApprovedContract: false,
    ownerApprovedTask: false,
    forceOwner: false,
    systemMerges: 0,
    ownerMerges: 0,
    drafts: 0,
    builderPrompts: [] as string[],
    verifierFindingsServed: 0,
    reproRuns: 0,
    smokeRuns: 0,
    key: "T9",
    contractPrs: new Map<number, { head: string; refreshed: boolean; files: string[]; merged?: string }>(),
    mainN: 0,
    updatedBranch: 0,
    oraclesAuthored: 0,
    verifierPrompts: [] as string[],
    volKey: new Map<string, string>(),
    taskPrs: new Map<number, { key: string; head: string; n: number }>(),
    runPr: new Map<number, number>(),
    approvedPrs: new Set<number>(),
    closedPrs: [] as number[],
    plansServed: 0,
    mainAdvanced: false,
    taskBehindServed: false,
    branches: new Map<number, string>(),
    bases: new Map<number, string>(),
    builderCalls: [] as Record<string, unknown>[],
    buildSessions: 0,
    worktrees: 0,
    scans: [] as Record<string, unknown>[],
    quotaServed: 0,
    quotaSessions: new Set<string>(),
    localCode: [] as Record<string, unknown>[],
    verifierFiles: new Map<string, Record<string, string>>(),
    verifierQuotaSessions: new Set<string>(),
  };
  const heads = (pr: number, i: number) => (pr === 102 ? `h${i}` : `h${pr}${"abc"[i - 1]}`);
  const h: Record<string, Handler> = {
    pub: () => ({ "ls:bakeoff-c1": { "refs/heads/main": state.main } }),
    git_show: (p) => {
      if (p.tree) return { tree: { "tasks/T0/contract.json": "x", "tasks/T8/task.json": "y", "README.md": "z" } };
      const out: Record<string, unknown> = {};
      for (const path of p.paths as string[])
        out[path] = opts.complex && path === "tasks/T9/task.json" && state.mainN > 0 ? b64(JSON.stringify({ id: "T9", checks: { AC1: "oracle:oracle/T9/check.mjs" }, amendments: [{ id: "A1", files: {} }] })) : path.includes("T2/contract") ? b64('{"id":"T2"}') : path === "tasks/T2/task.json" ? b64(JSON.stringify({ id: "T2", checks: { AC1: "oracle:oracle/T2/check.mjs" }, amendments: [{ id: "A1" }] })) : path === "oracle/T2/check.mjs" ? b64(ORACLE) : null;
      return out;
    },
    worktree: () => {
      state.worktrees++;
      return { base_sha: state.main, files: 10 };
    },
    context_scan: (p) => {
      state.scans.push(p);
      const files = (p.files as string[] | undefined) ?? [];
      if (files.length) return { ok: true, commit: "c0ffee00", files: Object.fromEntries(files.map((f) => [f, { imports: ["@/db/schema"], importedBy: ["src/app/lists/page.tsx"], tests: ["tests/lists.test.ts"], log: ["abc1234 2026-09-30 earlier change"] }])) };
      const terms = (p.terms as string[]) ?? [];
      return {
        ok: true,
        commit: "c0ffee00",
        files_total: 120,
        file_list: ["package.json", "tsconfig.json", "Dockerfile", "package-lock.json", "src/app/lists/page.tsx", "src/lib/sort.ts"],
        profile_files: { "package.json": JSON.stringify({ scripts: { build: "next build", test: "vitest run", lint: "eslint ." }, dependencies: { next: "16", "drizzle-orm": "1" }, devDependencies: { typescript: "5", vitest: "3", playwright: "1" } }), "tsconfig.json": "{}", Dockerfile: "FROM node AS check\nRUN npm test" },
        hits: Object.fromEntries(terms.map((t, i) => [t, i % 2 === 0 ? [{ file: "src/app/lists/page.tsx", line: 10 + i, text: `… ${t} …` }, { file: "src/lib/sort.ts", line: 3, text: t }] : []])),
      };
    },
    local_llm: (p) => (opts.localLlm ? opts.localLlm(p) : { ok: false, available: false, reason: "connection refused" }),
    local_code: (p) => {
      state.localCode.push(p);
      return opts.localCode ? opts.localCode(p) : { ok: false, stage: "prepare", reason: "no local model in this scenario" };
    },
    builder: (p) => {
      state.builderPrompts.push(String(p.prompt_text));
      state.builderCalls.push(p);
      const k = /\b(T[0-9]+)\b/.exec(String(p.prompt_text));
      if (k) {
        state.key = k[1]!;
        state.volKey.set(String(p.vol), k[1]!);
      }
      if ("prompt" in p) return new Error("prompt must not be passed as argv");
      const name = `bko-builder-v0-${++state.n}`;
      state.sessions.set(name, 0);
      if (/You are the Builder/.test(String(p.prompt_text)) && !p.resume) {
        state.buildSessions++;
        if (opts.quotaOnBuild && state.quotaServed < opts.quotaOnBuild) {
          state.quotaServed++;
          state.quotaSessions.add(name);
        }
      }
      return { detached: name };
    },
    verifier: (p) => {
      state.verifierPrompts.push(String(p.prompt ?? ""));
      state.verifierFiles.set(String(p.work_vol), (p.files ?? {}) as Record<string, string>);
      const name = `bko-verifier-${++state.n}`;
      state.sessions.set(name, 0);
      if (opts.verifierQuota && state.quotaServed < opts.verifierQuota) {
        state.quotaServed++;
        state.verifierQuotaSessions.add(name);
      }
      return { detached: name };
    },
    session: (p) => {
      const name = String(p.name);
      const k = (state.sessions.get(name) ?? 0) + 1;
      state.sessions.set(name, k);
      if (k < 2) return { running: true };
      if (state.verifierQuotaSessions.has(name)) return { exit: "1", tail: "", result: null, stderr_tail: "user\nYou are the blind Verifier ... usage limit is not the point\nERROR: You\u2019ve hit your usage limit. Upgrade to Pro, or try again at 6:06 AM.\n" };
      if (state.quotaSessions.has(name)) return { exit: "1", result: { session_id: "sess-q", is_error: true, num_turns: 7, duration_ms: 420000, result: "Claude AI usage limit reached|1790870400" } };
      return name.includes("builder")
        ? { exit: "0", result: { session_id: "sess-1", total_cost_usd: 1.25, num_turns: 12, duration_ms: 60000, result: "DONE" } }
        : { exit: "0", result: null, tail: "VERIFIER-DONE" };
    },
    dump: (p) => {
      const paths = p.paths as string[];
      const vol = String(p.vol);
      const out: Record<string, unknown> = Object.fromEntries(paths.map((x) => [x, null]));
      if (paths.includes(".bakeoff/contract.json")) {
        state.drafts++;
        if (opts.draftBlocks && state.drafts <= opts.draftBlocks.length) out[".bakeoff/BLOCKED.json"] = b64(JSON.stringify(opts.draftBlocks[state.drafts - 1]));
        else if ((opts.draftBlocked && state.drafts === 1) || (opts.draftBlockedTwice && state.drafts <= 2))
          out[".bakeoff/BLOCKED.json"] = b64(
            JSON.stringify({ type: "BLOCKED:DECISION", unknown: "Sort by title or by date?", options: [{ label: "By title", consequence: "A-Z" }, { label: "By date", consequence: "newest first" }], recommendation: "By title" }),
          );
        else {
          const cj = CONTRACT(state.volKey.get(vol) ?? state.key);
          if (opts.complex) {
            // two independent deliverables (rule 2): three must-criteria in two groups
            const c0 = cj.criteria[0] as Record<string, unknown>;
            (cj as { criteria: unknown[] }).criteria = [{ ...c0, group: "sorting" }, { ...c0, id: "AC2", then: "the choice is remembered", group: "sorting" }, { ...c0, id: "AC3", then: "a filter box narrows the lists", group: "filtering" }, { ...(cj.criteria[1] as Record<string, unknown>), id: "AC4" }];
          }
          if (opts.v3) {
            (cj as { criteria: unknown[] }).criteria = [...cj.criteria, V3_EXTRA.criterion];
            (cj as Record<string, unknown>).constraints = V3_EXTRA.constraints;
          }
          if (opts.sensitiveTag) (cj.criteria[0]!.tags as string[]).push("security");
          if (opts.noTrace) delete (cj.criteria[0] as { trace?: unknown }).trace;
          const sq = opts.draftSequence?.[Math.min(state.drafts, opts.draftSequence.length) - 1];
          if (sq) {
            if (sq.tag) (cj.criteria[0]!.tags as string[]).push(sq.tag);
            if (sq.then) (cj.criteria[0] as { then: string }).then = sq.then;
            if (sq.assumptions) (cj as Record<string, unknown>).assumptions = [{ id: "A1", question: "Case-sensitive?", chosen: "No", basis: "existing behaviour", reversible: true }];
            (cj as { version: number }).version = state.drafts;
          }
          out[".bakeoff/contract.json"] = b64(JSON.stringify(cj));
        }
      }
      if (paths.includes("out/check.mjs")) {
        state.oraclesAuthored++;
        // every authored version differs from the previous one - except a "repair" that returns the defective check unchanged
        const rev = state.oraclesAuthored > 1 && !(opts.repairUnchangedOnce && state.oraclesAuthored === 2) ? `${ORACLE}\n// revision ${state.oraclesAuthored}` : ORACLE;
        out["out/check.mjs"] = b64(opts.badImport && state.oraclesAuthored === 1 ? `import _ from 'lodash';\n${ORACLE}` : rev);
      }
      if (paths.includes(".bakeoff/plan.json") && opts.complex) {
        const pl = opts.complex.plans[Math.min(state.plansServed, opts.complex.plans.length - 1)];
        state.plansServed++;
        if (pl !== null) out[".bakeoff/plan.json"] = b64(JSON.stringify(pl));
      }
      if (paths.includes(".bakeoff/REPORT.md")) out[".bakeoff/REPORT.md"] = b64("# Report\nImplemented sorting.");
      if (paths.includes("out/findings.json") && /^agents-vw-0-q/.test(vol)) {
        const items = JSON.parse(Buffer.from(state.verifierFiles.get(vol)!["items.json"]!, "base64").toString()) as { id: string }[];
        out["out/findings.json"] = b64(JSON.stringify({ verdicts: opts.verdicts ? opts.verdicts(items) : items.map((x) => ({ id: x.id, pass: true, reason: "faithful" })) }));
      } else if (paths.includes("out/findings.json")) {
        state.verifierFindingsServed++;
        const high = opts.verifierHigh && state.verifierFindingsServed === 1;
        const ids = opts.complex ? ["AC1", "AC2", "AC3"] : opts.v3 ? ["AC1", "C1", "C4"] : ["AC1"];
        const finding = { id: "F1", severity: "high", class: "implementation", criterion: "T9:AC1", title: "Sort ignores case", expected: "a before B", observed: "B before a", repro: ["open /lists"], reproduced: 2 };
        out["out/findings.json"] = b64(
          opts.verifierLegacy
            ? JSON.stringify({ findings: high ? [{ severity: "high", criterion: "T9:AC1", title: "Sort ignores case", expected: "a before B", observed: "B before a", repro: ["open /lists"] }] : [], checked: ["AC1"] })
            : JSON.stringify({
                schema: 2,
                coverage: ids.filter((id) => !(opts.verifierSkips ?? []).includes(id)).map((id) => ({ criterion: id, verdict: high && id === "AC1" ? "violated" : "conforms", how: "opened /lists, clicked Sort A-Z, compared the order" })),
                judgments: opts.v3 ? [{ id: "C3", verdict: opts.judgmentNo && state.verifierFindingsServed === 1 ? "not_satisfied" : "satisfied", evidence: "Opened /lists three times: values were identical and static, no animation or estimate was shown.", reason: opts.judgmentNo && state.verifierFindingsServed === 1 ? "a progress animation is shown" : "only recorded values" }] : [],
                findings: [...(high ? [finding] : []), ...(opts.verifierExtra ?? [])],
                blocked: opts.verifierBlocked ?? null,
              }),
        );
        if (paths.includes("out/repro.mjs") && high && !opts.verifierLegacy && opts.repro !== "none") out["out/repro.mjs"] = b64(`// REPRO\nimport { chromium } from 'playwright';\nconsole.log(JSON.stringify({ criterion: 'F1', result: 'x' }));\n`);
      }
      if (paths.includes(".bakeoff/mutants.json"))
        out[".bakeoff/mutants.json"] = b64(
          JSON.stringify({
            mutants: [
              { criterion: "AC1", description: "sort descending", patch: "diff --git a/app/x.ts b/app/x.ts\n-a\n+b\n" },
              { criterion: "AC1", description: "swap title and author", patch: "diff --git a/app/y.ts b/app/y.ts\n-a\n+b\n" },
            ],
          }),
        );
      if (paths.includes("out/attribution.json"))
        out["out/attribution.json"] = b64(
          JSON.stringify({
            criteria: [{ criterion: opts.regressFail ? "T2:AC1" : "AC1", party: opts.arbiter ?? "implementation", observed: "B before a", expected: "a before B", reason: opts.arbiter === "oracle" ? "reads textContent across elements" : "the list is not sorted case-insensitively" }],
            summary: "reproduced",
          }),
        );
      void vol;
      return out;
    },
    export: () => ({ files: ["12"], credential_scan: { strings: 6, files: 12, hits: 0 } }),
    transport: (p) => {
      const op = (p.ops as Record<string, unknown>[])[0]!;
      switch (op.op) {
        case "pr_from_files": {
          const n = 101 + 2 * state.contractPrs.size;
          state.contractPr = n;
          state.contractPrs.set(n, { head: `hc${n}`, refreshed: false, files: Object.keys((op.files as Record<string, string>) ?? {}).sort() });
          return { pr: { ok: true, pr: n, head_sha: `hc${n}` } };
        }
        case "pr_state": {
          const cp = state.contractPrs.get(Number(op.pr));
          if (cp) {
            // default (V1 policy installed in the repository): the gate confirms a hash-bound amendment without a review.
            // repoRequiresOwner: the repository still demands the owner's review (the old trust model) until the test approves.
            const owner = opts.repoRequiresOwner || state.forceOwner;
            const approved = owner && state.ownerApprovedContract;
            return {
              s: {
                ok: true,
                head: cp.head,
                merged: !!cp.merged,
                merge_commit: cp.merged ?? null,
                reviews: approved ? [{ user: "owner1", state: "APPROVED", commit: cp.head, at: "2026-10-01T10:30:00Z" }] : [],
                gate_runs: [{ id: cp.refreshed ? 2 : 1, status: "completed", verdict: opts.repoRequiresOwner ? (cp.refreshed ? "AMENDMENT-OK" : "BLOCKED:DECISION") : "AMENDMENT-OK" }],
              },
            };
          }
          state.gateCalls++;
          const tp = state.taskPrs.get(Number(op.pr))!; if (!tp) return new Error(`unknown pr ${String(op.pr)} known ${[...state.taskPrs.keys()].join(",")} contract ${[...state.contractPrs.keys()].join(",")}`);
          const entryFail = !!opts.complex?.failFirstHeadOf && (state.branches.get(Number(op.pr)) ?? "").includes(`/${opts.complex.failFirstHeadOf}-`) && tp.n === 1;
          const failing = (opts.failFirstGate && tp.head === "h1") || entryFail;
          state.runPr.set(1000 + state.gateCalls, Number(op.pr));
          const approved = state.approvedPrs.has(Number(op.pr)) || (state.ownerApprovedTask && Number(op.pr) === 102);
          return {
            s: {
              ok: true,
              head: tp.head,
              merged: false,
              reviews: approved ? [{ user: "Owner1", state: "APPROVED", commit: tp.head, at: "2026-10-01T12:00:00Z" }] : [],
              gate_runs: [{ id: 1000 + state.gateCalls, status: "completed", verdict: failing ? (opts.regressFail ? "FAIL:REGRESSION" : "FAIL:ORACLE") : "DONE" }],
            },
          };
        }
        case "refresh_pr": {
          const cp = state.contractPrs.get(Number(op.pr));
          if (cp) cp.refreshed = true;
          state.refreshed = true;
          return { r: { ok: true } };
        }
        case "merge_system": {
          state.systemMerges++;
          if (opts.mainMovedOnce && state.systemMerges === 1) return { m: { ok: false, status: 405, message: 'Repository rule violations found\n\nRequired status check "gate" is expected.\n\n' } };
          if (opts.rulesetRefusesMerge) {
            state.forceOwner = true;
            return { m: { ok: false, status: 405, message: "Repository rule violations found" } };
          }
          state.mainN++;
          state.main = `m${state.mainN}`;
          state.contractPrs.get(Number(op.pr))!.merged = state.main;
          return { m: { ok: true, merge_commit: state.main } };
        }
        case "merge_approved": {
          state.ownerMerges++;
          if (state.contractPrs.has(Number(op.pr))) {
            state.mainN++;
            state.main = `m${state.mainN}`;
            state.contractPrs.get(Number(op.pr))!.merged = state.main;
            return { m: { ok: true, merge_commit: state.main, approval_at: "2026-10-01T10:30:00Z" } };
          }
          if (opts.taskBehindOnce && !state.taskBehindServed) {
            state.taskBehindServed = true;
            return { m: { ok: false, status: 405, message: 'Repository rule violations found\n\nRequired status check "gate" is expected.\n\n' } };
          }
          return { m: { ok: true, merge_commit: Number(op.pr) === 102 ? "mt" : `mt${String(op.pr)}`, approval_at: "2026-10-01T12:00:00Z" } };
        }
        case "pr_from_worktree": {
          if (!(op.refuse as string[]).includes("tasks/**")) return new Error("protected paths must be refused");
          const key = /task\/(T[0-9]+)\//.exec(String(op.branch))![1]!;
          const pr = state.taskPrs.size === 0 ? 102 : 102 + 2 * state.taskPrs.size;
          state.taskPrs.set(pr, { key, head: heads(pr, 1), n: 1 });
          state.branches.set(pr, String(op.branch));
          state.bases.set(pr, String(op.base_sha));
          if (pr === 102) state.taskPrHead = "h1";
          return { pr: { ok: true, pr, head_sha: heads(pr, 1), base: op.base_sha } };
        }
        case "update_pr_from_worktree": {
          const [pr, tp] = [...state.taskPrs.entries()].find(([n, v]) => (state.branches.get(n) ? state.branches.get(n) === String(op.branch) : String(op.branch).startsWith(`task/${v.key}/`)))!;
          tp.n = 2;
          tp.head = heads(pr, 2);
          if (pr === 102) state.taskPrHead = tp.head;
          return { pr: { ok: true, head_sha: tp.head } };
        }
        case "update_branch": {
          const cpr = state.contractPrs.get(Number(op.pr));
          if (cpr) {
            cpr.head = `${cpr.head}u`;
            state.updatedBranch++;
            return { u: { ok: true, head_sha: cpr.head } };
          }
          // a branch that is already current with main cannot be updated (GitHub answers 422)
          if (opts.regressFail && !state.mainAdvanced && ![...state.contractPrs.values()].slice(1).some((x) => x.merged)) return { u: { ok: false, status: 422, message: "already up to date" } };
          const tp = state.taskPrs.get(Number(op.pr))!;
          const old = tp.head;
          tp.head = heads(Number(op.pr), 3);
          if (Number(op.pr) === 102) state.taskPrHead = tp.head;
          state.updatedBranch++;
          return { u: { ok: true, old_head: old, head_sha: tp.head } };
        }
        case "cleanup":
          state.closedPrs.push(...((op.close as number[] | undefined) ?? []));
          return { c: { ok: true } };
        default:
          return new Error(`unexpected transport op ${String(op.op)}`);
      }
    },
    gate_evidence: (p) => {
      const pr = state.runPr.get(Number(p.check_run)) ?? 102;
      const tp = state.taskPrs.get(pr)!;
      const branch = state.branches.get(pr) ?? "";
      const entry = /^task\/T[0-9]+\/([a-z])-/.exec(branch)?.[1] ?? null;
      const failing = (opts.failFirstGate && tp.head === "h1") || (!!opts.complex?.failFirstHeadOf && branch.includes(`/${opts.complex.failFirstHeadOf}-`) && tp.n === 1);
      if (opts.complex) {
        // the real gate: a plan task (single-letter branch) is judged on the criteria it covers; anything else on the whole contract
        const plan = opts.complex.plans.find((x) => x && typeof x === "object" && Array.isArray((x as { tasks?: unknown[] }).tasks) && ((x as { tasks: { covers?: string[] }[] }).tasks.length ?? 0) > 1) as { tasks: { id: string; covers?: string[]; depends_on?: string[] }[] } | undefined;
        const by = new Map((plan?.tasks ?? []).map((t) => [t.id.split(".")[1]!, t]));
        const need = new Set<string>();
        const walk = (k: string) => {
          if (need.has(k) || !by.has(k)) return;
          need.add(k);
          for (const d of by.get(k)!.depends_on ?? []) walk(d.split(".")[1]!);
        };
        if (entry) walk(entry);
        const required = entry && by.has(entry) ? new Set([...need].flatMap((k) => by.get(k)!.covers ?? [])) : null;
        const criteria = Object.fromEntries(["AC1", "AC2", "AC3"].map((ac) => {
          const req = required === null || required.has(ac);
          return [`${tp.key}:${ac}`, { status: req ? (failing ? "Not verified" : "Verified") : "Deferred", check: `oracle:oracle/${tp.key}/check.mjs`, detail: req ? (failing ? "expected behaviour missing" : "") : "not yet required at this plan task (was: Not verified)" }];
        }));
        const verdict = failing ? "FAIL:ORACLE" : "DONE";
        return { verdict, evidence: { verdict, head_sha: tp.head, reasons: failing ? [`a must-criterion of ${tp.key} failed`] : [], criteria, regression: {}, checks: { plan_scope: { [tp.key]: required ? [...required].sort() : null } } }, check_run: p.check_run };
      }
      if (opts.v3) {
        // gate v3: every requirement judged by its verification class; a failing repository fact gives FAIL:STATIC
        const bad = !!opts.v3.staticFailsFirst && tp.head === "h1";
        const oracle = `oracle:oracle/${tp.key}/check.mjs`;
        const verdict = bad ? "FAIL:STATIC" : "DONE";
        return {
          verdict,
          evidence: {
            gate: "gate-v3", verdict, head_sha: tp.head, reasons: bad ? [`a repository fact required by ${tp.key} does not hold`] : [],
            criteria: {
              [`${tp.key}:AC1`]: { status: "Verified", check: oracle, detail: "", class: "blackbox", kind: "criterion" },
              [`${tp.key}:AC3`]: { status: bad ? "Not verified" : "Verified", check: "static:fact", detail: bad ? "src/domain/sort.ts does not exist in the repository" : "src/domain/sort.ts exists (1 file(s))", class: "static", kind: "criterion" },
              [`${tp.key}:C1`]: { status: "Verified", check: "regression-set", detail: "all 1 criteria of earlier accepted tasks hold at this head", class: "blackbox", kind: "constraint" },
              [`${tp.key}:C2`]: { status: "Verified", check: "static:fact", detail: "the change touches none of drizzle/**", class: "static", kind: "constraint" },
              [`${tp.key}:C3`]: { status: "Judgment", check: "judgment", detail: "decided by independent judgment with the captured evidence, not by the gate", class: "judgment", kind: "constraint" },
              [`${tp.key}:C4`]: { status: "Verified", check: oracle, detail: "", class: "blackbox", kind: "constraint" },
            },
            regression: { "T2:AC1": { status: "Verified", check: "oracle:oracle/T2/check.mjs", detail: "" } },
            checks: { requirements: { gate_version: 3, judgment_pending: [`${tp.key}:C3`], unbound: [], static: [`${tp.key}:AC3`, `${tp.key}:C2`] }, secret_scan: "gitleaks 0 finding(s)", secret_scan_findings: 0, osv: { vulnerabilities: 2, ids: ["GHSA-aaaa", "GHSA-bbbb"] }, opengrep: { findings: 0, rules: [], where: [] } },
          },
          check_run: p.check_run,
        };
      }
      return {
        verdict: failing ? (opts.regressFail ? "FAIL:REGRESSION" : "FAIL:ORACLE") : "DONE",
        evidence: {
          verdict: failing ? (opts.regressFail ? "FAIL:REGRESSION" : "FAIL:ORACLE") : "DONE",
          head_sha: tp.head,
          contract_sha256: undefined,
          reasons: failing ? [`a must-criterion of ${tp.key} failed`] : [],
          criteria: {
            [`${tp.key}:AC1`]: {
              status: failing && !opts.regressFail ? "Not verified" : "Verified",
              check: `oracle:oracle/${tp.key}/check.mjs`,
              detail: failing ? (opts.oracleCrash ? "locator.evaluate: ReferenceError: text is not defined" : "B listed before A") : "",
            },
          },
          regression: { "T2:AC1": { status: failing && opts.regressFail ? "Not verified" : "Verified", check: "oracle:oracle/T2/check.mjs", detail: failing && opts.regressFail ? "control must be outside the section" : "" } },
        },
        check_run: p.check_run,
      };
    },
    vol_export: () => ({ ok: true, files: 40 }),
    preview: (p) => (p.action === "up" ? { build_ok: true, health: "200 ok" } : { down: true }),
    vol_rm: () => ({ ok: true }),
    strip_oracles: () => ({ ok: true, removed: ["oracle", "baselines"] }),
    apply_patch: () => ({ ok: true }),
    // mutant 0 is caught by the oracle, mutant 1 survives (the bake-off's title/author swap)
    oracle_run: (p) => {
      if (String(p.oracle_js).startsWith("// REPRO")) {
        state.reproRuns++;
        return { results: [{ criterion: "F1", result: opts.repro === "not_reproduced" ? "pass" : "fail", detail: opts.repro === "not_reproduced" ? "A is listed before B" : "B before a" }] };
      }
      if (!/m[0-9]$/.test(String(p.preview))) {
        // smoke run against main (feature absent): a correct check fails AC1; a defective one crashes
        state.smokeRuns++;
        const crash = opts.smokeDefectOnce && state.smokeRuns === 1;
        if (opts.complex) return { results: ["AC1", "AC2", "AC3"].map((criterion) => ({ criterion, result: "fail", detail: "feature absent" })) };
        if (opts.v3) return { results: [{ criterion: "AC1", result: "fail", detail: "no Sort control" }, { criterion: "C4", result: "pass", detail: "nothing reflected" }] };
        return { results: [{ criterion: "AC1", result: "fail", detail: crash ? "ReferenceError: text is not defined" : "no Sort control" }] };
      }
      return { results: [{ criterion: "T9:AC1", result: String(p.preview).endsWith("m0") ? "fail" : "pass" }] };
    },
  };
  return { state, h, handlers: h };
}

