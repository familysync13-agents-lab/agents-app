import Link from "next/link";
import { FlowMap } from "@/components/flow-map";
import { ProposalsForm } from "@/components/forms";
import { LiveRefresh } from "@/components/live-refresh";
import { stepInfo } from "@/components/steps";
import { Ago, Card, CardHeader, Empty, RoleTag, StateChip, cx, type Role } from "@/components/ui";
import { failureRouting, flowState, nodeOf, NODE_LABEL, NODES, PARTY } from "@/domain/ops";
import { shortenTitle } from "@/domain/text";
import { commandCenter } from "@/server/queries";

export const metadata = { title: "Command" };

const DECISION_LABEL: Record<string, string> = {
  contract_approval: "Review contract",
  contract_github_approval: "Approve on GitHub",
  block: "Decide",
  budget: "Budget decision",
  acceptance: "Accept result",
};

const PARTY_TONE: Record<string, string> = {
  builder: "border-builder/40 bg-builder/10 text-builder",
  verifier: "border-verifier/40 bg-verifier/10 text-verifier",
  gate: "border-gate/40 bg-gate/10 text-gate",
  owner: "border-owner/40 bg-owner/10 text-owner",
  bad: "border-bad/40 bg-bad/10 text-bad",
};

const ACTOR_ROLE: Record<string, Role> = { system: "system", builder: "builder", verifier: "verifier", gate: "gate", owner: "owner", executor: "executor" };

