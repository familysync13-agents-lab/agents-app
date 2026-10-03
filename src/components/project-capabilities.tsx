import { capabilityRow, NOT_AVAILABLE, NOT_DETECTED, NOT_DETECTED_YET, type CapabilityCell } from "@/domain/capabilities";
import { Card, CardHeader, Empty } from "./ui";

export interface CapabilityProject {
  id: number;
  name: string;
  capabilityProfile: unknown;
}

export const COLUMNS = ["Project", "Language", "Framework", "Package manager", "Build", "Test", "Lint", "Type-check", "Browser tests"] as const;

function Mark({ text, filled }: { text: string; filled: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={filled ? "size-1.5 shrink-0 rounded-full bg-current" : "size-1.5 shrink-0 rounded-full border border-current"} />
      {text}
    </span>
  );
}

function Capability({ cell }: { cell: CapabilityCell }) {
  if (!cell.available)
    return (
      <span className="text-mute">
        <Mark text={NOT_AVAILABLE} filled={false} />
      </span>
    );
  return (
    <span className="text-ok">
      <Mark text="Available" filled />
      {cell.command ? <code className="block font-mono text-xs break-all text-ink-2">{cell.command}</code> : null}
    </span>
  );
}

function Value({ text }: { text: string }) {
  return text === NOT_DETECTED ? <span className="text-mute">{text}</span> : <span className="font-mono text-xs text-ink-2">{text}</span>;
}

/** System page card: the recorded capability profile of every configured (active) project. Read-only. */
export function ProjectCapabilities({ projects }: { projects: CapabilityProject[] }) {
  return (
    <Card>
      <CardHeader title="Project Capabilities" meta="detected from each project's own repository files - read-only" />
      {projects.length === 0 ? (
        <Empty>No project is configured.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="text-left text-xs text-mute">
              <tr>
                {COLUMNS.map((c, i) => (
                  <th key={c} className={i === 0 ? "px-5 py-2 font-medium" : i === COLUMNS.length - 1 ? "px-5 py-2 font-medium" : "px-2 py-2 font-medium"}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {projects.map((p) => {
                const row = capabilityRow(p.capabilityProfile);
                return (
                  <tr key={p.id} className="align-top">
                    <td className="px-5 py-2 font-medium">{p.name}</td>
                    {row ? (
                      <>
                        <td className="px-2 py-2">
                          <Value text={row.language} />
                        </td>
                        <td className="px-2 py-2">
                          <Value text={row.framework} />
                        </td>
                        <td className="px-2 py-2">
                          <Value text={row.packageManager} />
                        </td>
                        <td className="px-2 py-2">
                          <Capability cell={row.build} />
                        </td>
                        <td className="px-2 py-2">
                          <Capability cell={row.test} />
                        </td>
                        <td className="px-2 py-2">
                          <Capability cell={row.lint} />
                        </td>
                        <td className="px-2 py-2">
                          <Capability cell={row.typecheck} />
                        </td>
                        <td className="px-5 py-2">
                          <Capability cell={row.browserTests} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={COLUMNS.length - 1} className="px-2 py-2 text-mute">
                        {NOT_DETECTED_YET}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
