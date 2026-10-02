export const TITLE_MAX = 100;

/**
 * Display form of a long title: at most `max` Unicode code points including a final "…".
 * Breaks at the last word boundary that fits (no half words); titles that fit are returned unchanged.
 */
export function shortenTitle(title: string, max = TITLE_MAX): string {
  const chars = Array.from(title);
  if (chars.length <= max) return title;
  const head = chars.slice(0, max - 1);
  let cut = head.length;
  // the cut splits a word unless the next character is whitespace: back off to the last whitespace that fits
  if (!/\s/.test(chars[max - 1]!)) {
    const space = head.findLastIndex((c) => /\s/.test(c));
    if (space > 0) cut = space;
  }
  const kept = head.slice(0, cut).join("").trimEnd() || head.join("").trimEnd();
  return `${kept}…`;
}
