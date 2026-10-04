import Link from "next/link";
import { notFound } from "next/navigation";
import type { TaskState } from "@/db/schema";
import { MAIN_PATH, STATE_LABEL } from "@/domain/lifecycle";
import { AdminForm, BlockDecisionForm, ContractReviewForm, RejectResultForm } from "@/components/forms";
import { FlowMap } from "@/components/flow-map";
import { EvidencePackageCard } from "@/components/evidence-package";
import { failureRouting, flowState, PARTY } from "@/domain/ops";
import { currentTime } from "@/domain/time";
import { LiveRefresh } from "@/components/live-refresh";
import { stepInfo } from "@/components/steps";
import { Ago, buttonPrimary, Card, CardHeader, cx, Empty, EvidenceChip, RoleTag, Sha, StateChip, type Role } from "@/components/ui";
import { acceptanceResidualGroups, currentEvidencePackage, taskDetail } from "@/server/queries";
import { ResidualList, type ResidualGroups } from "@/components/residual-list";
import { requireOwner } from "@/server/auth";
import { shortenTitle } from "@/domain/text";

export const metadata = { title: "Task" };

type Detail = NonNullable<Awaited<ReturnType<typeof taskDetail>>>;
type Criterion = { id: string; type: string; priority: string; tags?: string[]; given?: string; when?: string; then?: string; metric?: string; target?: string; conditions?: string; statement?: string };

