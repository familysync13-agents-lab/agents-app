import { and, eq, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { heartbeats, projects, tasks } from "@/db/schema";
import { TaskCtx } from "./context";
import * as C from "./steps-contract";
import * as B from "./steps-build";
import * as V from "./steps-verify";
import * as D from "./steps-decision";
import * as M from "./steps-mutation";
import * as O from "./steps-oracle";
import * as A from "./steps-attribute";
import * as R from "./steps-regress";
import { awaitAccess, selfRecover } from "./common";
import { awaitQuota } from "./sessions";
import * as P from "./steps-plan";
import { collectCandidates } from "./shadow";

type Step = (ctx: TaskCtx) => Promise<void>;

/** The control loop's step table. Every step is idempotent per tick and persists its cursor before side effects return. */
export const STEPS: Record<string, Step> = {
  draft_contract: C.assignKey,
  draft_start: C.draftStart,
  draft_poll: C.draftPoll,
  draft_collect: C.draftCollect,
  oracle_start: O.oracleStart,
  oracle_poll: O.oraclePoll,
  oracle_collect: O.oracleCollect,
  oracle_calibrate: O.oracleCalibrate,
  await_owner_contract: C.awaitOwnerContract,
  contract_batch: C.contractBatch,
  batch_wait: C.batchWait,
  contract_pr: C.contractPr,
  await_github_contract: C.awaitGithubContract,
  contract_merge: C.contractMerge,
  build_start: B.buildStart,
  build_poll: B.buildPoll,
  build_collect: B.buildCollect,
  ship: B.ship,
  await_gate: B.awaitGate,
  gate_collect: B.gateCollect,
  fix_start: B.fixStart,
  acceptance_start: V.acceptanceStart,
  acceptance_poll: V.acceptancePoll,
  acceptance_collect: V.acceptanceCollect,
  attribute_start: A.attributeStart,
  attribute_poll: A.attributePoll,
  attribute_collect: A.attributeCollect,
  regate: A.regate,
  regress_start: R.regressStart,
  regress_poll: R.regressPoll,
  regress_pr: R.regressPr,
  resume_after_oracle: B.resumeAfterOracle,
  sync_branch: B.syncBranch,
  mutation_start: M.mutationStart,
  mutation_poll: M.mutationPoll,
  mutant_eval: M.mutantEval,
  mark_done: B.markDone,
  await_stack: B.awaitStack,
  restack: B.restack,
  await_acceptance: B.awaitAcceptance,
  cleanup: B.cleanup,
  await_decision: D.awaitDecision,
  await_access: awaitAccess,
  self_recover: selfRecover,
  await_quota: awaitQuota,
  await_dependency: B.awaitDependency,
  plan_start: P.planStart,
  plan_poll: P.planPoll,
  plan_collect: P.planCollect,
  plan_pr: P.planPr,
  plan_merge: P.planMerge,
  plan_task_done: P.planTaskDone,
  done: async () => {},
};

/** One pass over every active task. Errors in one task never stop the others; they are recorded on the task. */
export async function tick(db: Db, now: () => Date = () => new Date()): Promise<{ advanced: number; errors: number }> {
  const active = await db
    .select()
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(projects.active, true), notInArray(tasks.step, ["done"]), isNull(tasks.pausedAt)))
    .orderBy(tasks.id);
  let advanced = 0;
  let errors = 0;
  try {
    await collectCandidates(db); // shadow / harness results are only recorded; they never affect a task
  } catch {
    /* qualification bookkeeping must never disturb the control loop */
  }
  for (const row of active) {
    // re-read the task: an earlier task in this tick may have changed it (a batch leader assigning its members, a stack child
    // accepting its parent) - never act on a stale snapshot
    const [fresh] = await db.select().from(tasks).where(eq(tasks.id, row.tasks.id));
    if (!fresh || fresh.step === "done" || fresh.pausedAt) continue;
    const ctx = new TaskCtx(db, fresh, row.projects, now);
    // run a few steps per tick so that instantaneous transitions do not wait a whole tick each
    for (let i = 0; i < 6; i++) {
      const before = `${ctx.task.step}|${JSON.stringify(ctx.task.stepData)}|${ctx.task.state}`;
      const fn = STEPS[ctx.task.step];
      if (!fn) {
        await ctx.log("system", `Unknown step ${ctx.task.step}`, {});
        errors++;
        break;
      }
      try {
        await fn(ctx);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        const last = ctx.data.lastError as string | undefined;
        if (last !== msg) {
          await ctx.log("system", `Control-loop error in step ${ctx.task.step}: ${msg.slice(0, 300)}`, {});
          await ctx.setData({ lastError: msg });
        }
        break;
      }
      const after = `${ctx.task.step}|${JSON.stringify(ctx.task.stepData)}|${ctx.task.state}`;
      if (after === before) break;
      advanced++;
    }
  }
  await db
    .insert(heartbeats)
    .values({ name: "worker", at: now(), info: { tasks: active.length } })
    .onConflictDoUpdate({ target: heartbeats.name, set: { at: now(), info: { tasks: active.length } } });
  return { advanced, errors };
}
