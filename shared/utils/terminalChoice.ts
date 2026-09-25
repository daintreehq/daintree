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

/** Rows within this distance of the label are searched for the highlight. */
const MAX_LIST_ROWS = 12;

export type ChoicePlan = { ok: true; keys: string[] } | { ok: false; reason: string };

function indentOf(row: string): number {
  const marker = HIGHLIGHT_MARKER.exec(row);
  const body = marker ? row.slice(marker[0].length) : row;
  return row.length - body.trimStart().length;
}

export function planChoice(screen: string, label: string): ChoicePlan {
  const wanted = label.trim().toLowerCase();
  if (wanted.length === 0) return { ok: false, reason: "The option label is empty." };
  const lines = screen.split("\n");
  const rows = (i: number): string => lines[i] ?? "";

  let target = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (rows(i).toLowerCase().includes(wanted)) {
      target = i;
      break;
    }
  }
  if (target === -1) return { ok: false, reason: `No option "${label}" is on the screen.` };

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
