import { stripAnsi } from "./AgentPatternDetector.js";

/**
 * Claude Code's "Update installed" footer as seen (#17905): only whether the
 * text after its `·` named `/restart`. The line itself is terminal content and
 * stays in the pty host.
 */
export interface ClaudeUpdateFooter {
  namesRestart: boolean;
}

/** Trailing rows read: the footer sits under the prompt, at the bottom. */
const SCAN_LINES = 12;

// Glyphs reach the String.raw pattern as `${}` strings, which the build
// escapes; a tagged template's own text ships as written (#17023).
// The success mark Claude draws first: its status tick, the Windows fallback,
// and the check its package-manager updater prints.
const TICKS = "✔✓√";
const SEPARATORS = "·∙•";
const BORDERS = "▔▁─━╮╯╗╝│┃";

// Claude Code 2.1.328 draws "✔ Update installed · <offer>" from its native
// updater, where the offer is a server-set string ("/restart to apply" by
// default) or "Restart to update"; "✔ Update installed · restart to apply"
// from its npm updater; and "✓ Update installed via <manager> · restart to
// apply" from its package-manager updater. The head is what tells it from the
// plugin ("✔ <plugin> installed · restart to apply") and settings ("<file>
// changed; restart to apply") notices, which end the same way. It starts a
// row, follows a column gap (flush right beside the footer's hints) or
// follows a separator (appended to them); anywhere else it is someone's text.
const FOOTER = new RegExp(
  String.raw`(?:^|\s{2}|[${SEPARATORS}]\s)[${BORDERS}\s]*[${TICKS}]\s?Update installed(?: via [^\s${SEPARATORS}]+)?\s+[${SEPARATORS}]\s+(.*)$`
);

// The offer ends at the next separator or column gap: what follows is another
// notice or warning sharing the row.
const OFFER_END = new RegExp(String.raw`\s*[${SEPARATORS}]|\s{2}`);

const RESTART = /(?:^|\s)\/restart(?![\w-])/;

function offerOf(rest: string): string {
  const end = OFFER_END.exec(rest);
  return (end === null ? rest : rest.slice(0, end.index)).trim();
}

/**
 * The "Update installed" footer at the tail of a viewport, the lowest on
 * screen winning, or null. `cols` is the pane's width: a footer row that fills
 * it may continue on the next row, so it is read across the wrap.
 */
export function scanClaudeUpdateFooter(
  lines: readonly string[],
  cols?: number
): ClaudeUpdateFooter | null {
  const tail = lines.slice(-SCAN_LINES).map((line) => stripAnsi(line));
  for (let i = tail.length - 1; i >= 0; i--) {
    const row = tail[i]!;
    const next = tail[i + 1];
    // Rows arrive trimmed, so a wrap that fell on a space ends a column short;
    // padding back to the width restores the space the join needs.
    const wrapped = cols !== undefined && next !== undefined && row.length >= cols - 1;
    const text = wrapped ? row.padEnd(cols) + next : row;
    if (!text.includes("Update installed")) continue;
    const match = FOOTER.exec(text);
    if (match === null) continue;
    return { namesRestart: RESTART.test(offerOf(match[1]!)) };
  }
  return null;
}
