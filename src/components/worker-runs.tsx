import Link from "next/link";
import { Card, CardHeader, Empty } from "./ui";

export interface WorkerRun {
  id: number;
  taskId: number;
  key: string | null;
  purpose: string;
  worker: string | null;
  taskClass: string | null;
  routeReason: string | null;
  contextBytes: number | null;
}

export const NO_RUNS = "No worker runs yet";
const DASH = "—";

/** System page card: the execution ledger of the most recent worker runs, as recorded. Read-only. */
export function WorkerRuns({ runs }: { runs: WorkerRun[] }) {
  return (
    <Card>
      <CardHeader title="Recent worker runs" meta="the 20 most recently started runs - why each worker ran and with how much context" />
      {runs.length === 0 ? (
        <Empty>{NO_RUNS}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs text-mute">
              <tr>
                <th className="px-5 py-2 font-medium">Task</th>
                <th className="px-2 py-2 font-medium">Purpose</th>
                <th className="px-2 py-2 font-medium">Worker</th>
                <th className="px-2 py-2 font-medium">Task class</th>
                <th className="px-2 py-2 font-medium">Reason</th>
                <th className="px-5 py-2 text-right font-medium">Context bytes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-5 py-2 whitespace-nowrap">
                    <Link href={`/tasks/${r.taskId}`}>{r.key ?? `#${r.taskId}`}</Link>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs">{r.purpose}</td>
                  <td className="px-2 py-2 font-mono text-xs">{r.worker ?? DASH}</td>
                  <td className="px-2 py-2 font-mono text-xs">{r.taskClass ?? DASH}</td>
                  <td className="px-2 py-2 text-ink-2">{r.routeReason ?? DASH}</td>
                  <td className="px-5 py-2 text-right tabular-nums text-ink-2">{r.contextBytes ?? DASH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
