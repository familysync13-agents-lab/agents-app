import Link from "next/link";
import { Ago } from "@/components/ui";
import { shortenTitle } from "@/domain/text";

export type AcceptanceItemProps = { taskId: number; taskKey: string | null; taskTitle: string; project: string; title: string; why: string; createdAt: Date; proof: string | null };

/**
 * One open acceptance decision on the Decisions page. Read-only facts: exactly one link (to the task, by key and title) and - only
 * when a decision record is recorded for it - what that record leaves accepted without proof.
 */
export function AcceptanceItem({ taskId, taskKey, taskTitle, project, title, why, createdAt, proof }: AcceptanceItemProps) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
        <span className="rounded-md border border-owner/40 bg-owner/10 px-1.5 py-0.5 font-semibold text-owner">Acceptance</span>
        {project} · <Ago at={createdAt} />
      </div>
      <Link href={`/tasks/${taskId}`} className="mt-1.5 block w-fit max-w-full text-sm break-words text-ink-2 hover:text-accent">
        {taskKey ?? "new"} · {taskTitle}
      </Link>
      <div className="mt-1 line-clamp-2 font-medium break-words" title={title}>
        {shortenTitle(title)}
      </div>
      <p className="mt-1 line-clamp-3 text-sm text-ink-2">{why}</p>
      {proof ? <p className="mt-1.5 text-sm text-ink-2">{proof}</p> : null}
    </li>
  );
}