const gh = (d: Detail, pr: number | null | undefined) => (pr ? `https://github.com/${d.project.org}/${d.project.repo}/pull/${pr}` : null);

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  // checked here too: the layout renders concurrently, so its check alone would let page data stream into the redirect
  await requireOwner();
  const { id } = await params;
  const d = await taskDetail(Number(id));
  if (!d) notFound();
  const pkg = await currentEvidencePackage(d.task.id);
  const t = d.task;
  const s = stepInfo(t.step);
  const activeRun = d.runs.find((r) => r.status === "running" || r.status === "starting");
  const nowRole: Role = activeRun?.role ?? (s.waitingOnOwner ? "owner" : s.role);
  const contract = d.contracts[0];
  const approved = d.contracts.find((c) => c.status === "merged");
  const open = d.decisions.filter((x) => x.status === "open");
  const residual = await acceptanceResidualGroups(open.map((x) => ({ d: x })));

  return (
    <div className="space-y-6">
      <LiveRefresh seconds={5} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={`/projects/${d.project.slug}`} className="text-sm text-mute hover:text-ink">
            ← {d.project.name}
          </Link>
          <h1 className="mt-2 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {t.key ? <span className="font-mono text-lg text-mute">{t.key}</span> : null}
            <span className="min-w-0 break-words">{t.title}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-mute">
            <StateChip state={t.state} size="md" />
            <span className="capitalize">{t.tier} tier</span>
            {t.prNumber ? (
              <a className="text-accent hover:underline" href={gh(d, t.prNumber)!} target="_blank" rel="noreferrer">
                PR #{t.prNumber}
              </a>
            ) : null}
            {t.headSha ? (
              <span>
                head <Sha value={t.headSha} />
              </span>
            ) : null}
            {t.corrections > 0 ? <span>{t.corrections} automatic correction{t.corrections > 1 ? "s" : ""}</span> : null}
          </div>
        </div>
      </div>

      <AtAGlance d={d} />

      <Card className="hud-surface overflow-hidden">
        <CardHeader title="Where this task is" meta="position in the operational flow, from the control loop" />
        <div className="px-3 py-3 sm:px-6">
          <FlowMap s={taskFlow(d)} label={`Task ${t.key ?? t.id}`} />
        </div>
      </Card>

      <Stepper d={d} />

      <Card className={cx(s.waitingOnOwner || open.length ? "border-owner/40" : "")}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4">
          <RoleTag role={nowRole} live={!!activeRun} />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-medium">{t.step === "done" ? STATE_LABEL[t.state] : s.label}</div>
            {t.stateReason ? <div className="mt-0.5 text-sm text-mute">{t.stateReason}</div> : null}
          </div>
          {activeRun ? (
            <div className="text-xs text-mute">
              {activeRun.role} session running since <Ago at={activeRun.startedAt} />
            </div>
          ) : null}
        </div>
        {open.map((dec) => (
          <div key={dec.id} className="border-t border-owner/30 bg-owner/[0.04] px-5 py-5">
            <OwnerAction d={d} dec={dec} groups={residual.get(dec.id) ?? null} />
          </div>
        ))}
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0 space-y-6">
          <ContractPanel d={d} />
          <VerificationPanel d={d} />
        </div>
        <div className="min-w-0 space-y-6">
          <WorkPanel d={d} />
          <Timeline d={d} />
          <EvidencePackageCard pkg={pkg} />
          <Card>
            <CardHeader title="Evidence files" meta={`${d.artifacts.length}`} />
            {d.artifacts.length === 0 ? (
              <Empty>No stored evidence yet.</Empty>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d.artifacts.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-2.5">
                    <Link href={`/tasks/${t.id}/artifacts/${a.id}`} className="min-w-0 flex-1 truncate hover:text-accent" title={a.name}>
                      {a.name}
                    </Link>
                    {a.workerAuthored ? <span className="text-xs text-mute">worker-authored</span> : null}
                    <Sha value={a.sha256} n={10} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <AdminPanel d={d} />
          {approved?.mergeCommit || contract ? (
            <p className="text-xs break-words text-mute">
              Intent recorded <Ago at={t.createdAt} />. Approved contract hash <Sha value={approved?.sha256} n={16} />.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function taskFlow(d: Detail) {
  const t = d.task;
  const live = ["ACCEPTED", "REJECTED", "ABANDONED"].includes(t.state) ? [] : [t];
  const recent = d.transitions.filter((x) => currentTime() - new Date(x.at).getTime() < 90_000);
  return flowState({
    live,
    running: d.runs.filter((r) => r.status === "running" || r.status === "starting").map((r) => ({ taskId: t.id, purpose: r.purpose })),
    openDecisions: d.decisions.filter((x) => x.status === "open").length,
    recentTransitions: recent,
    accepted: t.state === "ACCEPTED" ? 1 : 0,
  });
}

/** The owner's questions, answered from the record in one glance (details below remain inspectable). */
function AtAGlance({ d }: { d: Detail }) {
  const t = d.task;
  const s = stepInfo(t.step);
  const run = d.runs.find((r) => r.status === "running" || r.status === "starting");
  const contract = d.contracts.find((c) => c.status === "merged") ?? d.contracts[0];
  const must = ((contract?.body as { criteria?: Criterion[] } | undefined)?.criteria ?? []).filter((c) => c.priority === "must").map((c) => `${t.key}:${c.id}`);
  const head = t.headSha;
  const atHead = head ? d.evidence.filter((e) => e.commitSha === head && e.source.startsWith("gate:")) : [];
  const verified = must.filter((m) => atHead.some((e) => e.subject === m && e.status === "verified")).length;
  const failed = atHead.filter((e) => e.status === "not_verified" && e.subject.startsWith(`${t.key}:`)).map((e) => e.subject.replace(/^.*:/, ""));
  const routing = failureRouting(t, t.corrections);
  const attribution = d.evidence.find((e) => e.subject.startsWith("attribution:") && e.commitSha === head);
  const open = d.decisions.filter((x) => x.status === "open");
  const building = (contract?.body as { scope?: { summary?: string } } | undefined)?.scope?.summary ?? t.intent;
  const asks = open.map((o) => o.title).join("; ");
  // shortened values end with "…" (whole words only) and keep the full value as the cell's title
  const cells: { k: string; v: React.ReactNode; tone?: string; full?: string }[] = [
    { k: "Being built", v: shortenTitle(building, 180), full: building },
    { k: "Working now", v: run ? `${run.role === "builder" ? "Builder" : "Verifier"} - ${s.label}` : s.waitingOnOwner || t.step === "await_decision" ? "Waiting for you" : s.label },
    { k: "Verified", v: head ? `${verified} of ${must.length} must-criteria at ${head.slice(0, 7)}` : "Nothing built yet", full: head ?? undefined, tone: head && verified === must.length && must.length > 0 ? "text-ok" : undefined },
    {
      k: "Failed / owner",
      v: routing ? `${PARTY[routing.party].label} → ${PARTY[routing.party].owner}` : failed.length ? `${failed.join(", ")} failed${attribution ? ` (${attribution.detail?.split(":")[0]?.toLowerCase()})` : ""}` : "Nothing failing",
      tone: routing || failed.length ? "text-warn" : "text-ink-2",
    },
    { k: "Self-correcting", v: routing ? (routing.selfCorrecting ? "Yes - no action needed" : "No - needs a decision") : "—", tone: routing?.selfCorrecting ? "text-verifier" : undefined },
    { k: "Do I need to act?", v: open.length ? shortenTitle(asks, 160) : "No", full: open.length ? asks : undefined, tone: open.length ? "text-owner" : "text-ok" },
    { k: "Corrections", v: `${t.corrections} of ${d.project.maxCorrections + t.extraCorrections} (this contract version; check defects are never charged)` },
    { k: "Reached main", v: t.mergeCommit ? `Yes - merged ${t.mergeCommit.slice(0, 8)}` : "Not yet", full: t.mergeCommit ?? undefined, tone: t.mergeCommit ? "text-ok" : undefined },
  ];
  return (
    <section aria-label="At a glance" className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
      {cells.map((c) => (
        <div key={c.k} className={cx("min-w-0 bg-panel px-4 py-3 break-words", c.k === "Being built" && "sm:col-span-2 xl:col-span-1")}>
          <div className="text-[11px] tracking-[0.16em] text-mute uppercase">{c.k}</div>
          <div className={cx("mt-1 text-sm leading-snug", c.tone ?? "text-ink")} title={c.full}>
            {c.v}
          </div>
        </div>
      ))}
    </section>
  );
}

function AdminPanel({ d }: { d: Detail }) {
  const running = d.runs.filter((r) => r.status === "running").map((r) => ({ id: r.id, label: `${r.role} ${r.purpose} (run ${r.id})` }));
  const reopenable = d.decisions.filter((x) => (x.kind === "block" || x.kind === "budget") && x.status !== "open").map((x) => ({ id: x.id, label: `#${x.id} ${shortenTitle(x.title, 60)}` }));
  return (
    <Card>
      <CardHeader title="Operations" meta="audited recovery actions" />
      <div className="px-5 py-4">
        <p className="mb-3 text-xs text-mute">
          Narrow, typed actions with a required reason. Each is validated against the task&apos;s state, recorded (who, why, before/after) and refused when unsafe.
        </p>
        <AdminForm taskId={d.task.id} paused={!!d.task.pausedAt} runs={running} decisions={reopenable} />
      </div>
    </Card>
  );
}

function Stepper({ d }: { d: Detail }) {
  const reached = new Map<TaskState, Date>();
  for (const tr of d.transitions) if (!reached.has(tr.toState)) reached.set(tr.toState, tr.at);
  const cur = d.task.state;
  const blocked = cur === "BLOCKED_DECISION" || cur === "BLOCKED_EVIDENCE";
  const terminalBad = cur === "REJECTED" || cur === "ABANDONED";
  const curIdx = MAIN_PATH.indexOf(cur);
  const lastReached = Math.max(...MAIN_PATH.map((s, i) => (reached.has(s) ? i : -1)));
  return (
    <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Lifecycle">
      {MAIN_PATH.map((st, i) => {
        const isCur = i === curIdx;
        const done = i < (curIdx >= 0 ? curIdx : lastReached + 1) && reached.has(st);
        const at = reached.get(st);
        return (
          <li
            key={st}
            aria-current={isCur ? "step" : undefined}
            className={cx(
              "min-w-0 rounded-xl border px-3 py-2.5 break-words",
              isCur ? "border-accent/60 bg-accent/10" : done ? "border-line bg-panel" : "border-line/60 bg-panel/40",
              blocked && i === lastReached && "border-owner/60 bg-owner/10",
            )}
          >
            <div className={cx("text-xs font-semibold", isCur ? "text-accent" : done ? "text-ink-2" : "text-mute/70")}>
              {done ? "✓ " : ""}
              {STATE_LABEL[st]}
            </div>
            <div className="mt-0.5 text-[11px] text-mute">{at ? <Ago at={at} /> : blocked && i === lastReached + 1 ? "blocked" : "—"}</div>
          </li>
        );
      })}
      {blocked || terminalBad ? (
        <li className="col-span-3 rounded-xl border border-owner/50 bg-owner/10 px-3 py-2 text-sm break-words text-owner sm:col-span-6">
          {STATE_LABEL[cur]}: {d.task.stateReason}
        </li>
      ) : null}
    </ol>
  );
}

function OwnerAction({ d, dec, groups }: { d: Detail; dec: Detail["decisions"][number]; groups: ResidualGroups | null }) {
  const ctx = dec.context as Record<string, unknown>;
  const heading = (
    <div className="mb-4 break-words">
      <div className="text-xs font-semibold tracking-wide text-owner uppercase">Your decision</div>
      <h2 className="mt-1 text-lg font-semibold">{dec.title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-2">{dec.why}</p>
      {Array.isArray((dec.context as { decisionRecord?: { residual?: string[] } }).decisionRecord?.residual) ? (
        <ResidualList lines={(dec.context as { decisionRecord: { residual: string[] } }).decisionRecord.residual} groups={dec.kind === "acceptance" ? groups : null} />
      ) : null}
    </div>
  );
  if (dec.kind === "contract_approval") {
    const c = d.contracts.find((x) => x.id === ctx.contractId);
    if (!c) return heading;
    return (
      <div>
        {heading}
        <p className="mb-4 text-sm break-words text-mute">
          Review the contract below (v{c.version}, sha256 <Sha value={c.sha256} n={12} />) and the oracle that will judge it (sha256{" "}
          <Sha value={c.oracleSha256} n={12} />, written blind by the Verifier).
          {ctx.notes ? " The Verifier left notes (see Evidence files)." : ""}
        </p>
        <ContractReviewForm taskId={d.task.id} contractId={c.id} sha256={c.sha256} />
      </div>
    );
  }
  if (dec.kind === "contract_github_approval" || dec.kind === "acceptance") {
    const url = gh(d, Number(ctx.pr));
    return (
      <div>
        {heading}
        <div className="flex flex-wrap items-center gap-3">
          {url ? (
            <a href={`${url}/files`} target="_blank" rel="noreferrer" className={buttonPrimary}>
              Review &amp; approve PR #{String(ctx.pr)} on GitHub ↗
            </a>
          ) : null}
          {dec.kind === "acceptance" ? <RejectResultForm taskId={d.task.id} /> : null}
          <span className="text-sm text-mute">On GitHub: Review changes → Approve → Submit review. The control system notices your approval within a minute and continues automatically.</span>
        </div>
      </div>
    );
  }
  const stage = String(ctx.stage ?? "");
  return (
    <div>
      {heading}
      <BlockDecisionForm
        taskId={d.task.id}
        decisionId={dec.id}
        options={dec.options}
        recommendation={dec.recommendation}
        allowCustom={stage === "contract" || stage === "build"}
      />
    </div>
  );
}

function ContractPanel({ d }: { d: Detail }) {
  const c = d.contracts[0];
  if (!c)
    return (
      <Card>
        <CardHeader title="Contract" />
        <div className="space-y-3 px-5 py-4 text-sm break-words">
          <div className="text-xs font-semibold tracking-wide text-mute uppercase">Your intent</div>
          <p className="whitespace-pre-wrap text-ink-2">{d.task.intent}</p>
          <p className="text-mute">The contract is being drafted from this intent.</p>
        </div>
      </Card>
    );
  const body = c.body as { scope?: { summary?: string }; non_goals?: string[]; criteria?: Criterion[]; interface?: Record<string, unknown> };
  const status: Record<string, string> = {
    draft: "draft",
    lint_failed: "failed lint",
    review: "awaiting your review",
    approved_app: "approved in app",
    changes_requested: "changes requested",
    rejected: "rejected",
    pr_open: "awaiting GitHub approval",
    merged: "approved & frozen",
    superseded: "superseded",
  };
  return (
    <Card>
      <CardHeader
        title="Contract"
        meta={
          <span className="flex flex-wrap items-center gap-2">
            v{c.version} · {status[c.status] ?? c.status} · <Sha value={c.sha256} n={12} />
          </span>
        }
      />
      <div className="space-y-4 px-5 py-4 text-sm break-words">
        {body.scope?.summary ? <p className="text-ink-2">{body.scope.summary}</p> : null}
        {!c.lint.ok ? (
          <div role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-bad">
            Lint: {c.lint.problems.join("; ")}
          </div>
        ) : null}
        <ul className="space-y-2">
          {(body.criteria ?? []).map((k) => (
            <li key={k.id} className="rounded-xl border border-line bg-panel-2/50 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono font-semibold text-ink">{k.id}</span>
                <span className={cx("rounded px-1.5 py-0.5", k.priority === "must" ? "bg-accent/15 text-accent" : "bg-panel text-mute")}>{k.priority}</span>
                <span className="text-mute">{k.type}</span>
                {(k.tags ?? []).map((tag) => (
                  <span key={tag} className="rounded bg-owner/10 px-1.5 py-0.5 text-owner">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-1.5 space-y-0.5 text-ink-2">
                {k.given ? (
                  <p>
                    <span className="text-mute">Given</span> {k.given}
                  </p>
                ) : null}
                {k.when ? (
                  <p>
                    <span className="text-mute">When</span> {k.when}
                  </p>
                ) : null}
                {k.then ? (
                  <p>
                    <span className="text-mute">Then</span> {k.then}
                  </p>
                ) : null}
                {k.metric ? (
                  <p>
                    {k.metric} <span className="text-mute">target</span> {k.target} {k.conditions ? <span className="text-mute">({k.conditions})</span> : null}
                  </p>
                ) : null}
                {k.statement ? <p>{k.statement}</p> : null}
              </div>
            </li>
          ))}
        </ul>
        {body.non_goals && body.non_goals.length ? (
          <p className="text-mute">
            <span className="font-medium text-ink-2">Non-goals:</span> {body.non_goals.join("; ")}
          </p>
        ) : null}
        {body.interface ? (
          <details className="rounded-xl border border-line px-3.5 py-2.5">
            <summary className="cursor-pointer text-ink-2">Interface names the implementation must use</summary>
            <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-ink-2">{JSON.stringify(body.interface, null, 2)}</pre>
          </details>
        ) : null}
        <details className="rounded-xl border border-line px-3.5 py-2.5">
          <summary className="cursor-pointer text-ink-2">Your original intent</summary>
          <p className="mt-2 whitespace-pre-wrap text-ink-2">{d.task.intent}</p>
        </details>
      </div>
    </Card>
  );
}

function VerificationPanel({ d }: { d: Detail }) {
  const g = d.gates[0];
  const ev = g ? d.evidence.filter((e) => e.source === `gate:${g.checkRunId}`) : [];
  const own = ev.filter((e) => e.subject.startsWith(`${d.task.key}:`));
  const reg = ev.filter((e) => !e.subject.startsWith(`${d.task.key}:`));
  const indep = d.evidence.filter((e) => e.source.startsWith("verifier:") && (!d.task.headSha || e.commitSha === d.task.headSha));
  return (
    <Card>
      <CardHeader
        title="Verification"
        meta={
          g ? (
            <span className="flex items-center gap-2">
              gate check run{" "}
              <a className="text-accent hover:underline" href={`https://github.com/${d.project.org}/${d.project.repo}/runs/${g.checkRunId}`} target="_blank" rel="noreferrer">
                {g.checkRunId}
              </a>
            </span>
          ) : null
        }
      />
      {!g ? (
        <Empty>No gate evaluation yet. The gate runs on the exact commit the Builder submits.</Empty>
      ) : (
        <div className="space-y-4 px-5 py-4 break-words">
          <div className="flex flex-wrap items-center gap-3">
            <RoleTag role="gate" />
            <span className={cx("rounded-lg px-2.5 py-1 font-mono text-sm font-semibold", g.kind === "pass" ? "bg-ok/15 text-ok" : g.kind === "blocked" ? "bg-warn/15 text-warn" : "bg-bad/15 text-bad")}>
              {g.verdict}
            </span>
            <span className="text-sm text-mute">
              for <Sha value={g.headSha} /> · <Ago at={g.observedAt} />
            </span>
          </div>
          {g.reasons.length ? <p className="text-sm text-ink-2">{g.reasons.join("; ")}</p> : null}
          <CriteriaTable title={`${d.task.key} criteria`} rows={own} />
          {reg.length ? <CriteriaTable title="Regression of earlier tasks" rows={reg} compact /> : null}
          {d.gates.length > 1 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-mute">Earlier gate results ({d.gates.length - 1})</summary>
              <ul className="mt-2 space-y-1">
                {d.gates.slice(1).map((x) => (
                  <li key={x.id} className="flex flex-wrap gap-3 text-ink-2">
                    <span className="font-mono">{x.verdict}</span> <Sha value={x.headSha} /> <Ago at={x.observedAt} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
      <div className="border-t border-line px-5 py-4 break-words">
        <div className="mb-2 flex items-center gap-3">
          <RoleTag role="verifier" />
          <span className="text-sm text-ink-2">Independent check (blind, different vendor) · agent judgment, one evidence source</span>
        </div>
        {indep.length === 0 ? (
          <p className="text-sm text-mute">Not run yet for this commit.</p>
        ) : (
          <ul className="space-y-2">
            {indep.map((e) => (
              <li key={e.id} className="rounded-xl border border-line bg-panel-2/50 px-3.5 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <EvidenceChip status={e.status} />
                  {e.severity ? <span className="rounded bg-panel px-1.5 py-0.5 text-xs text-ink-2 uppercase">{e.severity}</span> : null}
                  <span className="font-mono text-xs text-mute">{e.subject}</span>
                </div>
                {e.detail ? <p className="mt-1 whitespace-pre-wrap text-ink-2">{e.detail}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function CriteriaTable({ title, rows, compact }: { title: string; rows: Detail["evidence"]; compact?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold tracking-wide text-mute uppercase">{title}</div>
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="bg-panel-2/60 text-xs text-mute">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Criterion</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Oracle</th>
              {!compact ? <th scope="col" className="px-3 py-2 font-medium">Detail</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="px-3 py-2 font-mono text-xs">{e.subject}</td>
                <td className="px-3 py-2">
                  <EvidenceChip status={e.status} />
                </td>
                <td className="px-3 py-2 text-xs text-mute">{e.oracle.replace("_", " ")}</td>
                {!compact ? <td className="max-w-[28ch] truncate px-3 py-2 text-xs text-ink-2" title={e.detail ?? ""}>{(e.detail ?? "").split(" · ").slice(-1)[0]}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkPanel({ d }: { d: Detail }) {
  const PURPOSE: Record<string, string> = {
    draft_contract: "Drafted the contract",
    author_oracle: "Authored the oracle (blind)",
    build: "Built the task",
    correction: "Correction",
    acceptance_check: "Independent check",
    mutants: "Oracle mutation test",
    repair_oracle: "Repaired the acceptance check (blind, contract unchanged)",
    attribution: "Arbiter: who owns the failure",
  };
  return (
    <Card>
      <CardHeader title="Workers" meta={`${d.runs.length} sessions`} />
      {d.runs.length === 0 ? (
        <Empty>No worker has run yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {d.runs.map((r) => (
            <li key={r.id} className="px-5 py-3 break-words">
              <div className="flex flex-wrap items-center gap-3">
                <RoleTag role={r.role} live={r.status === "running"} />
                <span className="text-sm font-medium">{PURPOSE[r.purpose] ?? r.purpose}</span>
                <span className="ml-auto text-xs text-mute">
                  <Ago at={r.startedAt} />
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
                <span>{r.status === "running" ? "running" : r.status === "harness_error" ? "executor lost the session" : "finished"}</span>
                {r.outcome ? <span>structured outcome: {r.outcome.replace(/_/g, " ")}</span> : null}
                {r.durationMs ? <span>{Math.round(r.durationMs / 60000)} min</span> : null}
                {r.turns ? <span>{r.turns} turns</span> : null}
                {r.costUsd ? <span>${r.costUsd.toFixed(2)} API-equivalent</span> : null}
              </div>
              {r.closingText ? (
                <details className="mt-1.5 text-xs">
                  <summary className="cursor-pointer text-mute">Worker&apos;s own closing message (untrusted; never used for state)</summary>
                  <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-ink-2">{r.closingText}</p>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Timeline({ d }: { d: Detail }) {
  const items = d.activity.slice(0, 60);
  return (
    <Card>
      <CardHeader title="Timeline" />
      {items.length === 0 ? (
        <Empty>No activity yet.</Empty>
      ) : (
        <ol className="max-h-[560px] space-y-0 overflow-y-auto px-5 py-3">
          {items.map((a) => (
            <li key={a.id} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 py-1.5 text-sm">
              <span className="pt-0.5 text-xs text-mute">
                <Ago at={a.at} />
              </span>
              <span className="break-words">
                <RoleTag role={a.actor as Role} /> <span className="ml-1 text-ink-2">{a.message}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
