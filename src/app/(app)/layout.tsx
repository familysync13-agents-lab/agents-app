import { Shell } from "@/components/shell";
import { requireOwner } from "@/server/auth";
import { openDecisionsList, overview } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwner();
  const open = await openDecisionsList();
  const { projects } = await overview();
  return (
    <Shell openDecisions={open.length} projects={projects.map((p) => ({ slug: p.slug, name: p.name }))}>
      {children}
    </Shell>
  );
}
