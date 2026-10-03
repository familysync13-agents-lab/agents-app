import Link from "next/link";
import { notFound } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { stepInfo } from "@/components/steps";
import { Ago, buttonPrimary, Card, CardHeader, Empty, StateChip } from "@/components/ui";
import { projectBySlug } from "@/server/queries";
import { requireOwner } from "@/server/auth";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  // checked here too: the layout renders concurrently, so its check alone would let page data stream into the redirect
  await requireOwner();
  const { slug } = await params;
  const data = await projectBySlug(slug);
  if (!data) notFound();
  const { project: p, tasks } = data;
  return (
    <div className="space-y-8">
      <LiveRefresh seconds={8} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-mute">
            {p.org}/{p.repo}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.name}</h1>
          <p className="mt-2 max-w-3xl text-sm text-ink-2">{p.description}</p>
        </div>
        <Link href={`/projects/${p.slug}/new`} className={buttonPrimary}>
          New intent
        </Link>
      </div>
      <Card>
        <CardHeader title="Tasks" meta={`${tasks.length} total`} />
        {tasks.length === 0 ? (
          <Empty>No tasks yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-mute">
                <tr className="border-b border-line">
                  <th scope="col" className="px-5 py-2.5 font-medium">Task</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">State</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Now</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tasks.map((t) => (
                  <tr key={t.id} className="hover:bg-panel-2/60">
                    <td className="px-5 py-3">
                      <Link href={`/tasks/${t.id}`} className="font-medium hover:text-accent">
                        <span className="mr-2 font-mono text-xs text-mute">{t.key ?? "—"}</span>
                        {t.title}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <StateChip state={t.state} />
                    </td>
                    <td className="px-5 py-3 text-ink-2">{t.step === "done" ? "—" : stepInfo(t.step).label}</td>
                    <td className="px-5 py-3 text-mute">
                      <Ago at={t.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
