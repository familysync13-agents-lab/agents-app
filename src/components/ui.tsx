import type { ReactNode } from "react";
import type { EvidenceStatus, TaskState } from "@/db/schema";
import { STATE_LABEL } from "@/domain/lifecycle";
import { currentTime } from "@/domain/time";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const STATE_TONE: Record<TaskState, string> = {
  PROPOSED: "text-ink-2 border-line-2 bg-panel-2",
  CONTRACTED: "text-accent border-accent/30 bg-accent/10",
  IN_PROGRESS: "text-builder border-builder/30 bg-builder/10",
  VERIFYING: "text-gate border-gate/30 bg-gate/10",
  DONE: "text-ok border-ok/30 bg-ok/10",
  ACCEPTED: "text-ok border-ok/40 bg-ok/15",
  BLOCKED_DECISION: "text-owner border-owner/40 bg-owner/10",
  BLOCKED_EVIDENCE: "text-warn border-warn/40 bg-warn/10",
  REJECTED: "text-bad border-bad/30 bg-bad/10",
  ABANDONED: "text-mute border-line-2 bg-panel-2",
};

export function StateChip({ state, size = "sm" }: { state: TaskState; size?: "sm" | "md" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "md" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs",
        STATE_TONE[state],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {STATE_LABEL[state]}
    </span>
  );
}

const EV_TONE: Record<EvidenceStatus, string> = {
  verified: "text-ok bg-ok/10 border-ok/30",
  partially_verified: "text-warn bg-warn/10 border-warn/30",
  not_verified: "text-bad bg-bad/10 border-bad/30",
  unknown: "text-warn bg-warn/10 border-warn/30",
  waived: "text-mute bg-panel-2 border-line-2",
};
const EV_LABEL: Record<EvidenceStatus, string> = {
  verified: "Verified",
  partially_verified: "Partially verified",
  not_verified: "Not verified",
  unknown: "Unknown",
  waived: "Waived",
};
export function EvidenceChip({ status }: { status: EvidenceStatus }) {
  return <span className={cx("inline-flex rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", EV_TONE[status])}>{EV_LABEL[status]}</span>;
}

export type Role = "builder" | "verifier" | "gate" | "owner" | "system" | "executor";
const ROLE: Record<Role, { label: string; tone: string }> = {
  builder: { label: "Builder", tone: "text-builder" },
  verifier: { label: "Verifier", tone: "text-verifier" },
  gate: { label: "Gate", tone: "text-gate" },
  owner: { label: "You", tone: "text-owner" },
  system: { label: "Control system", tone: "text-ink-2" },
  executor: { label: "Executor", tone: "text-mute" },
};
export function RoleTag({ role, live = false }: { role: Role; live?: boolean }) {
  const r = ROLE[role];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase", r.tone)}>
      <span aria-hidden className={cx("size-2 rounded-full bg-current", live && "pulse-dot")} />
      {r.label}
    </span>
  );
}

export function Card({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cx("rounded-2xl border border-line bg-panel/80 shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset]", className)}>{children}</As>;
}

export function CardHeader({ title, meta, id }: { title: ReactNode; meta?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-3.5">
      <h2 id={id} className="text-sm font-semibold tracking-wide text-ink">
        {title}
      </h2>
      {meta ? <div className="text-xs text-mute">{meta}</div> : null}
    </div>
  );
}

export function Sha({ value, n = 8 }: { value: string | null | undefined; n?: number }) {
  if (!value) return <span className="text-mute">—</span>;
  return (
    <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[0.78em] text-ink-2" title={value}>
      {value.slice(0, n)}
    </code>
  );
}

export function Ago({ at }: { at: Date | string | null | undefined }) {
  if (!at) return <span className="text-mute">—</span>;
  const d = typeof at === "string" ? new Date(at) : at;
  const s = Math.max(0, Math.round((currentTime() - d.getTime()) / 1000));
  const txt = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  return (
    <time dateTime={d.toISOString()} title={d.toISOString().replace("T", " ").slice(0, 19) + " UTC"}>
      {txt}
    </time>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-sm text-mute">{children}</p>;
}

export const buttonPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-accent-2 px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_24px_-8px_rgb(61_123_255/0.6)] hover:bg-accent-2/90 disabled:opacity-50";
export const buttonSecondary =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-line-2 bg-panel-2 px-4 py-2 text-sm font-semibold text-ink hover:border-accent/50";
export const buttonDanger =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-bad/40 bg-bad/10 px-4 py-2 text-sm font-semibold text-bad hover:bg-bad/15";
export const inputClass =
  "w-full rounded-xl border border-line-2 bg-bg/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-mute/70 focus:border-accent focus:outline-none";
