import { capabilityRow, type CapabilityCell } from "@/domain/capabilities";
import { Card, CardHeader, Empty, cx } from "./ui";

export interface CapabilityProject {
  id: number;
  name: string;
  capabilityProfile: unknown;
}

const COLUMNS = ["Project", "Language", "Framework", "Package manager", "Build", "Test", "Lint", "Type-check", "Browser tests"] as const;

function Capability({ cell }: { cell: CapabilityCell }) {
  if (!cell.available)
    return (
      <span className="inline-flex items-center gap-1.5 text-mute">
        <span aria-hidden className="size-1.5 rounded-full border border-current" />
        Not available
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-ok">
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      Available
      {cell.command ? (
        <>
          {" "}
          <code className="font-mono text-xs text-ink-2">{cell.command}</code>
        </>
      ) : null}
    </span>
  );
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
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-left text-xs text-mute">
              <tr>
                {COLUMNS.map((c, i) => (
                  <th key={c} className={cx("py-2 font-medium whitespace-nowrap", i === 0 ? "px-5" : i === COLUMNS.length - 1 ? "pr-5 pl-2" : "px-2")}>
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
                        <td className="px-2 py-2 text-ink-2">{row.language}</td>
                        <td className="px-2 py-2 text-ink-2">{row.framework}</td>
                        <td className="px-2 py-2 text-ink-2">{row.packageManager}</td>
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
                        <td className="py-2 pr-5 pl-2">
                          <Capability cell={row.browserTests} />
                        </td>
                      </>
                    ) : (
                      <td colSpan={COLUMNS.length - 1} className="py-2 pr-5 pl-2 text-mute">
                        Not detected yet
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
