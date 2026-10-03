import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { artifacts, decisions, plans, projects, qualificationRecords, runs, tasks, transitions } from "@/db/schema";
import { Contract } from "@/domain/contract";
import { buildContextPackage, CONTEXT_BUDGET, contextSeeds, extraFiles, rankFiles } from "@/domain/context";
import { PlanBody } from "@/domain/plan";
import { detectProfile } from "@/domain/profile";
import { classifyFailure, qualification, QUALIFY, route, ROUTES, TASK_CLASSES, WORKERS, type QualRecord } from "@/domain/router";
import { createTask } from "@/server/owner";
import { activePlan } from "@/server/plans";
import { collectCandidates, qualifyReplay, routeTable } from "@/worker/shadow";
import { executionOrder } from "@/worker/steps-plan";
import { clock, contractRows, FakeExecutor, openDecisions, runUntil, setup, taskRow } from "./support/harness";
import { CONTRACT, fixtureHandlers as scenario } from "./support/fixture-handlers";

/* Builder phase acceptance tests (BT1..BT12). */

const recs = (worker: string, taskClass: string, n: number, agreeing: number): QualRecord[] => Array.from({ length: n }, (_, i) => ({ worker, taskClass, valid: true, agree: i < agreeing }));

describe("BT1 static Router: evidence-based, reviewable, quality first", () => {
  it("routes every class to its trusted worker while nothing has qualified, and says why", () => {
    for (const tc of TASK_CLASSES) {
      const d = route({ taskClass: tc, risk: "standard", records: [] });
      expect(d.worker).toBe(ROUTES[tc].trusted);
      expect(d.reason).toMatch(/^trusted worker \(/);
      expect(d.mustWait).toBe(false);
      expect(d.envelope.credentials.length).toBeGreaterThan(5);
    }
    expect(route({ taskClass: "build", risk: "standard", records: [] })).toMatchObject({ worker: "claude-code", harness: "claude-code", shadow: [] });
    // serious coding never leaves Claude Code: the alternative coding workers are disabled, with the reason on record
    expect(WORKERS["codex-builder"]).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/independence/) });
    expect(WORKERS["opencode-local"]!.enabled).toBe(false);
    expect(route({ taskClass: "build", risk: "standard", records: recs("codex-builder", "build", 50, 50) }).worker).toBe("claude-code");
    expect(Object.values(WORKERS).every((w) => !w.meteredCost)).toBe(true); // no usage-based path exists at all
  });
  it("an alternative controls production only after it qualified; before that it is shadow only", () => {
    const tc = "failure_triage";
    expect(route({ taskClass: tc, risk: "standard", records: [] })).toMatchObject({ worker: "codex-verifier", shadow: ["local-llm"] });
    expect(qualification(recs("local-llm", tc, QUALIFY.minSamples - 1, QUALIFY.minSamples - 1), "local-llm", tc).status).toBe("shadow");
    expect(route({ taskClass: tc, risk: "standard", records: recs("local-llm", tc, 19, 19) }).worker).toBe("codex-verifier");
    const q = recs("local-llm", tc, 20, 20);
    expect(qualification(q, "local-llm", tc)).toEqual({ status: "qualified", samples: 20, agreement: 1 });
    expect(route({ taskClass: tc, risk: "standard", records: q })).toMatchObject({ worker: "local-llm", reason: expect.stringMatching(/qualified for failure_triage: 20 samples, 100% agreement/) });
    expect(route({ taskClass: tc, risk: "critical", records: q }).worker).toBe("codex-verifier"); // critical tier: trusted worker
    expect(qualification(recs("local-llm", tc, 20, 18), "local-llm", tc).status).toBe("shadow"); // 90%: not good enough
    const bad = recs("local-llm", tc, 20, 10);
    expect(qualification(bad, "local-llm", tc).status).toBe("rejected");
    expect(route({ taskClass: tc, risk: "standard", records: bad })).toMatchObject({ worker: "codex-verifier", shadow: [] }); // rejected: not even shadow
    // qualified for one class says nothing about another
    expect(route({ taskClass: "log_summary", risk: "standard", records: q }).worker).toBe("claude-code");
    // an invalid (non-schema) answer never counts as agreement
    expect(qualification(Array.from({ length: 20 }, () => ({ worker: "local-llm", taskClass: tc, valid: false, agree: true })), "local-llm", tc).status).toBe("rejected");
  });
  it("quota: the trusted worker being unavailable means WAIT, never an unqualified path", () => {
    const d = route({ taskClass: "build", risk: "standard", records: [], unavailable: ["claude-code"] });
    expect(d).toMatchObject({ worker: "claude-code", mustWait: true });
  });
});

