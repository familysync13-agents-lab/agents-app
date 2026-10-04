/**
 * Mechanical validation of a worker-authored oracle BEFORE it can become authoritative (V0 evidence: every T9 gate failure came from
 * the check layer). This is static analysis of the declared execution environment only - it never looks at, or adapts to, any
 * implementation, and it never loosens a criterion.
 */

/** What the oracle's execution environment provides (identical in the Verifier image and in the gate runner). */
export const ORACLE_ENV = {
  modules: ["playwright", "playwright-core", "axe-core"],
  /** Files an oracle may read (absolute paths present in both environments). */
  files: ["/node_modules/axe-core/axe.min.js"],
  /** Hosts reachable from the oracle (the preview and the project's test doubles). */
  hosts: ["preview", "books", "ingest"],
  env: ["BASE_URL", "INGEST_URL"],
} as const;

/**
 * Prefix the scaffold asks oracles to use when a check cannot judge the application because of its OWN setup (fixture, environment,
 * missing dependency). Such a result is an oracle/harness defect, never evidence against the implementation.
 */
export const HARNESS_PREFIX = "HARNESS:";

export function staticOracleProblems(js: string, extraHosts: string[] = []): string[] {
  const problems: string[] = [];
  const hosts = new Set<string>([...ORACLE_ENV.hosts, ...extraHosts]);
  // imports / requires
  const specs = [
    ...[...js.matchAll(/\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g)].map((m) => m[1]!),
    ...[...js.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!),
    ...[...js.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!),
  ];
  for (const s of specs) {
    const base = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]!;
    if (s.startsWith("node:")) continue;
    if (BUILTINS.has(base)) continue;
    if ((ORACLE_ENV.modules as readonly string[]).includes(base)) continue;
    problems.push(`imports "${s}", which is not available to oracles (available: ${ORACLE_ENV.modules.join(", ")} and Node built-ins)`);
  }
  // literal file reads
  for (const m of js.matchAll(/\b(?:readFile|readFileSync|createReadStream)\s*\(\s*["'`]([^"'`$]+)["'`]/g)) {
    const f = m[1]!;
    if (!(ORACLE_ENV.files as readonly string[]).includes(f)) problems.push(`reads file "${f}", which does not exist in the oracle environment (available: ${ORACLE_ENV.files.join(", ")})`);
  }
  // literal URLs
  for (const m of js.matchAll(/["'`](https?:\/\/([a-zA-Z0-9.-]+)(?::[0-9]+)?[^"'`]*)["'`]/g)) {
    const host = m[2]!;
    if (!hosts.has(host)) problems.push(`contacts host "${host}" (${m[1]!.slice(0, 80)}), which is unreachable from the oracle (reachable: ${[...hosts].join(", ")})`);
  }
  // environment variables
  for (const m of js.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    if (!(ORACLE_ENV.env as readonly string[]).includes(m[1]!)) problems.push(`depends on environment variable ${m[1]} that the gate does not provide (provided: ${ORACLE_ENV.env.join(", ")}; the base URL is also argv[2])`);
  }
  problems.push(...observationProblems(js));
  return [...new Set(problems)];
}

/**
 * How a check OBSERVES the page - two recurring defects of blind checks (T7 and T8: four gate failures, none of them the
 * implementation's). Facts about any web page, never about a particular implementation or an expected answer:
 *   1. rendered text (innerText) carries CSS text-transform, so comparing it case-sensitively with the contract's wording fails on
 *      a page that merely styles a label in capitals;
 *   2. the text / accessible name of an element is the concatenation of its children WITHOUT separators ("<span>T1</span>Title"
 *      reads "T1Title"), so a pattern that demands a word boundary, whitespace or punctuation after an id never matches.
 */
export function observationProblems(js: string): string[] {
  const out: string[] = [];
  const lines = js.split("\n");
  const caseSafe = /toLowerCase\(\)|toUpperCase\(\)|toLocaleLowerCase\(\)|toLocaleUpperCase\(\)/;
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    if (/\.(innerText|allInnerTexts)\s*\(|\.innerText\b/.test(l) && !caseSafe.test(l))
      out.push(`line ${i + 1}: reads rendered text (innerText), which carries CSS text-transform (a label styled in capitals reads "PACKAGE HASH"); read the element's own text with textContent() / allTextContents() (trimmed), or compare case-insensitively`);
    const boundary = /\[\^A-Za-z0-9_?\]|\(\\{1,2}s\|\$\)|\(\?=\\{1,2}s\|\$\)|\(\?!\\{1,2}w\)|\(\?!\[A-Za-z0-9_?\]\)/;
    const textFilter = /hasText|hasNotText|getByText|getByRole|\bname\s*:|toHaveText|toContainText|toHaveAccessibleName/;
    if (boundary.test(l) || (textFilter.test(l) && /\\b/.test(l)))
      out.push(`line ${i + 1}: a text pattern demands a boundary (non-word character, whitespace or \\b) next to an id or label; an element's text and accessible name join its children with NO separator ("T1" followed by a title reads "T1Title"), so this never matches. Locate by role, href or the id's own element and compare that element's text exactly`);
  });
  return [...new Set(out)];
}

const BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "timers",
  "url",
  "util",
  "zlib",
]);

