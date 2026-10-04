import Link from "next/link";
import { withoutProofText } from "@/domain/decision";
import { shortenTitle } from "@/domain/text";
import { Ago } from "./ui";

/**
 * An open acceptance decision on the Decisions page (T9). Read-only, recorded facts only: the task link names the task, and the
 * count comes from the decision record recorded for this decision (`withoutProof` is undefined when none was recorded, and then
 * no statement is shown).
 */
export function AcceptanceItem({
  label,
  project,
  task,
  decision,
  withoutProof,
}: {
  label: string;
  project: string;
  task: { id: number; key: string | null; title: string };
  decision: { title: string; why: string; createdAt: Date | string };
  withoutProof: number | undefined;
}) {
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
        <span className="rounded-md border border-owner/40 bg-owner/10 px-1.5 py-0.5 font-semibold text-owner">
          {label}
        </span>
        {project} · {task.key ?? "new"} · <Ago at={decision.createdAt} />
      </div>
      <div className="mt-1.5 line-clamp-2 font-medium break-words" title={decision.title}>
        {shortenTitle(decision.title)}
      </div>
      <p className="mt-1 line-clamp-3 text-sm text-ink-2">{decision.why}</p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <Link href={`/tasks/${task.id}`} className="min-w-0 font-medium break-words text-accent hover:underline">
          {`${task.key ?? "new"} · ${task.title}`}
        </Link>
        {withoutProof === undefined ? null : <span className="text-ink-2">{withoutProofText(withoutProof)}</span>}
      </div>
    </li>
  );
}
