const HIGHLIGHTED = /^(\s*)([❯›▶➜→●]) (\s*\d+[.)])/;
const OPTION = /^(\s*) {2}(\d+[.)])/;

/**
 * The screen once an agent has drawn the key it was sent: an arrow moves a
 * numbered list's highlight to the next or previous option, as the agent CLIs
 * do, and any other key leaves the screen as it was.
 */
export function redrawFor(screen: string, data: string): string {
  const step = data === "\x1b[B" ? 1 : data === "\x1b[A" ? -1 : 0;
  if (step === 0) return screen;
  const rows = screen.split("\n");
  const from = rows.findIndex((row) => HIGHLIGHTED.test(row));
  if (from === -1) return screen;
  for (let i = from + step; i >= 0 && i < rows.length; i += step) {
    if (!OPTION.test(rows[i]!)) continue;
    const marker = HIGHLIGHTED.exec(rows[from]!)![2]!;
    rows[from] = rows[from]!.replace(HIGHLIGHTED, "$1  $3");
    rows[i] = rows[i]!.replace(OPTION, `$1${marker} $2`);
    return rows.join("\n");
  }
  return screen;
}