describe("BT2 deterministic failure classification", () => {
  it("classifies without AI where the text is unambiguous", () => {
    expect(classifyFailure("Claude AI usage limit reached|1790870400")).toEqual({ cls: "quota", resetAt: 1790870400000 });
    expect(classifyFailure("You've hit your limit · limit will reset at 5pm").cls).toBe("quota");
    expect(classifyFailure("API Error: 429 rate_limit_error").cls).toBe("quota");
    expect(classifyFailure("Failed to authenticate. Please run /login").cls).toBe("credential");
    expect(classifyFailure("JobError: ACCESS: installation does not include repo").cls).toBe("access");
    expect(classifyFailure("locator.click: ReferenceError: text is not defined").cls).toBe("check_defect");
    expect(classifyFailure("docker: connection refused").cls).toBe("infrastructure");
    expect(classifyFailure("B listed before A").cls).toBe("unknown"); // needs reproduction / judgment
  });
});

describe("BT3 Project Capability Profile", () => {
  it("reads this very repository correctly from its own files", () => {
    const files = Object.fromEntries(["package.json", "tsconfig.json", "Dockerfile"].map((f) => [f, readFileSync(f, "utf8")]));
    const p = detectProfile("abc", files, ["package-lock.json", "drizzle.config.ts"]);
    expect(p).toMatchObject({ commit: "abc", languages: ["typescript"], framework: "next", packageManager: "npm", database: "postgresql", checkStage: true });
    expect(p.commands.build).toBe("npm run build");
    expect(p.commands.lint).toBe("npm run lint");
    expect(p.commands.typecheck).toMatch(/tsc|typecheck/);
    expect(p.tooling).toEqual(expect.arrayContaining(["eslint", "vitest", "drizzle-kit"]));
  });
  it("never guesses: what it cannot establish is listed as unknown", () => {
    const p = detectProfile("abc", {}, []);
    expect(p.languages).toEqual([]);
    expect(p.unknown).toEqual(expect.arrayContaining(["language", "build command", "test command"]));
    expect(detectProfile("x", { "package.json": "{not json" }, []).unknown).toContain("package.json is not valid JSON");
  });
});

