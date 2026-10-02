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
    { id: "AC1", type: "behavior", priority: "must", tags: [], given: "alice with lists B, A", when: "she clicks Sort A–Z", then: "A is listed before B" },
    { id: "AC2", type: "experience", priority: "should", tags: [], statement: "Feels quick", refs: ["DESIGN"] },
  ],
  canary_routes: ["/"],
  version: 1,
});

const ORACLE = `import { chromium } from 'playwright';\nconst base = process.argv[2];\nconsole.log(JSON.stringify({ criterion: 'AC1', result: 'pass' }));\n`;

export function fixtureHandlers(opts: { draftBlocked?: boolean; draftBlockedTwice?: boolean; smokeDefectOnce?: boolean; oracleCrash?: boolean; arbiter?: "implementation" | "oracle" | "environment"; regressFail?: boolean; badImport?: boolean; failFirstGate?: boolean; verifierHigh?: boolean; repoRequiresOwner?: boolean; rulesetRefusesMerge?: boolean; draftClass?: "routine"; sensitiveTag?: boolean } = {}) {
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
  };
  const heads = (pr: number, i: number) => (pr === 102 ? `h${i}` : `h${pr}${"abc"[i - 1]}`);
  const h: Record<string, Handler> = {
    pub: () => ({ "ls:bakeoff-c1": { "refs/heads/main": state.main } }),
    git_show: (p) => {
      if (p.tree) return { tree: { "tasks/T0/contract.json": "x", "tasks/T8/task.json": "y", "README.md": "z" } };
      const out: Record<string, unknown> = {};
      for (const path of p.paths as string[])
        out[path] = path.includes("T2/contract") ? b64('{"id":"T2"}') : path === "tasks/T2/task.json" ? b64(JSON.stringify({ id: "T2", checks: { AC1: "oracle:oracle/T2/check.mjs" }, amendments: [{ id: "A1" }] })) : path === "oracle/T2/check.mjs" ? b64(ORACLE) : null;
      return out;
    },
    worktree: () => ({ base_sha: state.main, files: 10 }),
    builder: (p) => {
      state.builderPrompts.push(String(p.prompt_text));
      const k = /\b(T[0-9]+)\b/.exec(String(p.prompt_text));
      if (k) {
        state.key = k[1]!;
        state.volKey.set(String(p.vol), k[1]!);
      }
      if ("prompt" in p) return new Error("prompt must not be passed as argv");
      const name = `bko-builder-v0-${++state.n}`;
      state.sessions.set(name, 0);
      return { detached: name };
    },
    verifier: (p) => {
      state.verifierPrompts.push(String(p.prompt ?? ""));
      const name = `bko-verifier-${++state.n}`;
      state.sessions.set(name, 0);
      return { detached: name };
    },
    session: (p) => {
      const name = String(p.name);
      const k = (state.sessions.get(name) ?? 0) + 1;
      state.sessions.set(name, k);
      if (k < 2) return { running: true };
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
        if ((opts.draftBlocked && state.drafts === 1) || (opts.draftBlockedTwice && state.drafts <= 2))
          out[".bakeoff/BLOCKED.json"] = b64(
            JSON.stringify({ type: "BLOCKED:DECISION", unknown: "Sort by title or by date?", options: [{ label: "By title", consequence: "A-Z" }, { label: "By date", consequence: "newest first" }], recommendation: "By title" }),
          );
        else {
          const cj = CONTRACT(state.volKey.get(vol) ?? state.key);
          if (opts.sensitiveTag) (cj.criteria[0]!.tags as string[]).push("security");
          out[".bakeoff/contract.json"] = b64(JSON.stringify(cj));
        }
      }
      if (paths.includes("out/check.mjs")) {
        state.oraclesAuthored++;
        out["out/check.mjs"] = b64(opts.badImport && state.oraclesAuthored === 1 ? `import _ from 'lodash';\n${ORACLE}` : ORACLE);
      }
      if (paths.includes(".bakeoff/REPORT.md")) out[".bakeoff/REPORT.md"] = b64("# Report\nImplemented sorting.");
      if (paths.includes("out/findings.json")) {
        state.verifierFindingsServed++;
        const high = opts.verifierHigh && state.verifierFindingsServed === 1;
        out["out/findings.json"] = b64(
          JSON.stringify({ findings: high ? [{ severity: "high", criterion: "T9:AC1", title: "Sort ignores case", expected: "a before B", observed: "B before a", repro: ["open /lists"] }] : [], checked: ["AC1"] }),
        );
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
          const failing = opts.failFirstGate && tp.head === "h1";
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
          return { m: { ok: true, merge_commit: Number(op.pr) === 102 ? "mt" : `mt${String(op.pr)}`, approval_at: "2026-10-01T12:00:00Z" } };
        }
        case "pr_from_worktree": {
          if (!(op.refuse as string[]).includes("tasks/**")) return new Error("protected paths must be refused");
          const key = /task\/(T[0-9]+)\//.exec(String(op.branch))![1]!;
          const pr = state.taskPrs.size === 0 ? 102 : 102 + 2 * state.taskPrs.size;
          state.taskPrs.set(pr, { key, head: heads(pr, 1), n: 1 });
          if (pr === 102) state.taskPrHead = "h1";
          return { pr: { ok: true, pr, head_sha: heads(pr, 1), base: op.base_sha } };
        }
        case "update_pr_from_worktree": {
          const [pr, tp] = [...state.taskPrs.entries()].find(([, v]) => String(op.branch).startsWith(`task/${v.key}/`))!;
          tp.n = 2;
          tp.head = heads(pr, 2);
          if (pr === 102) state.taskPrHead = tp.head;
          return { pr: { ok: true, head_sha: tp.head } };
        }
        case "update_branch": {
          // a branch that is already current with main cannot be updated (GitHub answers 422)
          if (opts.regressFail && ![...state.contractPrs.values()].slice(1).some((x) => x.merged)) return { u: { ok: false, status: 422, message: "already up to date" } };
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
      const failing = opts.failFirstGate && tp.head === "h1";
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
      if (!/m[0-9]$/.test(String(p.preview))) {
        // smoke run against main (feature absent): a correct check fails AC1; a defective one crashes
        state.smokeRuns++;
        const crash = opts.smokeDefectOnce && state.smokeRuns === 1;
        return { results: [{ criterion: "AC1", result: "fail", detail: crash ? "ReferenceError: text is not defined" : "no Sort control" }] };
      }
      return { results: [{ criterion: "T9:AC1", result: String(p.preview).endsWith("m0") ? "fail" : "pass" }] };
    },
  };
  return { state, h, handlers: h };
}

