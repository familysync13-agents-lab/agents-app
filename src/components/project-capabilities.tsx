import { Fragment, type ReactNode } from "react";
import { capabilityRow, NOT_DETECTED, type CapabilityCell } from "@/domain/capabilities";
import { Card, CardHeader, Empty } from "./ui";

export interface CapabilityProject {
  id: number;
  name: string;
  capabilityProfile: unknown;
}

export const NO_PROFILE = "No capability profile detected yet.";

function Muted() {
  return (
    <span className="inline-flex items-center gap-1.5 text-mute">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-current" />
      {NOT_DETECTED}
    </span>
  );
}

function Capability({ cell }: { cell: CapabilityCell }) {
  if (!cell.available) return <Muted />;
  if (cell.command) return <code className="font-mono text-xs break-all text-ok">{cell.command}</code>;
  return (
    <span className="inline-flex items-center gap-1.5 text-ok">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      Available
    </span>
  );
}

function Value({ text }: { text: string }) {
  return text === NOT_DETECTED ? <Muted /> : <span className="text-ink-2">{text}</span>;
}

/** System page card: the recorded capability profile of every configured (active) project. Read-only. */
export function ProjectCapabilities({ projects }: { projects: CapabilityProject[] }) {
  return (
    <Card>
      <CardHeader title="Project Capabilities" meta="detected from each project's own repository files - read-only" />
      {projects.length === 0 ? (
        <Empty>No project is configured.</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {projects.map((p) => {
            const row = capabilityRow(p.capabilityProfile);
            const items: [string, ReactNode][] = row
              ? [
                  ["Language", <Value key="l" text={row.language} />],
                  ["Framework", <Value key="f" text={row.framework} />],
                  ["Package manager", <Value key="p" text={row.packageManager} />],
                  ["Build", <Capability key="b" cell={row.build} />],
                  ["Test", <Capability key="t" cell={row.test} />],
                  ["Lint", <Capability key="li" cell={row.lint} />],
                  ["Type check", <Capability key="tc" cell={row.typecheck} />],
                  ["Browser tests", <Capability key="bt" cell={row.browserTests} />],
                ]
              : [];
            return (
              <li key={p.id} className="px-5 py-3">
                <h3 className="font-medium">{p.name}</h3>
                {row ? (
                  <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 sm:grid-cols-[repeat(2,minmax(0,auto)_minmax(0,1fr))] xl:grid-cols-[repeat(4,minmax(0,auto)_minmax(0,1fr))]">
                    {items.map(([label, value]) => (
                      <Fragment key={label}>
                        <dt className="text-xs leading-5 text-mute">{label}</dt>
                        <dd className="min-w-0 leading-5">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-1 text-mute">{NO_PROFILE}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
