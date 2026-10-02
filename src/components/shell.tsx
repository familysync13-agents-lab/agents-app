import Link from "next/link";
import { systemStatus } from "@/server/queries";
import { currentTime } from "@/domain/time";
import { cx } from "./ui";

/*
 * Application shell of the Operations Interface: a command rail (desktop) / top navigation (phone) and a live system bar. The shell
 * is the permanent frame - panels (flow instrument today; the operations hub visualisation later) plug into it without replacing it.
 */
function Pill({ ok, label, title }: { ok: boolean | null; label: string; title: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={cx("size-1.5 rounded-full", ok === null ? "bg-mute" : ok ? "bg-ok" : "bg-bad")} />
      <span className={ok === false ? "text-bad" : "text-ink-2"}>{label}</span>
    </span>
  );
}

function age(s: number | null) {
  if (s === null) return "never";
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}

export async function Shell({ openDecisions, projects, children }: { openDecisions: number; projects: { slug: string; name: string }[]; children: React.ReactNode }) {
  const s = await systemStatus();
  const backupAge = s.lastBackup ? Math.round((currentTime() - new Date(s.lastBackup.at).getTime()) / 1000) : null;
  const nav = [
    { href: "/", label: "Command" },
    { href: "/decisions", label: "Decisions", badge: openDecisions },
    { href: "/system", label: "System" },
  ];
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[220px_1fr]">
      <aside className="hidden border-r border-line bg-panel/40 lg:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 px-4 py-5">
          <Link href="/" className="flex items-center gap-2.5 px-2">
            <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-verifier text-[13px] font-bold text-bg shadow-[0_0_24px_-4px_rgb(110_168_255/0.6)]">
              A
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold tracking-tight">Agents</span>
              <span className="block text-[10px] tracking-[0.2em] text-mute uppercase">Operations</span>
            </span>
          </Link>
          <nav aria-label="Main" className="flex flex-col gap-1 text-sm">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="flex items-center justify-between rounded-lg px-3 py-2 text-ink-2 hover:bg-panel-2 hover:text-ink">
                {n.label}
                {n.badge ? (
                  <span className="rounded-full bg-owner px-1.5 text-xs font-bold text-bg" aria-label={`${n.badge} open`}>
                    {n.badge}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <div>
            <div className="px-3 text-[10px] tracking-[0.2em] text-mute uppercase">Projects</div>
            <ul className="mt-2 flex flex-col gap-0.5 text-sm">
              {projects.map((p) => (
                <li key={p.slug}>
                  <Link href={`/projects/${p.slug}`} className="block truncate rounded-lg px-3 py-1.5 text-ink-2 hover:bg-panel-2 hover:text-ink">
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-auto space-y-1.5 px-3 text-[11px] text-mute">
            <div>
              build <code className="font-mono">{s.build.slice(0, 8)}</code>
            </div>
            <div>
              kit <code className="font-mono">{s.kitRoot?.slice(0, 8) ?? "—"}</code>
            </div>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold lg:hidden">
              <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-verifier text-[12px] font-bold text-bg">
                A
              </span>
              Agents
            </Link>
            <nav aria-label="Main (compact)" className="flex items-center gap-1 text-sm lg:hidden">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-ink-2 hover:bg-panel-2">
                  {n.label}
                  {n.badge ? <span className="rounded-full bg-owner px-1.5 text-xs font-bold text-bg">{n.badge}</span> : null}
                </Link>
              ))}
            </nav>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs lg:ml-0" aria-label="System status">
              <Pill ok={s.worker !== null && s.worker < 30} label={`Control loop ${s.worker !== null && s.worker < 30 ? "online" : "offline"}`} title={`last heartbeat ${age(s.worker)} ago`} />
              <Pill ok={s.executor !== null && s.executor < 30} label={`Executor ${s.executor !== null && s.executor < 30 ? "online" : "offline"}`} title={`last heartbeat ${age(s.executor)} ago; operator queue ${s.operatorQueue ?? "?"}`} />
              <Pill
                ok={backupAge === null ? false : backupAge < 26 * 3600 && !!s.lastBackup?.verified}
                label={`Backup ${backupAge === null ? "none" : `${age(backupAge)} ago`}`}
                title={s.lastBackup ? `${s.lastBackup.file} (${s.lastBackup.verified ? "restore-verified" : "NOT verified"})` : "no backup recorded"}
              />
            </div>
            {openDecisions > 0 ? (
              <Link href="/decisions" className="ml-auto inline-flex items-center gap-2 rounded-full border border-owner/50 bg-owner/10 px-3 py-1 text-xs font-semibold text-owner">
                <span aria-hidden className="size-1.5 rounded-full bg-owner pulse-dot" />
                {openDecisions} need{openDecisions === 1 ? "s" : ""} you
              </Link>
            ) : (
              <span className="ml-auto text-xs text-mute">Nothing needs you</span>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
