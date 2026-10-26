export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * A span of a draft that follows edits made around it. `edited` latches once
 * a change touches the span's own text, so an owner can refuse to overwrite
 * text it no longer wrote.
 */
export interface TrackedTextRange {
  from: number;
  to: number;
  edited: boolean;
}

/**
 * The one change that turns `current` into `next`, leaving their common start
 * and end untouched. A draft written from outside — a plugin handoff appended
 * below the user's text, a voice insert — arrives as a whole new string; as a
 * whole-document replacement it would drop every chip field entry it overlaps,
 * image attachments included, even though that text did not change.
 *
 * Where the edit sits inside a run of identical characters the strings can't
 * say which one was typed, so the change lands as late in the run as it can.
 */
export function minimalDocChange(current: string, next: string): TextChange | null {
  if (current === next) return null;
  const shorter = Math.min(current.length, next.length);
  let start = 0;
  while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (
    endCurrent > start &&
    endNext > start &&
    current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)
  ) {
    endCurrent--;
    endNext--;
  }
  return { from: start, to: endCurrent, insert: next.slice(start, endNext) };
}

/**
 * Carries `range` through `change`. Text inserted at either boundary stays
 * outside the range, so typing straight after a dictation doesn't join it;
 * text typed strictly inside joins it. A change that reaches into the range's
 * own text flags it edited and trims the range to what survives. An empty
 * range is a point: it moves past text inserted at it and is never edited.
 */
export function mapTextRange(range: TrackedTextRange, change: TextChange): TrackedTextRange {
  const delta = change.insert.length - (change.to - change.from);
  if (change.to <= range.from) {
    return { ...range, from: range.from + delta, to: range.to + delta };
  }
  if (change.from >= range.to) return range;

  const from = range.from < change.from ? range.from : change.from + change.insert.length;
  const to = range.to > change.to ? range.to + delta : change.from;
  return {
    from,
    to: Math.max(from, to),
    edited: range.edited || range.from < range.to,
  };
}

/**
 * Carries a span through `change`, keeping every edit that reaches its text:
 * where `mapTextRange` trims to what survives, this grows over whatever the
 * change wrote, so a word retyped at either end stays inside. Text inserted at
 * either boundary still stays outside.
 */
export function mapSpanKeepingEdits(
  span: { from: number; to: number },
  change: TextChange
): { from: number; to: number } {
  const delta = change.insert.length - (change.to - change.from);
  if (change.to <= span.from) return { from: span.from + delta, to: span.to + delta };
  if (change.from >= span.to) return span;
  return {
    from: Math.min(span.from, change.from),
    to: Math.max(span.to + delta, change.from + change.insert.length),
  };
}
