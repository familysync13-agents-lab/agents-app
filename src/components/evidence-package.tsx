import { Card, CardHeader, Empty } from "@/components/ui";

/** The recorded fields of a stored evidence package the task page shows (a subset of the evidence_packages row). */
export interface EvidencePackageView {
  status: string;
  summary: Record<string, unknown>;
  sha256: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "{verified} of {total}" exactly as the package recorded them; null when the summary does not record both (never estimated). */
export function requiredVerified(summary: Record<string, unknown>): string | null {
  const total = num(summary.must_total);
  const must = summary.must;
  const verified = must && typeof must === "object" ? num((must as Record<string, unknown>).verified) : null;
  return total === null || verified === null ? null : `${verified} of ${total}`;
}

/** The recorded Verifier status identifier; null when the summary does not record one. */
export function verifierStatus(summary: Record<string, unknown>): string | null {
  return typeof summary.verifier === "string" && summary.verifier ? summary.verifier : null;
}

/**
 * Read-only card: the stored evidence package of the task's current head (or "No evidence package yet."). Renders recorded values
 * only; it has no controls and computes nothing beyond formatting.
 */
export function EvidencePackageCard({ pkg }: { pkg: EvidencePackageView | null }) {
  const verified = pkg ? requiredVerified(pkg.summary) : null;
  const verifier = pkg ? verifierStatus(pkg.summary) : null;
  return (
    <Card>
      <CardHeader title="Evidence package" meta={pkg ? "recorded for the current head" : null} />
      {!pkg ? (
        <Empty>No evidence package yet.</Empty>
      ) : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 px-5 py-4 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-2.5">
          <dt className="text-xs tracking-wide text-mute uppercase sm:pt-0.5">Status</dt>
          <dd className="mb-2 text-ink sm:mb-0">{pkg.status}</dd>
          <dt className="text-xs tracking-wide text-mute uppercase sm:pt-0.5">Required criteria verified</dt>
          <dd className="mb-2 text-ink sm:mb-0">{verified ?? <span className="text-mute">—</span>}</dd>
          <dt className="text-xs tracking-wide text-mute uppercase sm:pt-0.5">Verifier</dt>
          <dd className="mb-2 sm:mb-0">{verifier ? <code className="font-mono text-ink-2">{verifier}</code> : <span className="text-mute">—</span>}</dd>
          <dt className="text-xs tracking-wide text-mute uppercase sm:pt-0.5">Package hash</dt>
          <dd className="min-w-0">
            <code className="font-mono text-xs break-all text-ink-2">{pkg.sha256}</code>
          </dd>
        </dl>
      )}
    </Card>
  );
}
