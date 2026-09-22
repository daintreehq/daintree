/**
 * Positions in a source file.
 *
 * Offsets are UTF-16 code-unit indices into the original string — the same
 * units Svelte's parser reports, and the units every range in this package is
 * measured in.
 */

export function lineColumnToOffset(source: string, line: number, column: number): number | null {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 0) return null;

  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const next = source.indexOf("\n", offset);
    if (next === -1) return null;
    offset = next + 1;
    currentLine++;
  }

  const lineEnd = source.indexOf("\n", offset);
  const hardEnd = lineEnd === -1 ? source.length : lineEnd;
  const target = offset + column;
  // Allow the position one past the last character of the line (a column at the
  // line break itself), but never past the break into the following line.
  return target <= hardEnd ? target : null;
}
