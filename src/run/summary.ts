// Labels and escaping shared by the run's Markdown summaries.
import { type Place } from '../mapping/index.ts';

export function placeLabel(place: Place): string {
  return place.kind === 'project' ? `project "${place.project}" of team "${place.team}"` : `team "${place.team}"`;
}

/** A table cell: pipes, backslashes and line breaks would break the row. */
export function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}
