import { Fragment } from "react";
import { Card, CardHeader, Empty, cx } from "./ui";

export type CapabilityRow = { label: string; value: string; detected: boolean; mono: boolean };

const NOT_DETECTED = "Not detected";

/** Display rows of a stored capability profile (domain/profile.ts), or null when none has been detected yet. Read defensively: the
 * stored JSON may come from an older detector version. */
export function capabilityRows(profile: Record<string, unknown> | null | undefined): CapabilityRow[] | null {
  if (!profile || typeof profile !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const commands = (profile.commands && typeof profile.commands === "object" ? profile.commands : {}) as Record<string, unknown>;
  const languages = Array.isArray(profile.languages) ? profile.languages.filter((l): l is string => typeof l === "string" && l.trim() !== "") : [];
  const row = (label: string, v: string | null, mono = false): CapabilityRow => ({ label, value: v ?? NOT_DETECTED, detected: v !== null, mono: mono && v !== null });
  return [
    row("Language", languages.length ? languages.join(", ") : null),
    row("Framework", str(profile.framework)),
    row("Package manager", str(profile.packageManager)),
    row("Build", str(commands.build), true),
    row("Test", str(commands.test), true),
    row("Lint", str(commands.lint), true),
    row("Type check", str(commands.typecheck), true),
    row("Browser tests", profile.browserTests === true ? "Available" : null),
  ];
}

/** System page section: the detected capability profile of each active project (read-only). */
export function ProjectCapabilities({ projects }: { projects: { id: number; name: string; capabilityProfile: Record<string, unknown> | null }[] }) {
  return (
    <Card>
      <CardHeader title="Project Capabilities" meta="detected from each project's own repository files" />
      {projects.length === 0 ? (
        <Empty>No active project.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {projects.map((p) => {
            const rows = capabilityRows(p.capabilityProfile);
            return (
              <li key={p.id} className="px-5 py-4">
                <h3 className="text-sm font-semibold text-ink">{p.name}</h3>
                {rows ? (
                  <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[repeat(2,minmax(0,auto)_minmax(0,1fr))]">
                    {rows.map((r) => (
                      <Fragment key={r.label}>
                        <dt className="text-xs leading-5 text-mute">{r.label}</dt>
                        <dd className={cx("min-w-0 break-words", r.mono && "font-mono text-[0.85em]", r.detected ? (r.label === "Browser tests" ? "text-ok" : "text-ink-2") : "text-mute")}>{r.value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-1 text-sm text-mute">No capability profile detected yet.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
