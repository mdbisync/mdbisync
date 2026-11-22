import { MarkdownLimitError } from '../format/markdown.ts';

export type Range = { start: number; end: number };
export type WideningRange = Range & { conflict?: true };

export const CONFLICT_WIDENING_WORK_LIMIT = 4_000_000;

/** Return the strictly overlapping components that contain a conflict. Sorts ranges in place. */
export function widenConflictRanges(ranges: WideningRange[]): Range[] {
  // Reserve one step per interval for the sweep, then count sort comparisons.
  let work = ranges.length;
  if (work > CONFLICT_WIDENING_WORK_LIMIT) throw new MarkdownLimitError('widening');
  ranges.sort((a, b) => {
    if (++work > CONFLICT_WIDENING_WORK_LIMIT) throw new MarkdownLimitError('widening');
    return a.start - b.start;
  });

  const widened: Range[] = [];
  let component: Range | undefined;
  let hasConflict = false;
  for (const range of ranges) {
    // Half-open intervals that only touch belong to separate components.
    if (component && range.start < component.end) {
      component.end = Math.max(component.end, range.end);
      hasConflict ||= range.conflict === true;
    } else {
      if (component && hasConflict) widened.push(component);
      component = { start: range.start, end: range.end };
      hasConflict = range.conflict === true;
    }
  }
  if (component && hasConflict) widened.push(component);
  return widened;
}
