import Link from "next/link";

export type ProjectItemProps = { slug: string; name: string; org: string; repo: string; active: number; accepted: number };

/** One row of the Command page's Projects panel: the project link plus a sibling "New intent" shortcut (never nested). */
export function ProjectItem({ slug, name, org, repo, active, accepted }: ProjectItemProps) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5 hover:bg-panel-2/50">
      <Link href={`/projects/${slug}`} className="grid min-w-0 flex-1 basis-52 grid-cols-[1fr_auto] items-center gap-2 rounded-lg">
        <span className="min-w-0">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate font-mono text-xs text-mute">
            {org}/{repo}
          </span>
        </span>
        <span className="flex gap-4 text-xs text-ink-2 tabular-nums">
          <span>{active} active</span>
          <span className="text-ok">{accepted} accepted</span>
        </span>
      </Link>
      <Link
        href={`/projects/${slug}/new`}
        aria-label={`New intent for ${name}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line-2 bg-panel-2 px-2.5 py-1 text-xs font-semibold text-ink hover:border-accent/50 hover:text-accent"
      >
        <span aria-hidden>+</span>
        New intent
      </Link>
    </li>
  );
}
