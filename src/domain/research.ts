/*
 * RESEARCH qualification pack (evaluation only - no research class is routed anywhere).
 * Eight bounded research task classes, each a small contract: a fixed instruction, a JSON schema, a bounded input and a
 * DETERMINISTIC gate (schema, vocabulary, grounding - no number, source id or quote that the input does not contain - and the
 * unambiguous part of the pinned reference). Judgement (usefulness, sound reasoning, no guessed values) is the independent
 * Verifier's: EVERY gate-passing research output goes to it. Gate problems carry a category so failures can be counted by kind:
 * [schema] [hallucination] [omission] [instruction] [reference].
 */
import type { SemanticSpec } from "./semantic";

export const RESEARCH_CLASSES = ["research_planning", "query_planning", "evidence_extraction", "source_assessment", "contradiction_detection", "opportunity_analysis", "evidence_summary", "opportunity_card"] as const;
export type ResearchClass = (typeof RESEARCH_CLASSES)[number];

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (props: Json, required: string[], extra: Json = {}): Json => ({ type: "object", properties: props, required, ...extra });
const en = (vs: readonly string[]) => ({ type: "string", enum: [...vs] });
const S = { type: "string" };
const low = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const plain = (s: string) => low(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));

/** Numbers a text states (digits with separators, optional decimals). "S3"-style source ids and list positions are not numbers. */
export function numbersIn(text: string): string[] {
  const all = (text.replace(/\bS\d+\b/g, " ").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ""))));
  // small whole numbers are counts and ordinals of ordinary prose ("two sources", "3 of 5"), not figures of the evidence
  return [...new Set(all)].filter((n) => !(/^\d{1,2}$/.test(n) && Number(n) <= 12));
}
/** Numbers in `text` that the input does not contain: an invented figure. */
export function ungroundedNumbers(input: string, text: string): string[] {
  const have = new Set(numbersIn(input));
  return numbersIn(text).filter((n) => !have.has(n));
}
const allText = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map(allText).join(" ") : isObj(v) ? Object.values(v).map(allText).join(" ") : typeof v === "number" ? String(v) : "");
const idsIn = (input: string) => new Set(input.match(/\bS\d+\b/g) ?? []);
const badIds = (input: string, ids: unknown[]) => ids.map(String).filter((i) => !idsIn(input).has(i));

export const PLAN_CATEGORIES = ["demand", "competition", "pricing", "customer", "feasibility", "risk", "legal"] as const;
export const CHANNELS = ["marketplace", "web", "community", "official", "primary_source"] as const;
export const DIMENSIONS = ["demand", "competition", "pricing", "customer_signal", "feasibility", "risk"] as const;
const ACADEMIC = /history of|literature review|theoretical|academic|philosoph|sociolog|definition of|define what|taxonomy of/i;

const SOURCE_RULES = `Source rules:
- "primary" = the origin of the data itself: official statistics, registries and guidance; a platform's, supplier's or competitor's own pages, listings, price lists, quotes, policies and data exports; your own measurements; surveys published by the body that ran them; first-hand accounts by the people concerned (forum and community posts, polls, user reviews).
- "secondary" = a report about someone else's data or an estimate built on it: news and magazine articles, blogs, newsletters, podcast and video transcripts, analytics tools, keyword tools, pricing indexes, benchmarks and market reports.
- "weak" evidence = anecdotes from a few individuals, small polls, unverified or promotional claims, statements without data, and any copy of another source. "strong" = official or first-party data directly on the point. Everything else is "moderate".
- A source that merely repeats another source's figure or statement (syndication, "X reports") is a duplicate of the earlier-dated source and adds no independent evidence.`;