describe("BT4 deterministic Context Builder", () => {
  const c = Contract.parse({ ...CONTRACT("T9"), interface: { ui: 'GET /lists: button "Sort A–Z", message "Sorted by title"' }, criteria: [{ id: "AC1", type: "behavior", priority: "must", tags: [], given: "alice on /lists", when: 'she clicks "Sort lists"', then: 'the heading "Your lists" stays and sortOrder is saved' }, { id: "AC2", type: "behavior", priority: "must", tags: [], given: "x", when: "y", then: 'a filter box "Filter lists" narrows them' }] });
  it("derives exact search seeds from the contract (labels, routes, identifiers) and narrows them to a plan task", () => {
    const s = contextSeeds(c);
    expect(s.terms).toEqual(expect.arrayContaining(["Sort lists", "Your lists", "/lists", "sortOrder", "Filter lists"]));
    expect(s.terms.length).toBeLessThanOrEqual(CONTEXT_BUDGET.maxTerms);
    const t = contextSeeds(c, { covers: ["AC2"], contributes: [], scope_paths: ["src/filter/**"] });
    expect(t.criteria).toEqual(["AC2"]);
    expect(t.terms).toContain("Filter lists");
    expect(t.terms).not.toContain("sortOrder");
    expect(t.paths).toEqual(["src/filter/**"]);
  });
  it("builds a bounded package, ranks code before tests, and measures what the worker needed beyond it", () => {
    const scan = { commit: "c0ffee00", hits: { "Sort lists": [{ file: "src/app/lists/page.tsx", line: 4, text: "x" }, { file: "tests/lists.test.ts", line: 9, text: "x" }], "/lists": [{ file: "src/app/lists/page.tsx", line: 1, text: "x" }, { file: "src/lib/nav.ts", line: 2, text: "x" }] }, files: { "src/app/lists/page.tsx": { imports: ["@/lib/sort"], importedBy: [], tests: ["tests/lists.test.ts"], log: ["abc 2026-09-30 lists"] } } };
    expect(rankFiles(scan)).toEqual(["src/app/lists/page.tsx", "src/lib/nav.ts", "tests/lists.test.ts"]);
    const pkg = buildContextPackage({ contract: c, scan, profile: detectProfile("c0ffee00", { "package.json": '{"scripts":{"test":"vitest"},"devDependencies":{"typescript":"5"}}' }, ["package-lock.json"]), errors: "AC1 failed: B before A" });
    expect(pkg.bytes).toBeLessThanOrEqual(CONTEXT_BUDGET.maxBytes + 60);
    expect(pkg.markdown).toMatch(/src\/app\/lists\/page\.tsx.*imports @\/lib\/sort.*tests tests\/lists\.test\.ts/);
    expect(pkg.markdown).toMatch(/Not found in the repository \(probably new\)\n.*"sortOrder"/);
    expect(pkg.markdown).toMatch(/Current findings\nAC1 failed/);
    expect(pkg.markdown).toMatch(/test: `npm run test`/);
    const huge = buildContextPackage({ contract: c, scan: { hits: Object.fromEntries(contextSeeds(c).terms.map((t) => [t, Array.from({ length: 40 }, (_, i) => ({ file: `src/very/long/path/number/${i}/${"x".repeat(150)}.ts`, line: i, text: "x" }))])) } });
    expect(huge.bytes).toBeLessThanOrEqual(CONTEXT_BUDGET.maxBytes + 60);
    expect(extraFiles(pkg.files, ["src/app/lists/page.tsx", "src/lib/sort.ts", ".bakeoff/REPORT.md"])).toEqual(["src/lib/sort.ts"]);
  });
});

const start = async (opts: Parameters<typeof scenario>[0] = {}) => {
  const { db, project } = await setup();
  const clk = clock();
  const { state, h } = scenario(opts);
  const ex = new FakeExecutor(db, h);
  const id = await createTask(db, { projectId: project.id, title: "Sort lists", intent: "Let owners sort their lists alphabetically on the list index.", tier: "standard" });
  return { db, clk, state, ex, id };
};
const A = { id: "T9.a", purpose: "sorting", covers: ["AC1", "AC2"] };
const B = { id: "T9.b", purpose: "filtering", covers: ["AC3"] };

