import Link from "next/link";
import { BatchApproveForm } from "@/components/forms";
import { LiveRefresh } from "@/components/live-refresh";
import { Ago, Card, CardHeader, Empty } from "@/components/ui";
import { shortenTitle } from "@/domain/text";
import { openDecisionsList } from "@/server/queries";

export const metadata = { title: "Decisions" };

const KIND: Record<string, string> = {
  contract_approval: "Contract review",
  contract_github_approval: "Confirm on GitHub",
  block: "Decision",
  budget: "Budget",
  acceptance: "Acceptance",
};

export default async function Decisions() {
  const rows = await openDecisionsList();
  // contracts of one project awaiting review in the same sitting can be approved together (one GitHub PR follows)
  const groups = new Map<number, typeof rows>();
  for (const r of rows.filter((x) => x.d.kind === "contract_approval")) groups.set(r.p.id, [...(groups.get(r.p.id) ?? []), r]);
  const batchable = [...groups.values()].filter((g) => g.length >= 2);
  return (
    <div className="space-y-6">
      <LiveRefresh seconds={8} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Decisions</h1>
        <p className="mt-1 text-sm text-mute">Only what genuinely needs your authority: contracts, product questions, budget and final acceptance.</p>
      </div>
      {batchable.map((g) => (
        <Card key={g[0]!.p.id} className="border-owner/40">
          <CardHeader title={`${g.length} contracts ready in ${g[0]!.p.name}`} meta="review each, approve together" />
          <ul className="divide-y divide-line">
            {g.map(({ d, t }) => (
              <li key={d.id} className="px-5 py-3">
                <Link href={`/tasks/${t.id}`} className="font-medium hover:text-accent">
                  {t.key} · {t.title}
                </Link>
                <div className="mt-0.5 text-xs text-mute">
                  contract <code className="font-mono">{String((d.context as { sha256?: string }).sha256 ?? "").slice(0, 12)}</code> · <Ago at={d.createdAt} />
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-5 py-4">
            <BatchApproveForm
              items={g.map(({ d, t }) => ({ taskId: t.id, key: t.key ?? String(t.id), contractId: Number((d.context as { contractId?: number }).contractId), sha256: String((d.context as { sha256?: string }).sha256) }))}
            />
          </div>
        </Card>
      ))}
      <Card>
        <CardHeader title="Open" meta={`${rows.length}`} />
        {rows.length === 0 ? (
          <Empty>No open decisions. The control system continues on its own.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map(({ d, t, p }) => (
              <li key={d.id}>
                <Link href={`/tasks/${t.id}`} className="block px-5 py-4 hover:bg-panel-2/60">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
                    <span className="rounded-md border border-owner/40 bg-owner/10 px-1.5 py-0.5 font-semibold text-owner">{KIND[d.kind] ?? d.kind}</span>
                    {p.name} · {t.key ?? "new"} · <Ago at={d.createdAt} />
                  </div>
                  <div className="mt-1.5 line-clamp-2 font-medium break-words" title={d.title}>
                    {shortenTitle(d.title)}
                  </div>
                  <p className="mt-1 line-clamp-3 text-sm text-ink-2">{d.why}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
