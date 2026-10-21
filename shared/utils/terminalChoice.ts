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

/**
 * The labels of the selection list drawn nearest the bottom of the screen, in
 * the order shown: what a remote page offers as one-key answers. Only labels
 * `planChoice` can reach are listed, so every one offered presses something,
 * and a lone highlighted row (an echoed `> answer`) is not a list.
 */
export function listChoices(screen: string): string[] {
  const lines = screen.split("\n").map(unframe);
  const optionText = (row: string) =>
    (
      row
        .replace(OPTION_PREFIX, "")
        .trim()
        .split(/\s{2,}/)[0] ?? ""
    ).trim();

  for (let cursor = lines.length - 1; cursor >= 0; cursor--) {
    const row = lines[cursor]!;
    if (!HIGHLIGHT_MARKER.test(row) || optionText(row) === "") continue;
    const optionIndent = indentOf(row);
    const isOption = (i: number) => {
      const indent = indentOf(lines[i]!);
      return indent >= optionIndent - 1 && indent <= optionIndent + 1;
    };
    const isDescription = (i: number) => indentOf(lines[i]!) > optionIndent + 1;
    const rows = [cursor];
    for (const step of [-1, 1]) {
      for (
        let i = cursor + step;
        i >= 0 && i < lines.length && Math.abs(i - cursor) <= MAX_LIST_ROWS;
        i += step
      ) {
        if (lines[i]!.trim() === "") break;
        if (isOption(i)) rows.push(i);
        else if (!isDescription(i)) break;
      }
    }
    rows.sort((a, b) => a - b);
    const labels: string[] = [];
    for (const i of rows) {
      const label = optionText(lines[i]!);
      if (label === "" || labels.includes(label)) continue;
      if (planChoice(screen, label).ok) labels.push(label);
    }
    if (labels.length >= 2) return labels;
  }
  return [];
}
