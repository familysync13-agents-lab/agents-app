import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardHeader, Sha } from "@/components/ui";
import { artifactBody } from "@/server/queries";
import { requireOwner } from "@/server/auth";

export const metadata = { title: "Evidence file" };

export default async function ArtifactPage({ params }: { params: Promise<{ id: string; aid: string }> }) {
  // checked here too: the layout renders concurrently, so its check alone would let page data stream into the redirect
  await requireOwner();
  const { id, aid } = await params;
  const a = await artifactBody(Number(id), Number(aid));
  if (!a) notFound();
  let body = a.content;
  if (a.kind === "gate-evidence") {
    try {
      body = JSON.stringify(JSON.parse(a.content), null, 2);
    } catch {
      /* shown as stored */
    }
  }
  return (
    <div className="space-y-4">
      <Link href={`/tasks/${id}`} className="text-sm text-mute hover:text-ink">
        ← Task
      </Link>
      <Card>
        <CardHeader
          title={a.name}
          meta={
            <span>
              {a.workerAuthored ? "worker-authored (untrusted text) · " : ""}sha256 <Sha value={a.sha256} n={16} />
            </span>
          }
        />
        <pre className="max-h-[75vh] overflow-auto px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{body}</pre>
      </Card>
    </div>
  );
}
