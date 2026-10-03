import { Card, CardHeader } from "./ui";

export type AlternativeStatus = "unqualified" | "shadow" | "qualified" | "rejected" | "disabled";

export interface RoutingRow {
  taskClass: string;
  worker: string;
  reason: string;
  alternatives: { worker: string; status: AlternativeStatus; samples: number }[];
}

const DASH = "—";
const TONE: Record<AlternativeStatus, string> = {
  qualified: "text-ok",
  rejected: "text-bad",
  shadow: "text-warn",
  unqualified: "text-mute",
  disabled: "text-mute",
};

/** System page card: per task class, the worker the Router would choose now (standard tier) and why, with each alternative's evidence. Read-only. */
export function RoutingTable({ rows }: { rows: RoutingRow[] }) {
  return (
    <Card>
      <CardHeader
        title="Routing and qualification"
        meta="the static Router's choice for a standard-tier task now, from recorded qualification evidence only"
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs text-mute">
            <tr>
              <th className="px-5 py-2 font-medium">Task class</th>
              <th className="px-2 py-2 font-medium">Worker</th>
              <th className="px-2 py-2 font-medium">Reason</th>
              <th className="px-5 py-2 font-medium">Alternatives</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.taskClass} className="align-top">
                <td className="px-5 py-2 font-mono text-xs">{r.taskClass}</td>
                <td className="px-2 py-2 font-mono text-xs">{r.worker}</td>
                <td className="px-2 py-2 text-ink-2">{r.reason}</td>
                <td className="px-5 py-2">
                  {r.alternatives.length === 0 ? (
                    DASH
                  ) : (
                    <ul className="space-y-0.5">
                      {r.alternatives.map((a) => (
                        <li key={a.worker} className="text-xs whitespace-nowrap">
                          <code className="font-mono">{a.worker}</code>{" "}
                          <span className={TONE[a.status]}>{a.status}</span>{" "}
                          <span className="tabular-nums text-mute">{a.samples} samples</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
