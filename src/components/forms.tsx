"use client";

import { useActionState, useState } from "react";
import { adminAction, approveContractsAction, declineProposalAction, startProposalsAction, blockDecisionAction, contractDecisionAction, createTaskAction, rejectResultAction, type FormState } from "@/app/actions";
import { buttonDanger, buttonPrimary, buttonSecondary, cx, inputClass } from "./ui";

function Alert({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3.5 py-2.5 text-sm text-bad">
      {state.error}
    </p>
  );
}

export function NewTaskForm({ projectId }: { projectId: number }) {
  const [state, action, pending] = useActionState(createTaskAction, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-6" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      <Alert state={state} />
      <div className="space-y-2">
        <label htmlFor="title" className="block text-sm font-medium">
          Title
        </label>
        <input id="title" name="title" className={inputClass} maxLength={120} aria-invalid={!!fe.title} aria-describedby={fe.title ? "title-err" : undefined} placeholder="e.g. Let owners sort their lists" />
        {fe.title ? (
          <p id="title-err" role="alert" className="text-sm text-bad">
            {fe.title}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <label htmlFor="intent" className="block text-sm font-medium">
          What should be built or changed?
        </label>
        <p id="intent-hint" className="text-sm text-mute">
          Describe the outcome in product terms: who needs it, what they should be able to do, and anything that must not change. The system turns this
          into a contract with explicit success criteria for your approval.
        </p>
        <textarea
          id="intent"
          name="intent"
          rows={9}
          maxLength={6000}
          className={cx(inputClass, "leading-relaxed")}
          aria-invalid={!!fe.intent}
          aria-describedby={cx("intent-hint", fe.intent && "intent-err")}
        />
        {fe.intent ? (
          <p id="intent-err" role="alert" className="text-sm text-bad">
            {fe.intent}
          </p>
        ) : null}
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Risk tier</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex cursor-pointer gap-3 rounded-xl border border-line-2 bg-panel-2/60 p-4 has-[:checked]:border-accent">
            <input type="radio" name="tier" value="standard" defaultChecked className="mt-1 accent-[var(--color-accent-2)]" />
            <span>
              <span className="block text-sm font-semibold">Standard</span>
              <span className="block text-sm text-mute">Ordinary product work.</span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-xl border border-line-2 bg-panel-2/60 p-4 has-[:checked]:border-accent">
            <input type="radio" name="tier" value="critical" className="mt-1 accent-[var(--color-accent-2)]" />
            <span>
              <span className="block text-sm font-semibold">Critical</span>
              <span className="block text-sm text-mute">Touches authorization, data deletion, money or personal data.</span>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="flex justify-end">
        <button type="submit" className={buttonPrimary} disabled={pending}>
          {pending ? "Recording…" : "Record intent"}
        </button>
      </div>
    </form>
  );
}

export function ContractReviewForm({ taskId, contractId, sha256 }: { taskId: number; contractId: number; sha256: string }) {
  const [state, action, pending] = useActionState(contractDecisionAction, {});
  const [mode, setMode] = useState<"none" | "changes" | "reject">("none");
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="sha256" value={sha256} />
      <Alert state={state} />
      {mode !== "none" ? (
        <div className="space-y-2">
          <label htmlFor="note" className="block text-sm font-medium">
            {mode === "changes" ? "What should change?" : "Why is this rejected? (optional)"}
          </label>
          <textarea id="note" name="note" rows={4} maxLength={4000} className={inputClass} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {mode === "none" ? (
          <>
            <button name="choice" value="approve" className={buttonPrimary} disabled={pending}>
              {pending ? "Recording…" : "Approve contract"}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => setMode("changes")}>
              Request changes
            </button>
            <button type="button" className={buttonDanger} onClick={() => setMode("reject")}>
              Reject
            </button>
          </>
        ) : (
          <>
            <button name="choice" value={mode} className={mode === "reject" ? buttonDanger : buttonPrimary} disabled={pending}>
              {mode === "changes" ? "Send to the drafter" : "Reject the intent"}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => setMode("none")}>
              Cancel
            </button>
          </>
        )}
      </div>
    </form>
  );
}

export function BlockDecisionForm({
  taskId,
  decisionId,
  options,
  recommendation,
  allowCustom,
}: {
  taskId: number;
  decisionId: number;
  options: { id: string; label: string; consequence: string }[];
  recommendation: string | null;
  allowCustom: boolean;
}) {
  const [state, action, pending] = useActionState(blockDecisionAction, {});
  const rec = options.find((o) => o.id === recommendation || o.label === recommendation)?.id;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="decisionId" value={decisionId} />
      <Alert state={state} />
      <fieldset className="space-y-2">
        <legend className="sr-only">Options</legend>
        {options.map((o) => (
          <label key={o.id} className="flex cursor-pointer gap-3 rounded-xl border border-line-2 bg-panel-2/60 p-3.5 has-[:checked]:border-owner">
            <input type="radio" name="choice" value={o.id} defaultChecked={o.id === rec} className="mt-1 accent-[var(--color-owner)]" />
            <span>
              <span className="block text-sm font-semibold">
                {o.label}
                {o.id === rec ? <span className="ml-2 rounded bg-owner/15 px-1.5 py-0.5 text-xs font-medium text-owner">recommended</span> : null}
              </span>
              {o.consequence ? <span className="block text-sm text-mute">{o.consequence}</span> : null}
            </span>
          </label>
        ))}
        {allowCustom ? (
          <label className="flex cursor-pointer gap-3 rounded-xl border border-line-2 bg-panel-2/60 p-3.5 has-[:checked]:border-owner">
            <input type="radio" name="choice" value="custom" className="mt-1 accent-[var(--color-owner)]" />
            <span className="block text-sm font-semibold">My own answer (write it below)</span>
          </label>
        ) : null}
      </fieldset>
      <div className="space-y-2">
        <label htmlFor={`note-${decisionId}`} className="block text-sm font-medium">
          Note for the system (optional; required for your own answer)
        </label>
        <textarea id={`note-${decisionId}`} name="note" rows={3} maxLength={4000} className={inputClass} />
      </div>
      <button type="submit" className={buttonPrimary} disabled={pending}>
        {pending ? "Recording…" : "Decide"}
      </button>
    </form>
  );
}

