/**
 * The first sentence of a palette row's description. A built-in whose manifest
 * description is written for agents declares a `paletteDescription` instead,
 * but plugin descriptions and the rest can still run on into notes ("This is
 * a …", "It accepts a subset of …") that truncate mid-clause in a one-line row.
 * The row shows what the entry does; search still reads the whole description.
 */
export function paletteSummary(description: string): string {
  const match = /^(.+?(?<!\b\w)[.!?])(\s+[A-Z]|$)/.exec(description.trim());
  const sentence = match ? match[1]! : description.trim();
  return sentence.replace(/\.$/, "");
}
