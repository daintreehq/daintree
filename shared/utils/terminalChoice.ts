/**
 * The keys that move a CLI's highlighted option onto the one labelled
 * `label`, then confirm it, planned from the terminal's visible text.
 *
 * Agent CLIs draw a selection list as one option per row with a marker on the
 * highlighted one (`❯ No, exit`, `› 1. Trust and continue`, `> Yes, I trust
 * this folder`). Which option is highlighted differs between CLIs, so a model
 * that presses Enter on every trust dialog exits the one whose default is
 * "No". Rows indented deeper than an option are wrapped descriptions and are
 * not counted as steps.
 */

const HIGHLIGHT_MARKER = /^\s*[❯›>▶➜→●]\s*/;
const OPTION_PREFIX = /^\s*(?:[❯›>▶➜→●]\s*)?(?:\d+[.)]\s*)?/;

const BOX_LEFT = /^\s*[│┃║]/;
const BOX_RIGHT = /\s*[│┃║]\s*$/;

/** Rows within this distance of the label are searched for the highlight. */
const MAX_LIST_ROWS = 12;
/** Rows above a list read as its question, when no frame or rule closes it sooner. */
const MAX_QUESTION_ROWS = 20;
/** A rule or a box's corner: the edge of a dialog, above which its question can't go on. */
const DIALOG_EDGE = /^\s*(?:[╭┌╔╰└╚]|[─━═]{8,})/;

/**
 * `question` is the dialog the keys were planned on, as text that doesn't
 * change when only its highlight moves: an answer checks it is still the same
 * question before each key it presses.
 */
export type ChoicePlan =
  { ok: true; keys: string[]; question: string } | { ok: false; reason: string };

function indentOf(row: string): number {
  const marker = HIGHLIGHT_MARKER.exec(row);
  const body = marker ? row.slice(marker[0].length) : row;
  return row.length - body.trimStart().length;
}

/**
 * A row with the frame of a boxed dialog taken off — Gemini CLI draws its
 * choices inside `│ … │` — so the option text and its indent are measured
 * from inside the box, the same as an unframed list. A row framed on one side
 * only is left alone.
 */
function unframe(row: string): string {
  // Both sides, or it is not a frame: a tree or a quote can start a row with `│`.
  if (!BOX_LEFT.test(row) || !BOX_RIGHT.test(row)) return row;
  return row.replace(BOX_LEFT, "").replace(BOX_RIGHT, "");
}

/**
 * The question a list on `lines` asks, from the row its first option is on
 * through `last`: the rows above it up to the dialog's edge, and the rows of
 * its options with the highlight taken off, so moving the highlight leaves it
 * the same and a different command, prompt or option makes it differ. Rows
 * below the list (key hints, task lists, status) never count, since they can
 * change while the question doesn't.
 */
function questionText(lines: readonly string[], first: number, last: number): string {
  let top = first;
  while (top > 0 && first - top < MAX_QUESTION_ROWS && !DIALOG_EDGE.test(lines[top - 1]!)) top--;
  return lines
    .slice(top, last + 1)
    .map((row) => row.replace(HIGHLIGHT_MARKER, "").trim())
    .join("\n");
}