export const RESEARCH: Record<ResearchClass, SemanticSpec & { rubric: string }> = {
  research_planning: {
    system: `You plan research for a small online business deciding whether to pursue a product opportunity. Given the business question, list the research questions that must be answered to decide. Answer with JSON only:
{"questions": [{"q": "...", "category": "...", "evidence": "..."}], "out_of_scope": ["..."]}
- 4 to 8 questions, each one sentence ending with "?", each directly useful for the decision. No background, academic or historical questions.
- category is exactly one of: demand, competition, pricing, customer, feasibility, risk, legal. Cover at least demand, competition, pricing, and feasibility or risk.
- evidence: the concrete evidence that would answer the question (what data, from what kind of source).
- out_of_scope: 0 to 4 topics deliberately left out because they do not affect the decision.`,
    schema: obj({ questions: { type: "array", items: obj({ q: S, category: en(PLAN_CATEGORIES), evidence: S }, ["q", "category", "evidence"]) }, out_of_scope: { type: "array", items: S } }, ["questions", "out_of_scope"]),
    maxInput: 2000, maxTokens: 900, verifier: true,
    rubric: "Pass only if every question is directly useful for deciding the stated business question, the set covers what must be known (demand, competition, pricing, feasibility or risk), each 'evidence' names evidence that could actually answer its question, and there is no irrelevant, academic or redundant question.",
    structural: (_input, o) => {
      const p: string[] = []; const qs = arr(o.questions);
      if (qs.length < 4 || qs.length > 8) p.push(`[instruction] ${qs.length} questions (4 to 8 required)`);
      const seen = new Set<string>();
      for (const x of qs) {
        if (!isObj(x) || !str(x.q).trim() || !str(x.evidence).trim()) { p.push("[schema] a question lacks q or evidence"); continue; }
        if (!(PLAN_CATEGORIES as readonly string[]).includes(str(x.category))) p.push("[schema] category is not in the vocabulary");
        if (!str(x.q).trim().endsWith("?")) p.push("[instruction] a question does not end with a question mark");
        if (ACADEMIC.test(str(x.q))) p.push(`[instruction] academic or background question: ${str(x.q).slice(0, 60)}`);
        if (seen.has(low(str(x.q)))) p.push("[instruction] duplicate question");
        seen.add(low(str(x.q)));
      }
      if (!Array.isArray(o.out_of_scope) || o.out_of_scope.length > 4) p.push("[schema] out_of_scope is not a list of at most four topics");
      return [...new Set(p)];
    },
    agree: (o) => {
      const cats = new Set(arr(o.questions).map((x) => (isObj(x) ? str(x.category) : "")));
      const p: string[] = [];
      for (const c of ["demand", "competition", "pricing"]) if (!cats.has(c)) p.push(`[omission] no question on ${c}`);
      if (!cats.has("feasibility") && !cats.has("risk")) p.push("[omission] no question on feasibility or risk");
      return p;
    },
  },
  query_planning: {
    system: `You plan searches for product-opportunity research. Given the business question and the product, list the search queries to run. Answer with JSON only:
{"queries": [{"query": "...", "channel": "...", "purpose": "..."}]}
- 6 to 12 queries of 2 to 14 words each, written as they would be typed. No two queries may ask for the same thing in different words.
- channel is exactly one of: "marketplace" (searching a sales marketplace or its listings), "web" (general web search), "community" (forums, groups, review threads where customers or sellers talk), "official" (government, regulator or statistics-office sources), "primary_source" (a named supplier, competitor or platform's own pages, price lists, terms or data).
- Use at least marketplace, community, and official or primary_source. Most queries must name the product.
- purpose: what the result is needed for (one short phrase).`,
    schema: obj({ queries: { type: "array", items: obj({ query: S, channel: en(CHANNELS), purpose: S }, ["query", "channel", "purpose"]) } }, ["queries"]),
    maxInput: 2000, maxTokens: 900, verifier: true,
    rubric: "Pass only if the queries would realistically retrieve what the business question needs, each query's channel fits where that query would actually be run (marketplace vs general web vs community vs official vs a named primary source), and there are no redundant queries.",
    structural: (_input, o) => {
      const p: string[] = []; const qs = arr(o.queries);
      if (qs.length < 6 || qs.length > 12) p.push(`[instruction] ${qs.length} queries (6 to 12 required)`);
      const sets: Set<string>[] = [];
      for (const x of qs) {
        if (!isObj(x) || !str(x.query).trim() || !str(x.purpose).trim()) { p.push("[schema] a query lacks query or purpose"); continue; }
        if (!(CHANNELS as readonly string[]).includes(str(x.channel))) p.push("[schema] channel is not in the vocabulary");
        const words = low(str(x.query)).split(" ").filter(Boolean);
        if (words.length < 2 || words.length > 14) p.push("[instruction] a query is not 2 to 14 words");
        sets.push(new Set(words));
      }
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i]!, b = sets[j]!; const inter = [...a].filter((w) => b.has(w)).length;
        if (inter / (a.size + b.size - inter) >= 0.8) p.push("[instruction] two queries are near-duplicates");
      }
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const p: string[] = []; const qs = arr(o.queries).filter(isObj);
      const ch = new Set(qs.map((x) => str(x.channel)));
      if (!ch.has("marketplace")) p.push("[omission] no marketplace query");
      if (!ch.has("community")) p.push("[omission] no community query");
      if (!ch.has("official") && !ch.has("primary_source")) p.push("[omission] no official or primary-source query");
      const terms = arr(e.terms).map((t) => low(String(t)));
      const named = qs.filter((x) => terms.some((t) => low(str(x.query)).includes(t))).length;
      if (qs.length && named / qs.length < 0.6) p.push(`[instruction] only ${named} of ${qs.length} queries name the product`);
      return p;
    },
  },
  evidence_extraction: {
    system: `You extract facts from a source document for a research file. Answer with JSON only:
{"facts": [{"claim": "...", "quote": "...", "value": <string or null>, "date": <string or null>, "qualifier": <string or null>}]}
- One entry per fact the document actually states. At most 12. Do not infer, combine, calculate or generalise: a fact that is not written in the document must not appear.
- claim: the fact in one sentence, keeping every number, unit, date and qualifier exactly as written.
- quote: the passage that states it, copied VERBATIM from the document.
- value: the main number with its unit exactly as written (e.g. "$8.00", "18,400 searches"), or null when the fact has no number.
- date: the date or period the fact refers to exactly as written, or null.
- qualifier: a hedging word the document attaches to the fact exactly as written (e.g. "estimated", "approximately", "about", "typically", "projected", "roughly", "over"), or null when it is stated without hedging. Never drop a qualifier.`,
    schema: obj({ facts: { type: "array", items: obj({ claim: S, quote: S, value: { type: ["string", "null"] }, date: { type: ["string", "null"] }, qualifier: { type: ["string", "null"] } }, ["claim", "quote", "value", "date", "qualifier"]) } }, ["facts"]),
    maxInput: 3000, maxTokens: 1500, verifier: true,
    rubric: "Pass only if every fact is actually stated in the input document, no fact is inferred, calculated or generalised, numbers, units, dates and hedging qualifiers are preserved, and no fact the document states with a hedge is presented as certain.",
    structural: (input, o) => {
      const p: string[] = []; const fs = arr(o.facts);
      if (fs.length < 1 || fs.length > 12) p.push(`[instruction] ${fs.length} facts (1 to 12 required)`);
      const hay = plain(input);
      for (const f of fs) {
        if (!isObj(f) || !str(f.claim).trim() || !str(f.quote).trim()) { p.push("[schema] a fact lacks claim or quote"); continue; }
        if (!hay.includes(plain(str(f.quote)))) p.push(`[hallucination] quote is not verbatim: ${str(f.quote).slice(0, 50)}`);
        const u = ungroundedNumbers(input, `${str(f.claim)} ${str(f.value)} ${str(f.date)}`);
        if (u.length) p.push(`[hallucination] number not in the document: ${u.slice(0, 3).join(", ")}`);
        for (const k of ["value", "date", "qualifier"] as const) if (f[k] !== null && (typeof f[k] !== "string" || !hay.includes(plain(str(f[k]))))) p.push(`[hallucination] ${k} is not text of the document: ${str(f[k]).slice(0, 40)}`);
      }
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const p: string[] = []; const fs = arr(o.facts).filter(isObj).map((f) => ({ text: plain(`${str(f.claim)} ${str(f.quote)}`), all: plain(allText(f)) }));
      for (const r of arr(e.required) as { tokens: string[]; qualifier?: string | null }[]) {
        const hit = fs.filter((f) => r.tokens.every((t) => f.text.includes(plain(t))));
        if (hit.length === 0) p.push(`[omission] stated fact missing: ${r.tokens.join(" / ")}`);
        else if (r.qualifier && !hit.some((f) => f.all.includes(plain(r.qualifier!)))) p.push(`[omission] qualifier "${r.qualifier}" dropped from: ${r.tokens.join(" / ")}`);
      }
      return p;
    },
  },
  source_assessment: {
    system: `You assess the sources of a research file. Answer with JSON only:
{"sources": [{"id": "...", "kind": "primary" or "secondary", "strength": "strong" or "moderate" or "weak", "duplicate_of": <source id or null>, "reason": "..."}], "independent_count": <integer>}
- One entry per source, in the order given, with its id.
- duplicate_of: the id of the earlier-dated source whose figure or statement this source merely repeats, otherwise null. The original is never a duplicate.
- independent_count: the number of sources that are not duplicates.
- reason: one short sentence using only what the source entry says.
${SOURCE_RULES}`,
    schema: obj({ sources: { type: "array", items: obj({ id: S, kind: en(["primary", "secondary"]), strength: en(["strong", "moderate", "weak"]), duplicate_of: { type: ["string", "null"] }, reason: S }, ["id", "kind", "strength", "duplicate_of", "reason"]) }, independent_count: { type: "integer" } }, ["sources", "independent_count"]),
    maxInput: 5000, maxTokens: 1000, verifier: true,
    rubric: "Pass only if each source's primary/secondary and strength assessment follows the source rules given in the instruction, duplicates are identified so that copies are not counted as independent evidence, and each reason is supported by the source entry (no invented facts about a source).",
    structural: (input, o) => {
      const p: string[] = []; const ss = arr(o.sources); const ids = [...idsIn(input)];
      if (ss.length !== ids.length || !ss.every((s, i) => isObj(s) && s.id === ids[i])) p.push("[instruction] not exactly one entry per source in the order given");
      for (const s of ss) {
        if (!isObj(s)) { p.push("[schema] a source entry is not an object"); continue; }
        if (!["primary", "secondary"].includes(str(s.kind)) || !["strong", "moderate", "weak"].includes(str(s.strength))) p.push("[schema] kind or strength is not in the vocabulary");
        if (s.duplicate_of !== null && (!idsIn(input).has(str(s.duplicate_of)) || s.duplicate_of === s.id)) p.push("[hallucination] duplicate_of is not another source of the file");
        const u = ungroundedNumbers(input, str(s.reason));
        if (u.length) p.push(`[hallucination] reason uses a number not in the file: ${u.slice(0, 3).join(", ")}`);
      }
      if (!Number.isInteger(o.independent_count)) p.push("[schema] independent_count is not an integer");
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const p: string[] = []; const by = new Map(arr(o.sources).filter(isObj).map((s) => [str(s.id), s]));
      for (const r of arr(e.sources) as { id: string; kind: string; strength: string; duplicate_of: string | null }[]) {
        const s = by.get(r.id); if (!s) continue;
        if (str(s.kind) !== r.kind) p.push(`[reference] ${r.id}: ${str(s.kind)} (reference ${r.kind})`);
        if ((s.duplicate_of ?? null) !== r.duplicate_of) p.push(`[reference] ${r.id}: duplicate_of ${JSON.stringify(s.duplicate_of ?? null)} (reference ${JSON.stringify(r.duplicate_of)})`);
        if (r.strength === "weak" && str(s.strength) !== "weak") p.push(`[reference] ${r.id}: weak evidence rated ${str(s.strength)}`);
        if (r.strength === "strong" && str(s.strength) === "weak") p.push(`[reference] ${r.id}: strong first-party data rated weak`);
      }
      if (o.independent_count !== e.independent_count) p.push(`[reference] independent_count ${String(o.independent_count)} (reference ${String(e.independent_count)})`);
      return p;
    },
  },
  contradiction_detection: {
    system: `You check a research file for contradictions between its sources. Answer with JSON only:
{"contradictions": [{"a": "<source id>", "b": "<source id>", "about": "..."}], "resolvable": true or false, "resolution": <string or null>, "note": "..."}
- A contradiction is two sources that state incompatible things about the SAME quantity or question, for the same subject and period. Different subjects, different periods (a current value and a planned future one), or a source that repeats another are NOT contradictions.
- List each contradicting pair once (a = the smaller id). Use [] when there is none.
- resolvable: true only when the file itself settles the conflict, for example a later correction by the same publisher. A better-looking source is not enough. When there is no contradiction, resolvable is false.
- resolution: when resolvable, the value that stands and why, in one sentence; otherwise null. Never choose a side when the file does not settle it.
- note: one sentence; say what further evidence would settle an unresolved conflict, or that there is none.`,
    schema: obj({ contradictions: { type: "array", items: obj({ a: S, b: S, about: S }, ["a", "b", "about"]) }, resolvable: { type: "boolean" }, resolution: { type: ["string", "null"] }, note: S }, ["contradictions", "resolvable", "resolution", "note"]),
    maxInput: 5000, maxTokens: 600, verifier: true,
    rubric: "Pass only if exactly the genuinely conflicting source pairs are identified (same quantity, subject and period), no side is chosen when the file does not settle the conflict, any resolution is one the file itself supports, and nothing is invented.",
    structural: (input, o) => {
      const p: string[] = [];
      for (const c of arr(o.contradictions)) {
        if (!isObj(c) || badIds(input, [c.a, c.b]).length || c.a === c.b) p.push("[hallucination] a contradiction names a source that is not in the file");
      }
      if (typeof o.resolvable !== "boolean") p.push("[schema] resolvable is not a boolean");
      if (o.resolvable === false && o.resolution !== null) p.push("[instruction] a resolution is given although the conflict is not resolvable");
      if (o.resolvable === true && !str(o.resolution).trim()) p.push("[instruction] resolvable without a resolution");
      const u = ungroundedNumbers(input, `${allText(o.contradictions)} ${str(o.resolution)} ${str(o.note)}`);
      if (u.length) p.push(`[hallucination] number not in the file: ${u.slice(0, 3).join(", ")}`);
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const key = (a: unknown, b: unknown) => [String(a), String(b)].sort().join("~");
      const got = [...new Set(arr(o.contradictions).filter(isObj).map((c) => key(c.a, c.b)))].sort().join(",");
      const want = (arr(e.pairs) as string[][]).map((x) => key(x[0], x[1])).sort().join(",");
      const p: string[] = [];
      if (got !== want) p.push(`[reference] contradictions [${got}] (reference [${want}])`);
      if (o.resolvable !== e.resolvable) p.push(`[reference] resolvable ${String(o.resolvable)} (reference ${String(e.resolvable)})`);
      return p;
    },
  },
  opportunity_analysis: {
    system: `You analyse a product opportunity from a research file, one dimension at a time. Answer with JSON only: an object with exactly these six keys - "demand", "competition", "pricing", "customer_signal", "feasibility", "risk" - each {"finding": "...", "evidence": ["<source id>", ...], "status": "supported" or "weak" or "unknown"}.
- demand = how many people want or search for it; competition = who else sells it and how crowded it is; pricing = what it sells for; customer_signal = what buyers themselves say they want or complain about; feasibility = what it costs and takes to produce and deliver; risk = legal, platform, quality or market threats.
- finding: what the file establishes for that dimension, in one or two sentences, using only figures the file contains.
- evidence: the ids of the sources the finding rests on.
- status: "supported" when at least one source that is not weak backs it; "weak" when it rests only on weak sources; "unknown" when the file has nothing on that dimension - then finding must be exactly "UNKNOWN" and evidence must be [].
- Never fill a gap with general knowledge, and never compute or estimate a figure the file does not state.
${SOURCE_RULES}`,
    schema: obj(Object.fromEntries(DIMENSIONS.map((d) => [d, obj({ finding: S, evidence: { type: "array", items: S }, status: en(["supported", "weak", "unknown"]) }, ["finding", "evidence", "status"])])), [...DIMENSIONS], { additionalProperties: false }),
    maxInput: 5000, maxTokens: 1200, verifier: true,
    rubric: "Pass only if each dimension's finding is established by the cited sources, the six dimensions are kept apart (no finding placed under the wrong dimension), no metric is invented, computed or taken from general knowledge, and weakly supported findings are not presented as established.",
    structural: (input, o) => {
      const p: string[] = [];
      const keys = Object.keys(o).sort().join(",");
      if (keys !== [...DIMENSIONS].sort().join(",")) p.push("[schema] the object does not have exactly the six dimension keys");
      for (const d of DIMENSIONS) {
        const x = o[d]; if (!isObj(x)) { p.push(`[schema] ${d} is not an object`); continue; }
        if (!["supported", "weak", "unknown"].includes(str(x.status))) p.push(`[schema] ${d}: status is not in the vocabulary`);
        const bad = badIds(input, arr(x.evidence)); if (bad.length) p.push(`[hallucination] ${d}: cites ${bad.join(", ")}, which is not in the file`);
        if (x.status === "unknown" && (str(x.finding).trim() !== "UNKNOWN" || arr(x.evidence).length)) p.push(`[instruction] ${d}: unknown without the exact finding UNKNOWN and empty evidence`);
        if (x.status !== "unknown" && (!arr(x.evidence).length || str(x.finding).trim() === "UNKNOWN")) p.push(`[instruction] ${d}: a finding without evidence`);
        const u = ungroundedNumbers(input, str(x.finding)); if (u.length) p.push(`[hallucination] ${d}: number not in the file: ${u.slice(0, 3).join(", ")}`);
      }
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const p: string[] = []; const ref = e.dims as Record<string, { ids: string[]; onlyWeak: boolean }>;
      for (const d of DIMENSIONS) {
        const x = o[d]; const r = ref[d]!; if (!isObj(x)) continue;
        if (r.ids.length === 0) { if (x.status !== "unknown") p.push(`[hallucination] ${d}: the file has nothing on it, but a finding is given`); continue; }
        if (x.status === "unknown") { p.push(`[omission] ${d}: evidence in the file (${r.ids.join(", ")}) was not used`); continue; }
        if (!arr(x.evidence).some((i) => r.ids.includes(String(i)))) p.push(`[reference] ${d}: cites none of ${r.ids.join(", ")}`);
        if (r.onlyWeak && x.status === "supported") p.push(`[reference] ${d}: rests only on weak sources but is marked supported`);
      }
      return p;
    },
  },
  evidence_summary: {
    system: `You summarise a research file for the business owner. Answer with JSON only:
{"summary": "...", "supported": [{"claim": "...", "sources": ["<source id>", ...]}], "uncertain": ["..."], "unknown": ["..."]}
- supported: findings backed by at least one source that is not weak; each with the ids it rests on. A finding that rests only on weak sources, or on which sources contradict each other, does NOT belong here.
- uncertain: findings that rest only on weak sources, hedged figures, and contradictions, each stated with its uncertainty.
- unknown: what the decision needs but the file does not contain.
- summary: at most 700 characters, built only from the lists above; it must say what is uncertain or unknown. State no cause, trend or conclusion the file does not state. Use only figures the file contains.
${SOURCE_RULES}`,
    schema: obj({ summary: S, supported: { type: "array", items: obj({ claim: S, sources: { type: "array", items: S } }, ["claim", "sources"]) }, uncertain: { type: "array", items: S }, unknown: { type: "array", items: S } }, ["summary", "supported", "uncertain", "unknown"]),
    maxInput: 5000, maxTokens: 1200, verifier: true,
    rubric: "Pass only if every statement in the summary and the lists is supported by the file, uncertainty and hedges are preserved, weakly supported or contradicted findings are not presented as established, and no cause, trend or conclusion is invented.",
    structural: (input, o) => {
      const p: string[] = []; const s = str(o.summary);
      if (s.trim().length < 80 || s.length > 750) p.push("[instruction] summary shorter than 80 or longer than 750 characters");
      for (const c of arr(o.supported)) {
        if (!isObj(c) || !str(c.claim).trim() || !arr(c.sources).length) { p.push("[schema] a supported claim lacks claim or sources"); continue; }
        const bad = badIds(input, arr(c.sources)); if (bad.length) p.push(`[hallucination] cites ${bad.join(", ")}, which is not in the file`);
      }
      if (!Array.isArray(o.uncertain) || !Array.isArray(o.unknown)) p.push("[schema] uncertain or unknown is not a list");
      const u = ungroundedNumbers(input, allText(o)); if (u.length) p.push(`[hallucination] number not in the file: ${u.slice(0, 4).join(", ")}`);
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const p: string[] = []; const weak = new Set(arr(e.weak).map(String));
      for (const c of arr(o.supported).filter(isObj)) if (arr(c.sources).length && arr(c.sources).every((i) => weak.has(String(i)))) p.push(`[reference] presented as supported on weak sources only: ${str(c.claim).slice(0, 70)}`);
      const unc = low(`${allText(o.uncertain)} ${allText(o.unknown)}`);
      if (!arr(o.uncertain).length) p.push("[omission] nothing is listed as uncertain although the file has weak evidence");
      for (const g of arr(e.uncertain) as string[][]) if (!g.some((t) => unc.includes(low(t)))) p.push(`[omission] the uncertainty about ${g.slice(0, 2).join(" / ")} is not preserved`);
      return p;
    },
  },
  opportunity_card: {
    system: `You fill in an Opportunity Card from a research file. Answer with JSON only, with exactly these keys and no others:
{"title": "...", "product": "...", "target_customer": "...", "price_range": {"low": <number or "UNKNOWN">, "high": <number or "UNKNOWN">, "currency": "<ISO code or UNKNOWN>"}, "demand_signal": "...", "competition_level": "low" or "medium" or "high" or "UNKNOWN", "monthly_sales_estimate": <number or "UNKNOWN">, "production_method": "...", "main_risk": "...", "evidence_ids": ["<source id>", ...], "confidence": "low" or "medium" or "high"}
- Every value must come from the file. When the file does not state it, write exactly "UNKNOWN" - for text fields too. Never guess, and never compute a figure the file does not state.
- price_range: the lowest and highest selling price the file gives for this kind of product (the same number twice when only one price is given); prices are in US dollars when written with "$".
- monthly_sales_estimate: a number only when the file states sales or orders per month for this product; otherwise "UNKNOWN".
- evidence_ids: the sources the card rests on.
- confidence: how well the file supports the card overall.`,
    schema: obj({ title: S, product: S, target_customer: S, price_range: obj({ low: { type: ["number", "string"] }, high: { type: ["number", "string"] }, currency: S }, ["low", "high", "currency"], { additionalProperties: false }), demand_signal: S, competition_level: en(["low", "medium", "high", "UNKNOWN"]), monthly_sales_estimate: { type: ["number", "string"] }, production_method: S, main_risk: S, evidence_ids: { type: "array", items: S }, confidence: en(["low", "medium", "high"]) },
      ["title", "product", "target_customer", "price_range", "demand_signal", "competition_level", "monthly_sales_estimate", "production_method", "main_risk", "evidence_ids", "confidence"], { additionalProperties: false }),
    maxInput: 5000, maxTokens: 900, verifier: true,
    rubric: "Pass only if every card value is stated in the file or is exactly UNKNOWN, no value is guessed, inferred from general knowledge or computed, and the cited evidence ids support the card.",
    structural: (input, o) => {
      const p: string[] = [];
      const want = ["title", "product", "target_customer", "price_range", "demand_signal", "competition_level", "monthly_sales_estimate", "production_method", "main_risk", "evidence_ids", "confidence"];
      if (Object.keys(o).sort().join(",") !== [...want].sort().join(",")) p.push("[schema] the card does not have exactly the required keys");
      const pr = o.price_range;
      const numOrUnknown = (v: unknown) => typeof v === "number" || v === "UNKNOWN";
      if (!isObj(pr) || !numOrUnknown(pr.low) || !numOrUnknown(pr.high) || !str(pr.currency) || Object.keys(pr).sort().join(",") !== "currency,high,low") p.push("[schema] price_range is not {low, high, currency} with numbers or UNKNOWN");
      if (!numOrUnknown(o.monthly_sales_estimate)) p.push("[schema] monthly_sales_estimate is neither a number nor UNKNOWN");
      if (!["low", "medium", "high", "UNKNOWN"].includes(str(o.competition_level)) || !["low", "medium", "high"].includes(str(o.confidence))) p.push("[schema] competition_level or confidence is not in the vocabulary");
      for (const k of ["title", "product", "target_customer", "demand_signal", "production_method", "main_risk"]) if (!str(o[k]).trim()) p.push(`[schema] ${k} is empty (write UNKNOWN when the file does not state it)`);
      if (!arr(o.evidence_ids).length) p.push("[instruction] no evidence ids"); else { const bad = badIds(input, arr(o.evidence_ids)); if (bad.length) p.push(`[hallucination] cites ${bad.join(", ")}, which is not in the file`); }
      const u = ungroundedNumbers(input, allText(o)); if (u.length) p.push(`[hallucination] number not in the file: ${u.slice(0, 4).join(", ")}`);
      return [...new Set(p)];
    },
    agree: (o, e) => {
      const p: string[] = []; const pr = isObj(o.price_range) ? o.price_range : {};
      const pairs = arr(e.prices) as [number, number][];
      if (!pairs.some(([l, h]) => pr.low === l && pr.high === h)) p.push(`[reference] price_range ${JSON.stringify(pr.low)}-${JSON.stringify(pr.high)} (reference ${pairs.map((x) => x.join("-")).join(" or ")})`);
      if (str(pr.currency) !== "USD") p.push(`[reference] currency ${str(pr.currency)} (reference USD)`);
      const sales = arr(e.sales);
      if (!sales.includes(o.monthly_sales_estimate as never)) p.push(`[hallucination] monthly_sales_estimate ${JSON.stringify(o.monthly_sales_estimate)} (the file supports ${sales.map((x) => JSON.stringify(x)).join(" or ")})`);
      return p;
    },
  },
};
