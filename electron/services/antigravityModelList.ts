import { stripVTControlCharacters } from "node:util";

export interface AgyListedModel {
  id: string;
  name: string;
}

// `<id>  <Display Name>`: the id, then a gap of two or more spaces (or a tab).
// A single space never separates them, so prose and notices can't read as rows.
const MODEL_ROW = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?: {2,}|\t+)(\S.*)$/;
// A marker some list printers put before the current choice.
const ROW_MARKER = /^[*>•●✓]\s+/;

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
    // A column header (`ID  NAME`) has the row's shape; an id never lacks
    // lowercase letters and digits both.
    if (!/[a-z0-9]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: match[2]!.trim() });
  }
  return models;
}