export function planChoice(screen: string, label: string): ChoicePlan {
  const wanted = label.trim().toLowerCase();
  if (wanted.length === 0) return { ok: false, reason: "The option label is empty." };
  const lines = screen.split("\n").map(unframe);
  const rows = (i: number): string => lines[i] ?? "";

  // An option row starts with its label, after any marker or number; a
  // heading, a description or echoed text that merely contains it does not.
  // A description column after a wide gap is not part of the label.
  const optionText = (i: number) =>
    (
      rows(i)
        .replace(OPTION_PREFIX, "")
        .trim()
        .split(/\s{2,}/)[0] ?? ""
    ).toLowerCase();
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) if (optionText(i).startsWith(wanted)) candidates.push(i);
  if (candidates.length === 0) {
    return { ok: false, reason: `No option "${label}" is on the screen.` };
  }
  // The newest dialog is the last one drawn, so the last exact label wins;
  // a label that only prefixes two rows of that list is ambiguous.
  const exact = candidates.filter((i) => optionText(i) === wanted);
  let target: number;
  if (exact.length > 0) {
    target = exact[exact.length - 1]!;
  } else {
    const last = candidates[candidates.length - 1]!;
    const inList = candidates.filter((i) => last - i <= MAX_LIST_ROWS);
    if (inList.length > 1) {
      return { ok: false, reason: `More than one option matches "${label}"; use its full label.` };
    }
    target = last;
  }

  let cursor = -1;
  for (let distance = 0; distance <= MAX_LIST_ROWS && cursor === -1; distance++) {
    for (const i of [target - distance, target + distance]) {
      if (i >= 0 && i < lines.length && HIGHLIGHT_MARKER.test(rows(i))) {
        cursor = i;
        break;
      }
    }
  }
  if (cursor === -1) {
    return { ok: false, reason: "No highlighted option is visible near that label." };
  }

  // Option rows start where the highlighted row's text does; deeper rows are
  // a wrapped description of the option above them.
  const optionIndent = indentOf(rows(cursor));
  const isOption = (i: number) =>
    rows(i).trim().length > 0 && indentOf(rows(i)) <= optionIndent + 1;
  const [from, to] = cursor < target ? [cursor + 1, target] : [target, cursor - 1];
  let steps = 0;
  for (let i = from; i <= to; i++) if (isOption(i)) steps++;

  const move = cursor < target ? "Down" : "Up";
  // The list's own rows are those around the label, up to a blank row.
  let first = target;
  while (first > 0 && rows(first - 1).trim() !== "") first--;
  let last = target;
  while (last < lines.length - 1 && rows(last + 1).trim() !== "") last++;
  return {
    ok: true,
    keys: [...Array<string>(steps).fill(move), "Enter"],
    question: questionText(lines, first, last),
  };
}

const NUMBERED_OPTION = /^\s*(?:[❯›>▶➜→●]\s*)?(\d+)[.)]\s+/;
/** The highlight a dialog draws; `>` is left out, since quotes and composers open rows with it. */
const DIALOG_HIGHLIGHT = /^\s*[❯›▶➜→●]\s*\d+[.)]\s+/;
/** A composer sits between full-width rules; a dialog's options never touch one. */
const HORIZONTAL_RULE = /^\s*[─━]{8,}\s*$/;
/** The key hint a dialog draws under its options ("Esc to cancel", "Press enter to confirm"). */
const KEY_HINT = /\b(?:enter|esc)\b/i;
const HINT_VERB = /\b(?:confirm|cancel|select)\b/i;

/** The selection list a screen is asking about right now, as `parseChoiceList` reads it. */
export interface ChoiceList {
  /** Option labels top to bottom, as drawn (the first row of a wrapped one). */
  labels: string[];
  /** Index into `labels` of the highlighted option. */
  cursor: number;
  /** What it asks, the same wherever its highlight is; see `questionText`. */
  question: string;
}

function labelOf(row: string): string {
  return (
    row
      .replace(OPTION_PREFIX, "")
      .trim()
      .split(/\s{2,}/)[0] ?? ""
  ).trim();
}

function optionNumber(row: string): number | null {
  const match = NUMBERED_OPTION.exec(row);
  return match ? Number(match[1]) : null;
}

/**
 * The numbered dialog the screen ends on, or null when the screen isn't
 * plainly asking one. Stricter than `planChoice` on purpose: it backs answers
 * from a device that sends only a label, so anything that could be a
 * composer, a quote or ordinary output reads as no list at all.
 *
 * - The lowest highlighted row is the current surface, and it must be a
 *   numbered option drawn with a dialog's highlight. The input box, an
 *   unnumbered list and a quote never are, and an older dialog above them is
 *   not offered.
 * - The options are the consecutively numbered rows of the block of rows
 *   around it; rows between them are wraps or descriptions, never steps.
 * - A rule in that block means a composer, and a numbered row below it a
 *   newer list with no highlight drawn yet.
 * - A dialog says how to answer it ("Esc to cancel"); a screen without that
 *   hint under the list isn't one.
 * - Two options with the same label can't be told apart, so neither is offered.
 */
export function parseChoiceList(screen: string): ChoiceList | null {
  return readChoiceList(screen.split("\n"), true);
}

/**
 * Whether the bottom of a screen is a numbered selection dialog by
 * `parseChoiceList`'s structure, without its key hint: a short pane can crop
 * the hint, and a classifier that only has to keep text out of a selector
 * should not need it (#14475). Blank rows must be kept, as they bound the list.
 */
