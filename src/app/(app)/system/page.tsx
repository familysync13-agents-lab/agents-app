import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { ProjectCapabilities } from "@/components/project-capabilities";
import { Ago, Card, CardHeader, Empty, Sha, cx } from "@/components/ui";
import { currentTime } from "@/domain/time";
import { systemPage } from "@/server/queries";

export const metadata = { title: "System" };

/** Health of the control plane itself: heartbeats, executor, backups, and the audit log of administrative operations. */
export default async function SystemPage() {
  const d = await systemPage();
  const now = currentTime();
  const jobs = Object.fromEntries(d.jobs.map((j) => [j.status, j.n]));
  return (
    <div className="space-y-6">
      <LiveRefresh seconds={10} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System</h1>
        <p className="mt-1 text-sm text-mute">The control plane&apos;s own health, recovery points and every administrative action.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {d.heartbeats.map((h) => {
          const age = Math.round((now - h.at.getTime()) / 1000);
          return (
            <Card key={h.name} className="px-4 py-3">
              <div className="text-[11px] tracking-[0.16em] text-mute uppercase">{h.name === "worker" ? "Control loop" : h.name === "executor" ? "Executor (host daemon)" : h.name}</div>
              <div className={cx("mt-1 text-lg font-semibold", age < 30 ? "text-ok" : "text-bad")}>{age < 30 ? "Online" : "Offline"}</div>
              <div className="mt-1 text-xs text-mute">
                heartbeat <Ago at={h.at} />
                {h.info && typeof h.info.kit_root === "string" ? (
                  <>
                    {" "}
                    · kit <code className="font-mono">{String(h.info.kit_root).slice(0, 8)}</code>
                  </>
                ) : null}
                {h.info && typeof h.info.tasks === "number" ? <> · {String(h.info.tasks)} task(s) in the loop</> : null}
              </div>
            </Card>
          );
        })}
        <Card className="px-4 py-3">
          <div className="text-[11px] tracking-[0.16em] text-mute uppercase">Build</div>
          <div className="mt-1 font-mono text-lg">{d.system.build.slice(0, 12)}</div>
          <div className="mt-1 text-xs text-mute">open tabs reload automatically after a redeploy</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-[11px] tracking-[0.16em] text-mute uppercase">Executor jobs</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {jobs.done ?? 0} done · <span className={jobs.error ? "text-warn" : ""}>{jobs.error ?? 0} error</span>
          </div>
          <div className="mt-1 text-xs text-mute">
            {jobs.queued ?? 0} queued · {jobs.running ?? 0} running
          </div>
        </Card>
      </div>

      <ProjectCapabilities projects={d.capabilities} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Backups" meta="pg_dump, verified by a full restore into a scratch database; kept 14" />
          {d.backups.length === 0 ? (
            <Empty>No backup recorded yet. The executor takes one daily and before every deploy.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-mute">
                <tr>
                  <th className="px-5 py-2 font-medium">Taken</th>
                  <th className="px-2 py-2 font-medium">Label</th>
                  <th className="px-2 py-2 font-medium">Size</th>
                  <th className="px-5 py-2 font-medium">Restore check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.backups.map((b) => (
                  <tr key={b.id}>
                    <td className="px-5 py-2">
                      <Ago at={b.at} />
                    </td>
                    <td className="px-2 py-2 text-ink-2">{String((b.detail as { label?: string } | null)?.label ?? "")}</td>
                    <td className="px-2 py-2 tabular-nums text-ink-2">{Math.round(b.bytes / 1024)} KB</td>
                    <td className={cx("px-5 py-2", b.verified ? "text-ok" : "text-bad")}>{b.verified ? "restored OK" : "failed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent executor errors" meta="harness problems - never charged to the work" />
          {d.recentErrors.length === 0 ? (
            <Empty>No executor errors.</Empty>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {d.recentErrors.map((j) => (
                <li key={j.id} className="px-5 py-2.5">
                  <div className="flex items-center gap-2 text-xs text-mute">
                    <code className="font-mono">{j.op}</code>
                    {j.taskId ? (
                      <Link href={`/tasks/${j.taskId}`} className="hover:text-ink">
                        task {j.taskId}
                      </Link>
                    ) : null}
                    <span className="ml-auto">
                      <Ago at={j.finishedAt ?? j.createdAt} />
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-ink-2">{j.error}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Administrative operations (audit log)" meta="typed, validated, recorded - raw database repair is not an operation" />
        {d.audit.length === 0 ? (
          <Empty>No administrative operation has been used.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-mute">
                <tr>
                  <th className="px-5 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Actor</th>
                  <th className="px-2 py-2 font-medium">Operation</th>
                  <th className="px-2 py-2 font-medium">Task</th>
                  <th className="px-2 py-2 font-medium">Reason</th>
                  <th className="px-5 py-2 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.audit.map(({ a, key }) => (
                  <tr key={a.id} className="align-top">
                    <td className="px-5 py-2 whitespace-nowrap text-ink-2">
                      <Ago at={a.at} />
                    </td>
                    <td className="px-2 py-2">{a.actor}</td>
                    <td className="px-2 py-2 font-mono text-xs">{a.op}</td>
                    <td className="px-2 py-2">{a.taskId ? <Link href={`/tasks/${a.taskId}`}>{key ?? `#${a.taskId}`}</Link> : "—"}</td>
                    <td className="px-2 py-2 text-ink-2">{a.reason}</td>
                    <td className={cx("px-5 py-2", a.outcome === "applied" ? "text-ok" : "text-warn")}>
                      {a.outcome}
                      {a.refusal ? <span className="block text-xs text-mute">{a.refusal}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-mute">
        Recovery points are host-only files; a restore is an operator action that first takes a fresh backup. Hash of the newest backup:{" "}
        <Sha value={d.backups[0]?.sha256} n={16} />
      </p>
    </div>
  );
}
