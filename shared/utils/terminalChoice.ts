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

export type ChoicePlan = { ok: true; keys: string[] } | { ok: false; reason: string };

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
  return { ok: true, keys: [...Array<string>(steps).fill(move), "Enter"] };
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
  const lines = screen.split("\n").map(unframe);
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
  if (!hinted) return null;

  const labels = rows.map((i) => labelOf(lines[i]!));
  const folded = labels.map((label) => label.toLowerCase());
  if (labels.some((label) => label === "") || new Set(folded).size !== folded.length) return null;
  return { labels, cursor: rows.indexOf(cursor) };
}

/** The labels a remote page offers as one-key answers: the current list's, or none. */
export function listChoices(screen: string): string[] {
  return parseChoiceList(screen)?.labels ?? [];
}

/**
 * `planChoice` for a caller that may only pick from the current list: the
 * label must be one of `parseChoiceList`'s, whole, and the keys move from its
 * highlight to that very option.
 */
export function planListedChoice(screen: string, label: string): ChoicePlan {
  const list = parseChoiceList(screen);
  if (!list) return { ok: false, reason: "No list of options is on the screen." };
  const wanted = label.trim().toLowerCase();
  const index = list.labels.findIndex((option) => option.toLowerCase() === wanted);
  if (index === -1) return { ok: false, reason: `No option "${label}" is on the screen.` };
  const steps = index - list.cursor;
  const move = steps > 0 ? "Down" : "Up";
  return { ok: true, keys: [...Array<string>(Math.abs(steps)).fill(move), "Enter"] };
}