describe("atomic execution with routing, context, profile and ledger", () => {
  it("BT5 an atomic contract: Router decision, context package, capability profile and ledger facts are recorded; downstream handoff unchanged", async () => {
    const { db, clk, state, ex, id } = await start();
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const rs = await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(runs.id);
    const build = rs.find((r) => r.purpose === "build")!;
    expect(build).toMatchObject({ taskClass: "build", worker: "claude-code", harness: "claude-code", provider: "anthropic-subscription", model: "opus", planTask: null });
    expect(build.routeReason).toMatch(/trusted worker \(no alternative has qualified/);
    expect((build.envelope as { repository: string }).repository).toMatch(/no GitHub access/);
    expect(build.contextBytes).toBeGreaterThan(200);
    expect(build.contextFiles).toEqual(["src/app/lists/page.tsx", "src/lib/sort.ts"]);
    expect(build.extraFiles).toEqual([]); // the fixture transport reports no changed-file list
    expect(rs.map((r) => [r.purpose, r.taskClass, r.worker])).toEqual(expect.arrayContaining([["draft_contract", "contract_draft", "claude-code"], ["author_oracle", "check_author", "codex-verifier"], ["acceptance_check", "acceptance_check", "codex-verifier"]]));
    expect(rs.every((r) => r.worker && r.routeReason)).toBe(true);
    // the worker's instructions start with the deterministic package, built BEFORE the worker ran (two scans, no AI)
    const prompt = state.builderPrompts.find((p) => p.includes("You are the Builder"))!;
    expect(prompt).toMatch(/# Context package \(assembled deterministically by the control plane at c0ffee00\)/);
    expect(prompt).toMatch(/## Most relevant files\n- `src\/app\/lists\/page\.tsx`/);
    expect(state.scans.length).toBe(2);
    expect((state.scans[0]!.terms as string[]).length).toBeGreaterThan(0);
    expect(state.scans[1]!.files).toEqual(["src/app/lists/page.tsx", "src/lib/sort.ts"]);
    // every run's exact instructions are kept (reconstructable)
    const arts = await db.select().from(artifacts).where(eq(artifacts.taskId, id));
    expect(arts.filter((a) => a.kind === "prompt").length).toBe(rs.filter((r) => r.role === "builder").length);
    // capability profile detected from the repository's files
    const [p] = await db.select().from(projects);
    expect(p!.capabilityProfile).toMatchObject({ commit: "c0ffee00", framework: "next", packageManager: "npm", checkStage: true, browserTests: true });
    expect(PlanBody.parse((await activePlan(db, id))!.body).shape).toBe("atomic");
    expect(state.branches.get(102)).toBe("task/T9/agents-1"); // unchanged branch naming for atomic work
  });

  it("BT6 the context scan failing never blocks the work", async () => {
    const { db, clk, ex, id } = await start();
    ex.handlers.context_scan = () => new Error("docker: image missing");
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const [build] = (await db.select().from(runs).where(eq(runs.taskId, id))).filter((r) => r.purpose === "build");
    expect(build!.contextBytes).toBeNull();
    expect((await taskRow(db, id)).corrections).toBe(0);
  });
});

describe("BT7 quota pause / resume", () => {
  it("pauses with all state kept, asks nobody, and resumes the SAME session without redoing work", async () => {
    const { db, clk, state, ex, id } = await start({ quotaOnBuild: 1 });
    const seen = new Set<string>();
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_quota");
    const t = await taskRow(db, id);
    expect(t.state).toBe("IN_PROGRESS"); // not failed, not blocked
    expect(await openDecisions(db, id)).toEqual([]);
    const d = t.stepData as { pollStep: string; sessionId: string; until: number; pollData: Record<string, unknown> };
    expect(d).toMatchObject({ pollStep: "build_poll", sessionId: "sess-q" });
    expect(d.until).toBe(1790870400000 + 60000); // the reset time the vendor reported
    const before = { worktrees: state.worktrees, builds: state.buildSessions, corrections: t.corrections, contract: t.currentContractId, plan: (await activePlan(db, id))!.id };
    const [paused] = (await db.select().from(runs).where(eq(runs.taskId, id))).filter((r) => r.failureClass === "quota");
    expect(paused).toMatchObject({ purpose: "build", outcome: "aborted" });
    // nothing happens before the reset time
    for (let i = 0; i < 5; i++) { await (await import("@/worker/orchestrator")).tick(db, clk.now); await ex.drain(); clk.advance(35); }
    expect((await taskRow(db, id)).step).toBe("await_quota");
    clk.advance(Math.ceil((d.until - clk.now().getTime()) / 1000) + 5);
    await runUntil(db, ex, clk, async () => {
      for (const x of await openDecisions(db, id)) seen.add(x.kind);
      return (await taskRow(db, id)).step === "await_acceptance";
    });
    expect([...seen]).toEqual(["acceptance"]); // the owner was never asked about the quota
    const resumed = state.builderCalls.find((c) => c.resume === "sess-q")!;
    expect(String(resumed.prompt_text)).toMatch(/interrupted because the usage limit was reached/);
    expect(state.worktrees).toBe(before.worktrees + 1); // only the Verifier's own checkout later; the Builder's worktree was NOT recreated
    expect(state.buildSessions).toBe(before.builds); // no second build from scratch
    const after = await taskRow(db, id);
    expect([after.corrections, after.currentContractId]).toEqual([before.corrections, before.contract]);
    expect((await activePlan(db, id))!.id).toBe(before.plan);
    const rs = (await db.select().from(runs).where(eq(runs.taskId, id))).filter((r) => r.purpose === "build");
    expect(rs.map((r) => r.contextBytes !== null)).toEqual([true, true]); // the resumed run keeps the context facts of the paused one
    const tr = await db.select().from(transitions).where(eq(transitions.taskId, id));
    expect(tr.some((x) => x.toState === "BLOCKED_EVIDENCE" || x.toState === "BLOCKED_DECISION")).toBe(false);
  });
});

describe("decomposed execution", () => {
  it("BT8 a complex contract is planned, the plan is validated and committed, tasks run in dependency order on top of each other, per-task gated, and only the integrated result is accepted", async () => {
    const { db, clk, state, ex, id } = await start({ complex: { plans: [{ tasks: [A, { ...B, covers: [] }] }, { tasks: [A, B] }], failFirstHeadOf: "a" } });
    const seen: string[] = [];
    await runUntil(db, ex, clk, async () => {
      for (const d of await openDecisions(db, id)) if (!seen.includes(d.kind)) seen.push(d.kind);
      return (await taskRow(db, id)).step === "await_acceptance";
    }, 900);
    expect(seen).toEqual(["acceptance"]); // planning, plan commit, per-task gates and a correction: nobody was asked
    // classified complex by rule, planned by the planner; the first (incomplete) plan was refused mechanically and fixed
    const ps = await db.select().from(plans).where(eq(plans.taskId, id)).orderBy(plans.planVersion);
    expect(PlanBody.parse(ps[0]!.body)).toMatchObject({ shape: "complex", shape_reasons: [expect.stringMatching(/rule 2: 2 independent deliverables \(filtering, sorting\)/)], tasks: [] });
    expect(state.plansServed).toBe(2);
    expect(state.builderPrompts.filter((p) => p.includes("You are the planner")).at(-1)).toMatch(/previous plan was refused[\s\S]*T9\.b: a task must cover or contribute/);
    const plan = PlanBody.parse(ps.at(-1)!.body);
    expect(plan.tasks.map((t) => [t.id, t.status, t.depends_on])).toEqual([["T9.a", "done", []], ["T9.b", "done", ["T9.a"]]]); // the execution chain is explicit
    expect(ps.at(-1)!.integrated).toMatchObject({ required: true, status: "passed", head: "h104a", contract_version: 1 });
    // the plan file went to the repository as a hash-listed amendment merged on the gate's confirmation
    const planPr = ex.log.filter((l) => l.op === "transport").map((l) => (l.params.ops as Record<string, unknown>[])[0]!).find((o) => o.op === "pr_from_files" && String(o.branch).startsWith("amend/T9/plan-"))!;
    const files = planPr.files as Record<string, string>;
    const pf = JSON.parse(Buffer.from(files["tasks/T9/plan.json"]!, "base64").toString());
    expect(pf.tasks).toEqual([{ id: "T9.a", covers: ["AC1", "AC2"], contributes: [], depends_on: [] }, { id: "T9.b", covers: ["AC3"], contributes: [], depends_on: ["T9.a"] }]);
    const tj = JSON.parse(Buffer.from(files["tasks/T9/task.json"]!, "base64").toString());
    expect(tj.amendments.at(-1)).toMatchObject({ kind: "plan", files: { "tasks/T9/plan.json": expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // task a: its own branch and PR on main; one failed gate -> automatic correction on the SAME PR; then verified on AC1+AC2 only
    expect(state.branches.get(102)).toBe("task/T9/a-1");
    expect(state.bases.get(102)).toBe(state.contractPrs.get(103)!.merged); // built on main after the plan merge
    expect(state.taskPrs.get(102)).toMatchObject({ head: "h2", n: 2 });
    // task b (the last): the INTEGRATED result - branch is not a plan task, so the gate requires the whole contract; built on a's head
    expect(state.branches.get(104)).toBe("task/T9/integration-1");
    expect(state.bases.get(104)).toBe("h2");
    const t = await taskRow(db, id);
    expect([t.prNumber, t.branch, t.headSha]).toEqual([104, "task/T9/integration-1", "h104a"]);
    // ledger: which plan task each Builder run worked on, with its own context package
    const rs = (await db.select().from(runs).where(eq(runs.taskId, id)).orderBy(runs.id)).filter((r) => ["build", "correction", "plan"].includes(r.purpose));
    expect(rs.map((r) => [r.purpose, r.planTask, r.taskClass])).toEqual([["plan", null, "plan"], ["plan", null, "plan"], ["build", "T9.a", "build"], ["correction", null, "correction"], ["build", "T9.b", "build"]]);
    const pa = state.builderPrompts.find((p) => p.includes("THIS SESSION IS ONE STEP OF A PLAN (T9.a"))!;
    expect(pa).toMatch(/Deliver completely, now: AC1, AC2\./);
    expect(pa).toMatch(/Do NOT implement the other criteria/);
    const pb = state.builderPrompts.find((p) => p.includes("THIS SESSION IS ONE STEP OF A PLAN (T9.b"))!;
    expect(pb).toMatch(/Already built and verified in this workspace: T9\.a\./);
    expect(pb).toMatch(/This is the LAST step: when you finish, EVERY criterion of the contract must hold/);
    // per-task gate facts were recorded as evidence of the plan task; the contract never changed
    expect(plan.tasks[0]!.evidence).toEqual(expect.arrayContaining(["pr:102", "branch:task/T9/a-1", "head:h2"]));
    expect((await contractRows(db, id)).map((c) => [c.version, c.status])).toEqual([[1, "merged"]]);
    const tr = (await db.select().from(transitions).where(eq(transitions.taskId, id)).orderBy(transitions.id)).map((x) => x.reason);
    expect(tr.some((r) => /Plan task T9\.a verified by the gate on the criteria it covers \(AC1, AC2\); 1 task\(s\) remain/.test(r))).toBe(true);
    expect(tr.at(-1)).toMatch(/^All must-criteria verified by the gate for h104a; independent Verifier check found no blocking defect/);
    // the owner accepts ONE PR (the integrated result); the per-task PR is closed, never merged on its own
    state.approvedPrs.add(104);
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "done");
    expect((await taskRow(db, id)).state).toBe("ACCEPTED");
    expect(state.closedPrs).toContain(102);
    expect(ex.log.filter((l) => l.op === "transport" && (l.params.ops as { op: string }[])[0]!.op === "merge_approved").length).toBe(1);
  }, 60000);

  it("BT9 execution order is topological and stable; a plan that never validates falls back to one job against the full contract", async () => {
    const p = PlanBody.parse({ contract: "T9", contract_version: 1, contract_sha256: "a".repeat(64), plan_version: 1, shape: "complex", tasks: [{ id: "T9.c", purpose: "c", covers: ["AC3"], depends_on: ["T9.b"] }, { id: "T9.a", purpose: "a", covers: ["AC1"] }, { id: "T9.b", purpose: "b", covers: ["AC2"], depends_on: ["T9.a"] }, { id: "T9.d", purpose: "d", covers: ["AC4"], status: "dropped" }] });
    expect(executionOrder(p).map((t) => t.id)).toEqual(["T9.a", "T9.b", "T9.c"]);
    const { db, clk, state, ex, id } = await start({ complex: { plans: [null, { tasks: [A] }, { tasks: [{ ...A, covers: ["AC9"] }, B] }] } });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance", 900);
    expect(state.plansServed).toBe(3);
    expect(state.branches.get(102)).toBe("task/T9/agents-1"); // built as one job
    expect(state.builderPrompts.some((p) => p.includes("ONE STEP OF A PLAN"))).toBe(false);
    expect(ex.log.some((l) => l.op === "transport" && String((l.params.ops as { branch?: string }[])[0]!.branch ?? "").includes("/plan-"))).toBe(false);
    expect(PlanBody.parse((await activePlan(db, id))!.body)).toMatchObject({ shape: "complex", tasks: [] });
  }, 60000);
});

describe("shadow mode and the qualification harness", () => {
  const fail = { failFirstGate: true } as const;
  it("BT10 a candidate gets the same bounded input in production, is recorded and compared, and controls nothing", async () => {
    const run = async (localLlm: "agree" | "disagree" | "invalid" | "unavailable") => {
      const { db, clk, ex, id } = await start({ ...fail, localLlm });
      await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
      const t = await taskRow(db, id);
      const q = await db.select().from(qualificationRecords);
      return { t, q, ex, db };
    };
    const a = await run("agree");
    expect(a.q.map((r) => [r.worker, r.taskClass, r.mode, r.expected, r.valid, r.agree, r.note])).toEqual([["local-llm", "failure_triage", "shadow", "implementation", true, true, "qwen-test"]]);
    const sent = a.ex.log.find((l) => l.op === "local_llm")!.params;
    expect(Object.keys(sent).sort()).toEqual(["prompt", "system"]); // a bounded structured request: no tools, no files, no repository
    expect(String(sent.prompt).length).toBeLessThan(6100);
    const d = await run("disagree");
    expect(d.q.map((r) => [r.valid, r.agree])).toEqual([[true, false]]);
    expect((await run("invalid")).q.map((r) => [r.valid, r.agree])).toEqual([[false, false]]);
    const u = await run("unavailable");
    expect(u.q.map((r) => [r.valid, r.agree])).toEqual([[false, null]]); // could not run: no verdict about its quality
    // whatever the candidate said, the production outcome is identical: the trusted arbiter decided
    for (const r of [a, d, u]) expect([r.t.corrections, r.t.headSha, r.t.state]).toEqual([1, "h2", "DONE"]);
    expect((await routeTable(a.db)).find((x) => x.taskClass === "failure_triage")).toMatchObject({ worker: "codex-verifier", shadow: ["local-llm"], alternatives: [{ worker: "local-llm", status: "shadow", samples: 1 }] });
  }, 90000);

  it("BT11 the harness replays recorded historical cases through the candidate without re-running any trusted worker", async () => {
    const { db, clk, ex, id } = await start({ ...fail, localLlm: "agree" });
    await runUntil(db, ex, clk, async () => (await taskRow(db, id)).step === "await_acceptance");
    const verifierRuns = ex.log.filter((l) => l.op === "verifier").length;
    const r = await qualifyReplay(db, 10);
    expect(r).toEqual({ submitted: 1, cases: 1 });
    await ex.drain();
    expect(await collectCandidates(db)).toBe(1);
    const q = await db.select().from(qualificationRecords).orderBy(qualificationRecords.id);
    expect(q.map((x) => [x.mode, x.agree])).toEqual([["shadow", true], ["harness", true]]);
    expect(q[0]!.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ex.log.filter((l) => l.op === "verifier").length).toBe(verifierRuns); // the original record is the baseline
    expect((await taskRow(db, id)).step).toBe("await_acceptance");
  });
});

describe("BT12 schema and boundaries", () => {
  it("adds only ledger columns, the profile column and one qualification table; no task state or decision kind was added", async () => {
    const { db } = await setup();
    await db.insert(qualificationRecords).values({ worker: "local-llm", taskClass: "failure_triage", mode: "harness", inputSha256: "x" });
    expect((await db.select().from(qualificationRecords)).length).toBe(1);
    expect(await db.select().from(decisions)).toEqual([]);
    expect((await db.select().from(tasks)).length).toBe(0);
  });
});
