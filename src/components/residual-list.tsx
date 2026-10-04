export type ResidualGroups = { review: string[]; noted: string[] };

/**
 * What an open decision would accept without proof, under its explanation in the task page's "Your decision" section. With the
 * kinds of its recorded decision record (acceptance) the lines are split into "Needs your review" then "Noted"; a group without
 * items is not shown. Without them the lines stay one flat list. Nothing at all when there are no lines.
 */
export function ResidualList({ lines, groups }: { lines: string[]; groups: ResidualGroups | null }) {
  if (!lines.length) return null;
  if (!groups) return <Items lines={lines} className="mt-2" />;
  const shown = [
    { label: "Needs your review", lines: groups.review },
    { label: "Noted", lines: groups.noted },
  ].filter((g) => g.lines.length);
  if (!shown.length) return null;
  return (
    <div className="mt-2 max-w-3xl space-y-2 text-sm text-ink-2">
      {shown.map((g) => (
        <div key={g.label}>
          <div className="font-medium">{g.label}</div>
          <Items lines={g.lines} className="mt-0.5" />
        </div>
      ))}
    </div>
  );
}

function Items({ lines, className }: { lines: string[]; className: string }) {
  return (
    <ul className={`${className} max-w-3xl list-disc pl-5 text-sm text-ink-2`}>
      {lines.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}
