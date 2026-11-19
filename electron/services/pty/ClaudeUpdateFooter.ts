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

// The command as a word of its own: "(/restart)" names it, "/restart-all" and
// "/restart/x" don't.
const RESTART = /(?<![\w/-])\/restart(?![\w/-])/;

// A rule or box edge across the pane: the composer's bottom border. Two
// single-class tests, each linear: one pattern with overlapping repeats would
// backtrack across a long rule followed by text, on every frame.
const RULE_RUN = /[─━═]{8}/;
const RULE_ONLY = /^[\s─━═╭╮╰╯]+$/;

function isRule(row: string): boolean {
  return RULE_RUN.test(row) && RULE_ONLY.test(row);
}

// The composer's first row: its prompt glyph, inside a box edge on older builds.
const PROMPT_ROW = /^\s*(?:[│┃]\s*)?[❯>](?:\s|$)/;
/** Rows a multi-line draft may take between the composer's edges. */
const MAX_INPUT_ROWS = 8;

function tailOf(lines: readonly string[]): string[] {
  return lines.slice(-SCAN_LINES).map((line) => stripAnsi(line));
}

/** The lowest rule in view: the composer's bottom edge, when Claude is drawn. */
function lastRuleIndex(tail: readonly string[]): number {
  for (let i = tail.length - 1; i >= 0; i--) {
    if (isRule(tail[i]!)) return i;
  }
  return -1;
}

/**
 * Whether the viewport's tail shows Claude's composer: a top edge, a prompt
 * row under it and a bottom edge within a draft's height. A lone rule isn't
 * enough; a shell's output can end with one.
 */
export function hasClaudeComposer(lines: readonly string[]): boolean {
  const tail = tailOf(lines);
  const bottom = lastRuleIndex(tail);
  // A pane short enough to show whole may have clipped the top edge.
  const wholeViewport = lines.length <= SCAN_LINES;
  for (let i = bottom - 1; i >= 0 && bottom - i <= MAX_INPUT_ROWS; i--) {
    if (!PROMPT_ROW.test(tail[i]!)) continue;
    if (i === 0 ? wholeViewport : isRule(tail[i - 1]!)) return true;
  }
  return false;
}

function offerOf(rest: string): string {
  const end = OFFER_END.exec(rest);
  return (end === null ? rest : rest.slice(0, end.index)).trim();
}

/**
 * The "Update installed" footer at the tail of a viewport, below the
 * composer's border when one is in view, the lowest on screen winning, or
 * null. `cols` is the pane's width: a footer row that fills it may continue
 * on the next row, so it is read across the wrap.
 */
export function scanClaudeUpdateFooter(
  lines: readonly string[],
  cols?: number
): ClaudeUpdateFooter | null {
  const tail = tailOf(lines);
  // The footer sits under the composer. With its border in view, rows above
  // it are the transcript, where the agent may well quote the footer.
  const floor = lastRuleIndex(tail);
  for (let i = tail.length - 1; i > floor; i--) {
    const row = tail[i]!;
    const next = tail[i + 1];
    // Only a row whose last column is filled can have wrapped. Rows arrive
    // trimmed and without the blank ones, so a row a column short may be one
    // whose wrap fell on a space, or one a blank row stood under; joining that
    // could build a footer out of two unrelated rows.
    const wrapped = cols !== undefined && next !== undefined && row.length >= cols;
    const text = wrapped ? row + next : row;
    if (!text.includes("Update installed")) continue;
    const match = FOOTER.exec(text);
    if (match === null) continue;
    return { namesRestart: RESTART.test(offerOf(match[1]!)) };
  }
  return null;
}
