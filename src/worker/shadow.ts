import type { Db } from "@/db/client";
import { qualification, ROUTES, route, TASK_CLASSES, WORKERS } from "@/domain/router";
import { qualRecords } from "./qualify";

/*
 * The Router's reviewable rule table for the ten primary task classes (the System page shows exactly these). The qualification
 * harness, Shadow Mode and the local-worker classes live in ./qualify.
 */
export { collectCandidates } from "./qualify";

/** For every primary task class: the worker that would run now and why, with the evidence. */
export async function routeTable(db: Db) {
  const records = await qualRecords(db);
  return TASK_CLASSES.map((tc) => {
    const d = route({ taskClass: tc, risk: "standard", records });
    return { taskClass: tc, worker: d.worker, reason: d.reason, shadow: d.shadow, alternatives: ROUTES[tc].alternatives.map((w) => ({ worker: w, enabled: WORKERS[w]!.enabled, disabledReason: WORKERS[w]!.disabledReason ?? null, ...qualification(records, w, tc) })) };
  });
}