export function endsOnChoiceDialog(lines: readonly string[]): boolean {
  return readChoiceList(lines, false) !== null;
}

function readChoiceList(rawLines: readonly string[], requireHint: boolean): ChoiceList | null {
  const lines = rawLines.map(unframe);
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HIGHLIGHT_MARKER.test(lines[i]!)) {
      cursor = i;
      break;
    }
  }
  if (cursor === -1 || !DIALOG_HIGHLIGHT.test(lines[cursor]!)) return null;

  let top = cursor;
  while (top > 0 && lines[top - 1]!.trim() !== "") top--;
  let bottom = cursor;
  while (bottom < lines.length - 1 && lines[bottom + 1]!.trim() !== "") bottom++;
  for (let i = top; i <= bottom; i++) if (HORIZONTAL_RULE.test(lines[i]!)) return null;

  const cursorNumber = optionNumber(lines[cursor]!)!;
  const rows = [cursor];
  let expected = cursorNumber - 1;
  for (let i = cursor - 1; i >= top && expected >= 0; i--) {
    const n = optionNumber(lines[i]!);
    if (n === null) continue;
    if (n !== expected) break;
    rows.unshift(i);
    expected--;
  }
  expected = cursorNumber + 1;
  for (let i = cursor + 1; i <= bottom; i++) {
    const n = optionNumber(lines[i]!);
    if (n === null) continue;
    if (n !== expected) return null;
    rows.push(i);
    expected++;
  }
  for (let i = bottom + 1; i < lines.length; i++) {
    if (optionNumber(lines[i]!) !== null) return null;
  }
  if (rows.length < 2) return null;

  const hinted = lines.slice(cursor + 1).some((row) => KEY_HINT.test(row) && HINT_VERB.test(row));
  if (requireHint && !hinted) return null;

  const labels = rows.map((i) => labelOf(lines[i]!));
  const folded = labels.map((label) => label.toLowerCase());
  if (labels.some((label) => label === "") || new Set(folded).size !== folded.length) return null;
  return {
    labels,
    cursor: rows.indexOf(cursor),
    question: questionText(lines, rows[0]!, rows[rows.length - 1]!),
  };
}

/**
 * The labels as they reached the asker, after `shown`: a paired device is sent
 * them with secrets redacted. Two options that read the same once shown can't
 * be told apart by the asker, so the list is null, as for a raw duplicate.
 */
function shownLabels(list: ChoiceList, shown: (label: string) => string): string[] | null {
  const labels = list.labels.map(shown);
  const folded = labels.map((label) => label.trim().toLowerCase());
  return new Set(folded).size === folded.length ? labels : null;
}

/**
 * The labels a remote page offers as one-key answers: the current list's, or
 * none. `shown` is how each label is sent; `planListedChoice` must be given
 * the same one to answer them.
 */
export function listChoices(
  screen: string,
  shown: (label: string) => string = (text) => text
): string[] {
  const list = parseChoiceList(screen);
  return (list && shownLabels(list, shown)) ?? [];
}

/**
 * `planChoice` for a caller that may only pick from the current list: the
 * label must be one of `parseChoiceList`'s, whole, and the keys move from its
 * highlight to that very option. The label is matched as `shown` sent it,
 * while the keys come from the list as drawn.
 */
export function planListedChoice(
  screen: string,
  label: string,
  shown: (label: string) => string = (text) => text
): ChoicePlan {
  const list = parseChoiceList(screen);
  if (!list) return { ok: false, reason: "No list of options is on the screen." };
  const labels = shownLabels(list, shown);
  if (!labels) {
    return {
      ok: false,
      reason: "Two options on the screen read the same as shown, so neither can be picked.",
    };
  }
  const wanted = label.trim().toLowerCase();
  const index = labels.findIndex((option) => option.trim().toLowerCase() === wanted);
  if (index === -1) return { ok: false, reason: `No option "${label}" is on the screen.` };
  const steps = index - list.cursor;
  const move = steps > 0 ? "Down" : "Up";
  return {
    ok: true,
    keys: [...Array<string>(Math.abs(steps)).fill(move), "Enter"],
    question: list.question,
  };
}