export default async function Command() {
  const d = await commandCenter();
  const projectOf = new Map(d.projects.map((p) => [p.id, p]));
  const flow = flowState({
    live: d.live,
    running: d.running.map((r) => ({ taskId: r.taskId, purpose: r.purpose })),
    openDecisions: d.openDecisions.length,
    recentTransitions: d.recentTransitions,
    accepted: d.accepted.length,
  });
  const selfFixing = d.live.filter((t) => failureRouting(t, t.corrections)?.selfCorrecting).length;
  const workingNow = new Set(d.running.map((r) => r.taskId)).size;

  return (
    <div className="space-y-6">
      <LiveRefresh seconds={5} />

      {/* executive line: the answers the owner needs in seconds */}
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { k: "Needs you", v: d.openDecisions.length, tone: d.openDecisions.length ? "text-owner" : "text-ink" },
          { k: "Agents working now", v: workingNow, tone: workingNow ? "text-builder" : "text-ink" },
          { k: "Self-correcting", v: selfFixing, tone: selfFixing ? "text-verifier" : "text-ink" },
          { k: "Accepted", v: d.tasks.filter((t) => t.state === "ACCEPTED").length, tone: "text-ok" },
        ].map((x) => (
          <div key={x.k} className="rounded-2xl border border-line bg-panel/70 px-4 py-3">
            <div className="text-[11px] tracking-[0.16em] text-mute uppercase">{x.k}</div>
            <div className={cx("mt-1 text-2xl font-semibold tabular-nums", x.tone)}>{x.v}</div>
          </div>
        ))}
      </section>

      {d.openDecisions.length > 0 ? (
        <section aria-labelledby="needs-you" className="overflow-hidden rounded-2xl border border-owner/40 bg-owner/[0.06]">
          <div className="flex items-center gap-3 border-b border-owner/25 px-5 py-3">
            <span aria-hidden className="size-2 rounded-full bg-owner pulse-dot text-owner" />
            <h2 id="needs-you" className="text-sm font-semibold tracking-wide text-owner">
              Trust boundary - your decision is required
            </h2>
          </div>
          <ul className="divide-y divide-owner/15">
            {d.openDecisions.map(({ d: dec, t, p }) => (
              <li key={dec.id}>
                <Link href={`/tasks/${t.id}`} className="grid gap-1.5 px-5 py-3 hover:bg-owner/[0.06] sm:flex sm:flex-wrap sm:items-center sm:gap-x-4">
                  <span className="w-fit rounded-md border border-owner/50 bg-owner/15 px-2 py-0.5 text-xs font-semibold text-owner">{DECISION_LABEL[dec.kind] ?? dec.kind}</span>
                  <span className="min-w-0 text-sm font-medium sm:flex-1 sm:truncate" title={dec.title}>
                    {shortenTitle(dec.title)}
                  </span>
                  <span className="text-xs text-mute">
                    {p.name} · {t.key ?? "new"} · <Ago at={dec.createdAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.proposals.length > 0 ? (
        <Card>
          <CardHeader title="Proposed work" meta={`${d.proposals.length} proposal${d.proposals.length === 1 ? "" : "s"} from recorded evidence - you decide what starts`} />
          <ProposalsForm items={d.proposals.map(({ p, project }) => ({ id: p.id, title: p.title, intent: p.intent, rationale: p.rationale, project, source: p.source }))} />
        </Card>
      ) : null}

      <Card className="hud-surface overflow-hidden">
        <CardHeader
          title="Operational flow"
          meta={
            <span>
              live from the control loop · {d.live.length} active task{d.live.length === 1 ? "" : "s"}
            </span>
          }
        />
        <div className="px-3 py-4 sm:px-6">
          <FlowMap s={flow} label="Operational flow" />
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader title="Active work" meta={`${d.live.length} active`} />
          {d.live.length === 0 ? (
            <Empty>No active work. Record an intent in a project to start.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {d.live.map((t) => {
                const s = stepInfo(t.step);
                const runs = d.running.filter((r) => r.taskId === t.id);
                const role: Role = runs[0]?.role ?? (s.waitingOnOwner || t.step === "await_decision" ? "owner" : s.role);
                const node = nodeOf(t);
                const routing = failureRouting(t, t.corrections);
                const gate = d.gates.find((g) => g.taskId === t.id);
                const p = projectOf.get(t.projectId);
                return (
                  <li key={t.id}>
                    <Link href={`/tasks/${t.id}`} className="block px-5 py-4 hover:bg-panel-2/50">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
                        <span className="font-mono text-ink-2">{t.key ?? "—"}</span>
                        <span>·</span>
                        <span>{p?.name}</span>
                        {t.pausedAt ? <span className="rounded border border-warn/40 px-1.5 text-warn">paused</span> : null}
                        <span className="ml-auto">
                          <StateChip state={t.state} />
                        </span>
                      </div>
                      <div className="mt-1 truncate font-medium">{t.title}</div>
                      {/* position in the flow */}
                      <ol className="mt-2.5 flex items-center gap-1" aria-label={`At ${NODE_LABEL[node]}`}>
                        {NODES.map((n, i) => {
                          const at = n === node;
                          const past = NODES.indexOf(node) > i;
                          return (
                            <li key={n} className="flex items-center gap-1">
                              <span
                                title={NODE_LABEL[n]}
                                className={cx("block h-1.5 w-6 rounded-full sm:w-10", at ? "bg-accent shadow-[0_0_10px_rgb(110_168_255/0.7)]" : past ? "bg-accent/35" : "bg-line-2")}
                              />
                            </li>
                          );
                        })}
                        <span className="ml-2 text-xs text-ink-2">{NODE_LABEL[node]}</span>
                      </ol>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
                        <RoleTag role={role} live={runs.length > 0} />
                        <span>{s.label}</span>
                        {gate ? (
                          <span className="text-xs text-mute">
                            gate <span className={gate.verdict === "DONE" ? "text-ok" : "text-bad"}>{gate.verdict}</span> @{gate.headSha.slice(0, 7)}
                          </span>
                        ) : null}
                        {t.corrections > 0 ? <span className="text-xs text-mute">{t.corrections} correction{t.corrections > 1 ? "s" : ""}</span> : null}
                      </div>
                      {routing ? (
                        <div className={cx("mt-2 inline-flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1 text-xs", PARTY_TONE[PARTY[routing.party].tone])}>
                          <span className="font-semibold">
                            {PARTY[routing.party].label} → {PARTY[routing.party].owner}
                          </span>
                          <span className="opacity-90">{routing.text}</span>
                          {routing.selfCorrecting ? <span className="rounded bg-current/10 px-1 font-semibold">self-correcting</span> : null}
                        </div>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Live events" meta="authoritative activity log" />
          {d.events.length === 0 ? (
            <Empty>No events yet.</Empty>
          ) : (
            <ol className="max-h-[640px] divide-y divide-line overflow-y-auto">
              {d.events.map(({ a, key, taskId }) => (
                <li key={a.id} className="px-5 py-2.5">
                  <div className="flex items-center gap-2 text-[11px] text-mute">
                    <RoleTag role={ACTOR_ROLE[a.actor] ?? "system"} />
                    <Link href={`/tasks/${taskId}`} className="font-mono hover:text-ink">
                      {key ?? `#${taskId}`}
                    </Link>
                    <span className="ml-auto">
                      <Ago at={a.at} />
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-ink-2">{a.message}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Accepted work" meta="merged with your approval" />
          {d.accepted.length === 0 ? (
            <Empty>Nothing accepted yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {d.accepted.map((t) => (
                <li key={t.id}>
                  <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-panel-2/50">
                    <span aria-hidden className="size-2 rounded-full bg-ok" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                    <span className="shrink-0 text-xs text-mute">
                      {projectOf.get(t.projectId)?.name} · {t.key} · <Ago at={t.updatedAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Projects" />
          <ul className="divide-y divide-line">
            {d.projects.map((p) => {
              const pt = d.tasks.filter((t) => t.projectId === p.id);
              return (
                <li key={p.id}>
                  <Link href={`/projects/${p.slug}`} className="grid grid-cols-[1fr_auto] items-center gap-2 px-5 py-3.5 hover:bg-panel-2/50">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="block truncate font-mono text-xs text-mute">
                        {p.org}/{p.repo}
                      </span>
                    </span>
                    <span className="flex gap-4 text-xs text-ink-2 tabular-nums">
                      <span>{pt.filter((t) => !["ACCEPTED", "REJECTED", "ABANDONED"].includes(t.state)).length} active</span>
                      <span className="text-ok">{pt.filter((t) => t.state === "ACCEPTED").length} accepted</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