/** Result line of an oracle run ({criterion, result, detail}). */
export interface OracleResult {
  criterion: string;
  result: string;
  detail?: string;
}

/**
 * Oracle-internal failure signatures: the check crashed, could not measure, or declared its own harness problem. These are
 * recognised mechanically and routed to the oracle's author, never to the Builder.
 */
export const ORACLE_DEFECT =
  /(^|\s|·\s)HARNESS:|\b(ReferenceError|SyntaxError|TypeError|is not defined|is not a function|Cannot measure|Cannot read properties of (undefined|null)|strict mode violation|oracle exit \d+|result line\(s\))/;

export function isOracleDefect(detail: string | undefined | null): boolean {
  return ORACLE_DEFECT.test(String(detail ?? ""));
}

/** Normalise a criterion id from an oracle line ("T9:AC1" or "AC1") to "AC1". */
export const critId = (c: string) => String(c).replace(/^.*:/, "");

/**
 * Calibration against the current main (the feature is absent there). Returns defects of the check itself: missing or invalid result
 * lines and harness/crash signatures. Criteria that simply FAIL on main are expected and are returned as `failsOnMain` so a later
 * repair can be checked for silent loosening.
 */
export function calibrate(expected: string[], results: OracleResult[], stderr = ""): { problems: string[]; failsOnMain: string[]; passesOnMain: string[] } {
  const seen = new Map(results.map((r) => [critId(r.criterion), r]));
  const problems: string[] = [];
  const failsOnMain: string[] = [];
  const passesOnMain: string[] = [];
  for (const k of expected) {
    const r = seen.get(k);
    if (!r) problems.push(`${k}: no result line (the check crashed or skipped it${stderr ? `; stderr: ${stderr.slice(-300)}` : ""})`);
    else if (!["pass", "fail"].includes(r.result)) problems.push(`${k}: invalid result ${JSON.stringify(r.result)}`);
    else if (isOracleDefect(r.detail)) problems.push(`${k}: ${String(r.detail).split("\n")[0]!.slice(0, 300)}`);
    else if (r.result === "fail") failsOnMain.push(k);
    else passesOnMain.push(k);
  }
  return { problems, failsOnMain, passesOnMain };
}

/**
 * A repaired oracle must not be weaker than the one it replaces: every criterion the previous version failed on main (the feature
 * absent) must still fail on main. Otherwise the repair made a check vacuous - refused, whatever the reason.
 */
export function loosenedCriteria(previousFailsOnMain: string[], repairedFailsOnMain: string[]): string[] {
  const now = new Set(repairedFailsOnMain);
  return previousFailsOnMain.filter((k) => !now.has(k));
}
