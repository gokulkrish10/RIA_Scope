// Presentation helper only: no new JSON contract fields and no server dependencies.
export type DiffSegment = { kind: 'equal' | 'removed' | 'added'; text: string };
/** Linear, deterministic token diff. A single changed middle span avoids quadratic work. */
export function highlightDiff(before: string, after: string): DiffSegment[] {
  const left = before.match(/\s+|[^\s]+/g) ?? [];
  const right = after.match(/\s+|[^\s]+/g) ?? [];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  const parts: DiffSegment[] = [
    { kind: 'equal', text: left.slice(0, start).join('') },
    { kind: 'removed', text: left.slice(start, left.length - end).join('') },
    { kind: 'added', text: right.slice(start, right.length - end).join('') },
    { kind: 'equal', text: end ? left.slice(-end).join('') : '' },
  ];
  return parts.filter(part => part.text.length > 0);
}
