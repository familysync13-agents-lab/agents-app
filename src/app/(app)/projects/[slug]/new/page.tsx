import Link from "next/link";
import { notFound } from "next/navigation";
import { NewTaskForm } from "@/components/forms";
import { Card } from "@/components/ui";
import { projectBySlug } from "@/server/queries";
import { requireOwner } from "@/server/auth";

export const metadata = { title: "New intent" };

export default async function NewIntent({ params }: { params: Promise<{ slug: string }> }) {
  // checked here too: the layout renders concurrently, so its check alone would let page data stream into the redirect
  await requireOwner();
  const { slug } = await params;
  const data = await projectBySlug(slug);
  if (!data) notFound();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href={`/projects/${slug}`} className="text-sm text-mute hover:text-ink">
          ← {data.project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New intent</h1>
        <p className="mt-1 text-sm text-mute">
          Nothing is built until you approve the contract drafted from this intent.
        </p>
      </div>
      <Card className="p-6">
        <NewTaskForm projectId={data.project.id} />
      </Card>
    </div>
  );
}
