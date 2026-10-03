import type { Contract } from "./contract";
import type { CapabilityProfile } from "./profile";
import type { PlanTask } from "./plan";

/*
 * Deterministic Context Builder (Builder phase). Before an intelligent worker spends its context exploring the repository, the
 * control plane assembles a small, task-relevant CONTEXT PACKAGE from deterministic sources only: exact repository search, static
 * import/reference relationships, Git history, the relevant part of the contract and the current errors. No AI is involved.
 * The aim is not minimum context at any cost: it is the smallest package that keeps execution successful - so what the worker later
 * needed beyond the package is measured (runs.extra_files).
 */

export const CONTEXT_BUDGET = { maxBytes: 14000, maxTerms: 14, maxFiles: 14, maxHitsPerTerm: 6, snippetLines: 4 };

const STOP = new Set(["the", "and", "with", "that", "this", "from", "when", "then", "given", "page", "list", "must", "should", "user", "owner", "each", "have", "does", "they", "their", "into", "after", "before", "without", "button", "link", "shows", "show", "click", "clicks"]);

/** Search seeds from the contract (and, for a decomposed contract, only from the criteria this plan task works on). */
export function contextSeeds(c: Contract, task?: Pick<PlanTask, "covers" | "contributes" | "scope_paths"> | null): { terms: string[]; paths: string[]; criteria: string[] } {
  const ids = task ? new Set([...task.covers, ...task.contributes]) : null;
  const crit = c.criteria.filter((k) => !ids || ids.has(k.id));
  const cons = (c.constraints ?? []).filter((k) => !ids || ids.has(k.id));
  const text = [...crit.map((k) => [k.given, k.when, k.then, k.metric, k.statement, k.rule].filter(Boolean).join(" ")), ...cons.map((x) => x.statement), JSON.stringify(c.interface ?? {})].join("\n");
  const score = new Map<string, number>();
  const add = (t: string, w: number) => {
    const k = t.trim();
    if (k.length < 3 || k.length > 60 || !/^[A-Za-z0-9 _./:-]+$/.test(k) || STOP.has(k.toLowerCase())) return;
    score.set(k, (score.get(k) ?? 0) + w);
  };
  for (const m of text.matchAll(/["“']([^"”'\n]{3,60})["”']/g)) add(m[1]!, 5); // exact labels, messages, names
  for (const m of text.matchAll(/(?:^|[\s(])(\/[A-Za-z0-9_\-/[\]]{2,60})/g)) add(m[1]!, 4); // routes
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z]+(?:-[a-z0-9]+)+\b/g)) add(m[0], 3); // identifiers
  for (const m of text.matchAll(/\b[A-Za-z]{5,}\b/g)) add(m[0], 1);
  const terms = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, CONTEXT_BUDGET.maxTerms).map(([t]) => t);
  const paths = [...new Set([...(task?.scope_paths ?? []), ...c.scope.paths])].filter((p) => p !== "**");
  return { terms, paths, criteria: crit.map((k) => k.id) };
}

/** What the executor's deterministic scan returns (git grep, git log, static import lines; no worker involved). */
export interface ScanResult {
  commit?: string;
  files_total?: number;
  hits?: Record<string, { file: string; line: number; text: string }[]>;
  files?: Record<string, { imports?: string[]; importedBy?: string[]; log?: string[]; tests?: string[] }>;
}

export interface ContextPackage {
  markdown: string;
  bytes: number;
  files: string[];
  terms: string[];
}