export function RejectResultForm({ taskId }: { taskId: number }) {
  const [state, action, pending] = useActionState(rejectResultAction, {});
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" className={buttonSecondary} onClick={() => setOpen(true)}>
        Reject the result
      </button>
    );
  return (
    <form action={action} className="w-full space-y-3">
      <input type="hidden" name="taskId" value={taskId} />
      <Alert state={state} />
      <label htmlFor="reject-note" className="block text-sm font-medium">
        Why? (optional)
      </label>
      <textarea id="reject-note" name="note" rows={3} className={inputClass} />
      <div className="flex gap-3">
        <button className={buttonDanger} disabled={pending}>
          Reject and close the PR
        </button>
        <button type="button" className={buttonSecondary} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const ADMIN_CHOICES: { op: string; label: string; needs?: "run" | "decision"; when?: (p: { paused: boolean }) => boolean }[] = [
  { op: "pause", label: "Pause the task", when: (p) => !p.paused },
  { op: "resume", label: "Resume the task", when: (p) => p.paused },
  { op: "retry_step", label: "Retry the current step" },
  { op: "stop_run", label: "Stop a worker session", needs: "run" },
  { op: "reset_budget", label: "Reset the correction budget" },
  { op: "reopen_decision", label: "Re-open a decision", needs: "decision" },
];

export function AdminForm({ taskId, paused, runs, decisions }: { taskId: number; paused: boolean; runs: { id: number; label: string }[]; decisions: { id: number; label: string }[] }) {
  const [state, action, pending] = useActionState(adminAction, {});
  const choices = ADMIN_CHOICES.filter((c) => (c.when ? c.when({ paused }) : true) && (c.needs === "run" ? runs.length > 0 : c.needs === "decision" ? decisions.length > 0 : true));
  const [op, setOp] = useState(choices[0]?.op ?? "pause");
  const needs = ADMIN_CHOICES.find((c) => c.op === op)?.needs;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="taskId" value={taskId} />
      <Alert state={state} />
      {state.ok ? (
        <p role="status" className="text-sm text-ok">
          Recorded and applied.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="block text-mute">Operation</span>
          <select name="op" value={op} onChange={(e) => setOp(e.target.value)} className={inputClass}>
            {choices.map((c) => (
              <option key={c.op} value={c.op}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {needs === "run" ? (
          <label className="space-y-1 text-sm">
            <span className="block text-mute">Session</span>
            <select name="runId" className={inputClass}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {needs === "decision" ? (
          <label className="space-y-1 text-sm">
            <span className="block text-mute">Decision</span>
            <select name="decisionId" className={inputClass}>
              {decisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <label className="block space-y-1 text-sm">
        <span className="block text-mute">Reason (recorded)</span>
        <input name="reason" className={inputClass} minLength={8} maxLength={2000} required placeholder="Why is this needed?" />
      </label>
      <button type="submit" className={buttonSecondary} disabled={pending}>
        {pending ? "Applying…" : "Apply"}
      </button>
    </form>
  );
}

export function BatchApproveForm({ items }: { items: { taskId: number; contractId: number; sha256: string; key: string }[] }) {
  const [state, action, pending] = useActionState(approveContractsAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="items" value={JSON.stringify(items.map(({ taskId, contractId, sha256 }) => ({ taskId, contractId, sha256 })))} />
      <Alert state={state} />
      {state.ok ? (
        <p role="status" className="text-sm text-ok">
          Approved. One pull request will carry all {items.length} contracts to GitHub for a single confirmation.
        </p>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="reviewed" value="yes" className="mt-0.5 size-4 accent-[var(--color-accent-2)]" />
            <span>I reviewed all {items.length} contracts ({items.map((i) => i.key).join(", ")}) and approve each of them as written.</span>
          </label>
          <button type="submit" className={buttonPrimary} disabled={pending}>
            {pending ? "Recording…" : `Approve all ${items.length} contracts`}
          </button>
        </>
      )}
    </form>
  );
}

export function ProposalsForm({ items }: { items: { id: number; title: string; intent: string; rationale: string; project: string; source: string }[] }) {
  const [state, action, pending] = useActionState(startProposalsAction, {});
  return (
    <form action={action}>
      <Alert state={state} />
      <ul className="divide-y divide-line">
        {items.map((p) => (
          <li key={p.id} className="flex gap-3 px-5 py-3.5">
            <input type="checkbox" name="proposal" value={p.id} id={`prop-${p.id}`} className="mt-1 size-4 shrink-0 accent-[var(--color-accent-2)]" aria-describedby={`prop-${p.id}-d`} />
            <div className="min-w-0 flex-1">
              <label htmlFor={`prop-${p.id}`} className="block font-medium">
                {p.title} <span className="text-xs font-normal text-mute">· {p.project}</span>
              </label>
              <p id={`prop-${p.id}-d`} className="mt-0.5 text-sm text-ink-2">
                {p.intent}
              </p>
              <p className="mt-1 text-xs text-mute">
                Why: {p.rationale} <span className="opacity-70">(source: {p.source})</span>
              </p>
            </div>
            <button type="submit" formAction={declineProposalAction} name="proposal" value={p.id} className="h-fit shrink-0 text-xs text-mute underline hover:text-bad">
              Decline
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
        <button type="submit" className={buttonPrimary} disabled={pending}>
          {pending ? "Starting…" : "Start selected"}
        </button>
        <span className="text-xs text-mute">Each selected proposal becomes a task exactly as if you had written the intent. Nothing starts without your selection.</span>
        {state.ok ? (
          <span role="status" className="text-sm text-ok">
            Started {state.fieldErrors?.started} task(s).
          </span>
        ) : null}
      </div>
    </form>
  );
}
