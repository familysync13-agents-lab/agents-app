/*
 * EVIDENCE roles for a local model (modernization phase 3): bounded semantic work on evidence that deterministic software cannot
 * do. Qualification for an Evidence role is separate from every Builder class: its own pinned cases, its own records, the same
 * unchanged threshold. A role is EVALUATION ONLY until the owner approves it for production; until then the deterministic result
 * stands (an unlinked finding stays unlinked - it is never guessed).
 *
 * What is NOT a model role, because it is computed: evidence status, missing evidence, binding to head and contract version,
 * contradiction between a verified criterion and a blocking finding, integrity. See domain/evidence.ts.
 */
import type { SemanticSpec } from "./semantic";

export const EVIDENCE_ROLES = ["finding_association"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const plain = (s: string) => s.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
/** criterion ids listed in the input ("ACn: ..." lines of the Criteria block) */
export const listedCriteria = (input: string): string[] => [...(input.split("\n\nFinding:")[0] ?? "").matchAll(/^((?:AC|C)[0-9]+): /gm)].map((m) => m[1]!);
/** The bounded input of the role: the contract's criteria as stated, and one finding as the Verifier wrote it. */
export function associationInput(criteria: { id: string; text: string }[], finding: { title: string; expected: string; observed: string }): string {
  return `Criteria:\n${criteria.map((c) => `${c.id}: ${c.text.replace(/\s+/g, " ").trim()}`).join("\n")}\n\nFinding:\n${finding.title.trim()}\nExpected: ${finding.expected.trim()}\nObserved: ${finding.observed.trim()}`;
}

export const EVIDENCE_ROLE: Record<EvidenceRole, SemanticSpec & { rubric: string }> = {
  /**
   * A finding the Verifier did not tie to a criterion id is linked to the criterion it reports as violated - or to none. With the
   * link, a blocking finding contradicts that criterion's status in the evidence package; without it, the finding stays general.
   */
  finding_association: {
    system: `You link one finding of an independent software verifier to the acceptance criterion it is about. The input lists the criteria of a contract ("<id>: <statement>") and then one finding (title, expected, observed). Answer with JSON only: {"criterion": "...", "evidence": "..."}.
- criterion: the id of the ONE listed criterion whose required behaviour the finding reports as violated, or "none".
- Answer "none" when the finding is about something no listed criterion requires - even when it concerns the same page, button or feature. Sharing words with a criterion is not enough: the criterion's own requirement must be what failed.
- evidence: the shortest phrase copied VERBATIM from the finding that shows the violated behaviour (at most 200 characters).
Do not explain.`,
    schema: { type: "object", properties: { criterion: { type: "string" }, evidence: { type: "string" } }, required: ["criterion", "evidence"] },
    maxInput: 4000,
    maxTokens: 200,
    verifier: true,
    rubric: 'Pass only if the chosen criterion is the listed criterion whose own required behaviour the finding reports as violated, or "none" when no listed criterion requires the behaviour the finding is about; and the evidence phrase is taken from the finding.',
    structural: (input, o) => {
      const p: string[] = [];
      const c = str(o.criterion);
      if (c !== "none" && !listedCriteria(input).includes(c)) p.push("[schema] criterion is neither a listed criterion id nor none");
      const ev = str(o.evidence);
      const finding = input.split("\n\nFinding:")[1] ?? "";
      if (!ev.trim() || ev.length > 240) p.push("[schema] evidence missing or longer than 240 characters");
      else if (!plain(finding).includes(plain(ev))) p.push("[hallucination] evidence is not a verbatim phrase of the finding");
      return p;
    },
    agree: (o: Json, e: Json) => (str(o.criterion) === str(e.criterion) ? [] : [`[reference] criterion ${str(o.criterion)} differs from the reference ${str(e.criterion)}`]),
  },
};