/** Rank files by how many distinct seeds hit them; tests and generated files rank last. */
export function rankFiles(scan: ScanResult): string[] {
  const s = new Map<string, number>();
  for (const [, hs] of Object.entries(scan.hits ?? {})) for (const f of new Set(hs.map((h) => h.file))) s.set(f, (s.get(f) ?? 0) + 1);
  const pen = (f: string) => (/(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\./.test(f) ? 1 : 0) + (/\.(md|json|lock|sql|snap)$/.test(f) ? 1 : 0);
  return [...s.entries()].sort((a, b) => pen(a[0]) - pen(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f).slice(0, CONTEXT_BUDGET.maxFiles);
}

export function buildContextPackage(i: {
  contract: Contract;
  task?: (Pick<PlanTask, "id" | "purpose" | "covers" | "contributes" | "scope_paths">) | null;
  profile?: CapabilityProfile | null;
  scan: ScanResult;
  errors?: string | null;
}): ContextPackage {
  const seeds = contextSeeds(i.contract, i.task ?? null);
  const files = rankFiles(i.scan);
  const out: string[] = [];
  out.push(`# Context package (assembled deterministically by the control plane at ${String(i.scan.commit ?? "").slice(0, 8) || "the base commit"})`);
  out.push("Start here. It lists where the contract's names already occur in the repository and how those files relate. It is a starting point, not a boundary: read further only where you need to.");
  if (i.profile) {
    const p = i.profile;
    out.push(`\n## Project\n${[p.languages.join("/"), p.framework, p.packageManager, p.database].filter(Boolean).join(" · ")}\nCommands: ${Object.entries(p.commands).filter(([, v]) => v).map(([k, v]) => `${k}: \`${v}\``).join("; ") || "none detected"}${p.checkStage ? "; the gate runs the Dockerfile `check` stage" : ""}`);
  }
  if (i.task) out.push(`\n## This task (${i.task.id})\n${i.task.purpose}\nCriteria to deliver now: ${i.task.covers.join(", ") || "none alone"}${i.task.contributes.length ? `; contributes to: ${i.task.contributes.join(", ")}` : ""}`);
  if (files.length) {
    out.push("\n## Most relevant files");
    for (const f of files) {
      const m = i.scan.files?.[f];
      const bits = [m?.imports?.length ? `imports ${m.imports.slice(0, 6).join(", ")}` : "", m?.importedBy?.length ? `used by ${m.importedBy.slice(0, 5).join(", ")}` : "", m?.tests?.length ? `tests ${m.tests.slice(0, 3).join(", ")}` : "", m?.log?.length ? `last change: ${m.log[0]}` : ""].filter(Boolean);
      out.push(`- \`${f}\`${bits.length ? ` — ${bits.join("; ")}` : ""}`);
    }
  }
  const hitLines: string[] = [];
  for (const t of seeds.terms) {
    const hs = (i.scan.hits?.[t] ?? []).filter((h) => files.includes(h.file)).slice(0, CONTEXT_BUDGET.maxHitsPerTerm);
    if (hs.length === 0) continue;
    hitLines.push(`- "${t}": ${hs.map((h) => `${h.file}:${h.line}`).join(", ")}`);
  }
  if (hitLines.length) out.push(`\n## Where the contract's names occur\n${hitLines.join("\n")}`);
  const missing = seeds.terms.filter((t) => !(i.scan.hits?.[t] ?? []).length);
  if (missing.length) out.push(`\n## Not found in the repository (probably new)\n${missing.map((t) => `"${t}"`).join(", ")}`);
  if (i.errors) out.push(`\n## Current findings\n${i.errors.slice(0, 3000)}`);
  let md = out.join("\n");
  if (Buffer.byteLength(md) > CONTEXT_BUDGET.maxBytes) md = `${Buffer.from(md).subarray(0, CONTEXT_BUDGET.maxBytes).toString("utf8")}\n… (truncated to the context budget)`;
  return { markdown: md, bytes: Buffer.byteLength(md), files, terms: seeds.terms };
}

/** Files the worker changed that the package had not pointed to: the observable signal that the package under-selected. */
export function extraFiles(supplied: string[], changed: string[]): string[] {
  const s = new Set(supplied);
  return changed.filter((f) => !s.has(f) && !f.startsWith(".bakeoff/")).sort();
}
