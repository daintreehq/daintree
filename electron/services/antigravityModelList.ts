import { stripVTControlCharacters } from "node:util";

export interface AgyListedModel {
  id: string;
  name: string;
}

// `<id>  <Display Name>`: the id, then a gap of two or more spaces (or a tab).
// A single space never separates them, so prose can't read as a row, and an
// id ends on a letter or digit, so a label (`Error:  …`) can't either.
const MODEL_ROW = /^([A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?)(?: {2,}|\t+)(\S.*)$/;
// A marker some list printers put before the current choice: `*`, `>`, `•`,
// `●` or `✓`, escaped so Main's startup chunk stays one byte per character.
const ROW_MARKER = /^[*>\u2022\u25CF\u2713]\s+/;

/**
 * Reads `agy models` output into its model rows, in printed order.
 *
 * agy prints spinner frames while it fetches the list over the network, and it
 * repaints them in place: a carriage return, an erase-line sequence, the next
 * frame. So every VT sequence is stripped, and each line is read as the last
 * frame written over it, which is what a terminal would have shown.
 */
export function parseAgyModelsOutput(output: string): AgyListedModel[] {
  const models: AgyListedModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stripVTControlCharacters(output).split("\n")) {
    const frames = rawLine.replace(/\r+$/, "").split("\r");
    const line = frames[frames.length - 1]!.trim().replace(ROW_MARKER, "");
    const match = MODEL_ROW.exec(line);
    if (!match) continue;
    const id = match[1]!;
    // A row agy didn't mean as a model becomes `--model <it>` and fails the
    // launch, while a missed row only narrows the list. Every model id agy
    // lists is hyphenated (`gemini-4-carbon-high`), and padded words that
    // have a row's shape (`ID  NAME`, `WARNING  …`, `login  Sign in`) aren't.
    if (!id.includes("-") || id.includes("://") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: match[2]!.trim() });
  }
  return models;
}
