import type { WaitingReason } from "../../../shared/types/agent.js";
import { stripAnsi } from "./AgentPatternDetector.js";
import { endsOnChoiceDialog } from "../../../shared/utils/terminalChoice.js";
import { UNIVERSAL_APPROVAL_HINT_PATTERNS } from "./terminalActivityPatterns.js";

/**
 * Number of trailing visible lines the classifier wants to see. Wider than
 * promptScanLineCount (6) because approval dialogs are multi-row: the
 * question sits above 2-4 selector rows, and the input-box chrome below can
 * push it out of a 6-line window.
 */
export const WAITING_REASON_SCAN_LINE_COUNT = 12;

/**
 * Rows Claude Code's task checklist can take under an open dialog — its
 * summary, up to ten items and a fold. A reader adds them to its window, so a
 * checklist is set aside rather than pushing the dialog out of view.
 */
export const WAITING_REASON_CHECKLIST_ROWS = 12;

/**
 * Claude Code's task checklist, drawn at the very bottom under whatever the
 * agent is doing: its "4 tasks (3 done, 1 open)" summary, ✔/◼/◻ items and the
 * "… +2 completed" fold. Only that trailing block is set aside, so a checklist
 * never pushes an open dialog out of view — and a dialog's own ☐ rows, or an
 * old one higher up, are never mistaken for it.
 */
const CHECKLIST_SUMMARY = /^\s*\d+ tasks? \(\d+ done/;
const CHECKLIST_ITEM =
  /^\s*(?:⎿\s*)?(?:✔|◼|◻)\s+\S|^\s*…\s*\+\d+\s+(?:completed|pending|open|in progress)\b/;

/**
 * `lines` without a checklist block at the bottom (and the blank rows under
 * it), cut to `rows`: a dialog above the checklist is seen exactly as it was
 * before Claude drew a checklist under it, and nothing older comes into view.
 * With no checklist, the bottom `rows` are read as drawn, blank rows included.
 */
function withoutTrailingChecklist(lines: string[], rows: number): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  let start = end;
  while (start > 0 && CHECKLIST_ITEM.test(lines[start - 1]!)) start--;
  const hasSummary = start > 0 && CHECKLIST_SUMMARY.test(lines[start - 1]!);
  if (hasSummary) start--;
  // A checklist is its summary line plus items, or at least two items.
  const isChecklist = start < end && (hasSummary || end - start >= 2);
  return (isChecklist ? lines.slice(0, start) : lines).slice(-rows);
}

// Universal hints that are too weak to *classify* on: they appear in ordinary
// agent prose ("I'll suggest changes to the API"), so they stay useful for
// prompt-visibility detection but must not relabel a wait as "approval".
const WEAK_APPROVAL_HINTS = new Set(["suggest\\s+changes", "don['’]t\\s+ask\\s+again"]);

// Approval dialogs render a selector, not a free-text prompt. Structural
// markers only — a bare "…?" line stays a "question".
const APPROVAL_PATTERNS: RegExp[] = [
  // Cursor-marked numbered yes-no selector rows ("❯ 1. Yes", "● 1. Yes, allow
  // once"). The glyph is REQUIRED: agent prose routinely contains unmarked
  // numbered lists ("2. No changes needed") that would otherwise relabel a
  // plain prompt wait as approval. Every real approval dialog renders at
  // least one glyph-marked row (the cursor position) or a companion phrase
  // matched by the patterns below.
  /^\s*[❯›●○◉]\s*\d+[.)]\s*(?:yes\b|no\b|allow\b|deny\b|approve\b|reject\b|don['’]t\b)/i,
  // Tool/edit/command confirmation questions that precede a selector.
  /\bdo you want to (?:proceed|continue|allow|run this|make this edit|create|apply)\b/i,
  /\bpress (?:enter|y) to (?:approve|allow|confirm|continue)\b/i,
  // Antigravity phrases its two non-command approvals as statements rather
  // than "do you want to…", and renders the selector cursor as a bare ">",
  // which the glyph-marked row pattern above deliberately excludes. Without
  // these, a blocked `agy` classified as an ordinary "prompt" wait.
  //
  // Both are anchored to the start of the row (behind optional chrome) and
  // carry the trailing "?", because this array is shared by every agent:
  // unanchored fragments would relabel ordinary prose mid-sentence ("To accept
  // this file edit, pick the first option") as an approval wait.
  /^[\s>❯›●○◉]*accept this (?:file )?edit\?/i,
  /^[\s>❯›●○◉]*do you trust the contents of this (?:project|folder|directory)\b/i,
  // Shared with prompt-hint detection (allow once/always, approve once,
  // trust this directory, [y/n], proceed? [y…), minus the weak hints above.
  ...UNIVERSAL_APPROVAL_HINT_PATTERNS.filter((p) => !WEAK_APPROVAL_HINTS.has(p)).map(
    (p) => new RegExp(p, "i")
  ),
];

// Rate-limit depletion banners. Shared with the pane rate-limit observation
// (#12797), which must not fire on the auth, network and capacity failures
// the wider error list below also matches.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  // A limit phrase only means "blocked" when a
  // depletion verb sits next to it. Bare "usage limit"/"rate limit" is
  // ordinary prose: agent CLIs narrate their own quota in exactly those words
  // ("You have 2 usage limit resets available", "the API rate limits at 50
  // rpm"), and those lines mean the opposite of a block.
  //
  // A verb alone is not enough either. An agent narrates the limit something
  // *else* hit ("retries when the client hit the API rate limit"), asks about
  // one ("Have you hit your usage limit?"), or negates one ("no usage limit
  // was exceeded"). So the second-person forms have to open the line the way
  // a real banner does, and only a quota window may sit between the verb and
  // the limit — "your 5-hour usage limit" is a block, "the section on rate
  // limits" is prose. Passive auxiliaries ("was exceeded", "is reached") are
  // left out for the same reason, as is "hit" after the noun, where it reads
  // as a metric ("rate limit hit count: 0") more often than as a block.
  /\b(?:usage|rate)[ -]?limits?\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted)\b/i,
  // The prefix class carries the gutter, box and pointer glyphs banners are
  // rendered behind (same chrome PROMPT_CHROME_LINE knows about); "-" stays
  // last so it reads as a literal.
  /^[\s•●■▪*>❯›⟩│┃╎╭╰─⚠⎿-]*you(?:['’]ve|['’]re|\s+(?:have|are))?\s+(?:hit|reached|exceeded|exhausted|(?:ran|run) out of)\s+(?:(?:a|the|your|our)\s+)?(?:(?:\d+[ -]?hour|hourly|daily|weekly|monthly|rolling|session)\s+){0,2}?(?:usage|rate)[ -]?limits?\b/i,
  // Claude Code names the window or model instead of saying "usage"
  // ("You've hit your weekly limit · resets Oct 2 at 9pm", "…your Opus
  // limit…"). The window word is what makes it a quota; a bare "your limit"
  // only counts with the "· resets" tail, since "you've hit your limit of 5
  // retries" is prose. A qualified limit may also end the row (a narrow pane
  // wraps the reset time) or run into "Try again"/"Upgrade", but nothing else:
  // "your session limit of 10 tool calls" is an execution budget.
  /^[\s•●■▪*>❯›⟩│┃╎╭╰─⚠⎿-]*you(?:['’]ve|\s+have)?\s+(?:hit|reached)\s+your\s+(?:(?:\d+[ -]?hour|hourly|daily|weekly|monthly|session|opus|sonnet)\s+limit(?:[.!]?\s*$|[.!]?\s+(?:resets|try again|upgrade)\b|\s*[·∙•|-]\s*resets\b)|limit\s*[·∙•|-]\s*resets\b)/i,
  // Older Claude Code builds lead with the window ("5-hour limit reached ∙
  // resets 3pm", "Session limit reached ∙ resets 6pm").
  /^[\s•●■▪*>❯›⟩│┃╎╭╰─⚠⎿-]*(?:\d+[ -]?hour|session)\s+limit\s+reached\s*[·∙•|-]\s*resets\b/i,
  /^[\s•●■▪*>❯›⟩│┃╎╭╰─⚠⎿-]*you(?:['’]ve|['’]re|\s+(?:have|are))\s+(?:being|been)\s+rate[ -]?limited\b/i,
];

// Error-line shapes of a limit that the CLI itself prints. Unanchored in the
// error list, where only the settled tail is read; the observation scans a
// working pane too, where "handle 429 Too Many Requests" is ordinary prose.
const LIMIT_ERROR_PATTERNS: RegExp[] = [
  /\bquota (?:exceeded|reached)\b/i,
  /\btoo many requests\b/i,
];
const LIMIT_ERROR_BANNER_PATTERNS: RegExp[] = [
  /^[\s•●■▪*>❯›⟩│┃╎╭╰─⚠⎿-]*(?:(?:error|warning)\s*:?\s*)?(?:\(?\d{3}\)?:?\s*)?(?:quota (?:exceeded|reached)|too many requests)\b/i,
];

// What the transcript above an agent's input row is read for (#16093): the
// depletion banners the pane observation trusts on a working screen. The broad
// markers below turn up in an agent's own summary of a finished turn
// ("Added retry handling for ECONNRESET"), and read there they would hold
// every send to that pane.
const TRANSCRIPT_ERROR_PATTERNS: RegExp[] = [
  ...RATE_LIMIT_PATTERNS,
  ...LIMIT_ERROR_BANNER_PATTERNS,
];

// Blocking-error markers. Precision over recall: only phrasings that rarely
// appear in agent prose while it is working normally. Bare "error:"/"failed"
// stay out — compiler output scrolling past a settling agent would
// misclassify an ordinary prompt wait as an error wait.
const ERROR_PATTERNS: RegExp[] = [
  ...RATE_LIMIT_PATTERNS,
  ...LIMIT_ERROR_PATTERNS,
  /\boverloaded\b/i,
  /\bcredit balance is too low\b/i,
  /\bout of credits\b/i,
  // Auth
  /\bunauthorized\b/i,
  /\b(?:not |un)authenticated\b/i,
  /\bauthentication (?:error|failed|required)\b/i,
  /\binvalid (?:api key|credentials)\b/i,
  /\bapi key (?:is )?(?:invalid|missing|expired|not set)\b/i,
  /\bplease (?:log ?in|sign ?in|authenticate)\b/i,
  // Network
  /\bnetwork error\b/i,
  /\bconnection (?:refused|reset|failed|error|timed? ?out)\b/i,
  /\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b|\bETIMEDOUT\b|\bEAI_AGAIN\b/,
  /\bfetch failed\b/i,
  // Command / environment failures that stop an agent cold
  /\bcommand not found\b/i,
  /\bis not recognized as an internal or external command\b/i,
  /\bENOENT\b/,
  // Git merge conflicts (git's own summary line)
  /^CONFLICT \(/,
  /\bmerge conflict\b/i,
];

const QUESTION_SUPPRESS_PATTERNS: RegExp[] = [
  /^usage:/i,
  /^options:/i,
  /^\s*--/,
  /\berror:/i,
  /\bexception:/i,
  /\bfailed\b/i,
];

// Sentence case only: a question opens with a capital, while a narrow pane
// wrapping prose starts rows mid-sentence ("…after both" / "are verified.").
// Read as a question, that held every notice the pane had asked for (#13392).
const QUESTION_START_WORDS = /^\s*(What|Where|Which|Why|How|Should|Would|Do|Is|Are|Can|Could)\b/;

// Bare input-box chrome (prompt glyphs, box-drawing borders) — carries no
// classification signal of its own.
const PROMPT_CHROME_LINE = /^[\s>❯›⟩$%#│╭╰─╮╯]*$/;

// Approval dialogs span several rows (question + selector + chrome); error
// banners settle right at the tail. The tighter error window keeps a stale
// error further up the screen from relabelling an ordinary prompt wait.
const APPROVAL_SCAN_LINES = 10;
const ERROR_SCAN_LINES = 4;

/**
 * Why an agent that went idle is waiting, from the bottom `rows` of its screen
 * once a trailing task checklist is set aside; `lines` may carry the checklist's
 * rows on top of them (`WAITING_REASON_CHECKLIST_ROWS`). `composerRow`, when
 * the caller found the agent's input row in `lines`, keeps what is drawn below
 * it out of the error window (#16093): a status footer such as "Usage limit
 * reached · …" can outlive the limit it reported, and only the transcript above
 * the input row says how the turn ended.
 */
export function classifyWaitingReason(
  lines: string[],
  isPromptDetected: boolean,
  rows = WAITING_REASON_SCAN_LINE_COUNT,
  composerRow?: number
): WaitingReason {
  const strippedLines = withoutTrailingChecklist(
    lines.map((l) => stripAnsi(l)),
    rows
  );
  const nonEmpty = strippedLines.filter((l) => l.trim().length > 0);

  // Priority 1: approval selector visible. Checked before the prompt flag —
  // selector rows routinely match prompt patterns ("❯ "), and "approval"
  // is the more specific, more actionable classification.
  const approvalCandidates = nonEmpty.slice(-APPROVAL_SCAN_LINES);
  for (const line of approvalCandidates) {
    if (APPROVAL_PATTERNS.some((p) => p.test(line))) {
      return "approval";
    }
  }
  // A choice selector whose options aren't yes/no ("Which framework?" over
  // "❯ 1. React" / "  2. Vue") takes a specific choice, not free text, so it
  // is an approval wait however its question reads (#14475).
  if (endsOnChoiceDialog(strippedLines)) {
    return "approval";
  }

  // Priority 2: the agent settled right after a blocking error. With its input
  // row known, the window is the transcript above it, so the input's own frame
  // and glyph don't take rows a wrapped banner needs, read for depletion
  // banners only.
  const inputRowKnown = composerRow !== undefined && composerRow >= 0 && composerRow < lines.length;
  const errorCandidates = inputRowKnown
    ? lines
        .slice(Math.max(0, composerRow - rows), composerRow)
        .map((l) => stripAnsi(l))
        .filter((l) => l.trim().length > 0 && !PROMPT_CHROME_LINE.test(l))
        .slice(-ERROR_SCAN_LINES)
    : nonEmpty.slice(-ERROR_SCAN_LINES);
  const errorPatterns = inputRowKnown ? TRANSCRIPT_ERROR_PATTERNS : ERROR_PATTERNS;
  for (const line of errorCandidates) {
    if (errorPatterns.some((p) => p.test(line))) {
      return "error";
    }
  }

  // Priority 3: question heuristics. Checked before the prompt flag because
  // agents ask their question and then redraw the input box below it — the
  // prompt chrome is always visible, but the question is the salient signal.
  // Bare chrome rows ("> ", "❯") are ignored when picking the tail window so
  // they don't push the question out of view.
  // Suppression is scoped to the candidate lines themselves — a stale
  // "failed"/"error:" further up the (now wider) window must not veto a real
  // trailing question like "The build failed." → "How should I proceed?".
  const contentLines = nonEmpty.filter((l) => !PROMPT_CHROME_LINE.test(l));
  const questionCandidates = contentLines.slice(-3);
  const hasSuppression = questionCandidates.some((line) =>
    QUESTION_SUPPRESS_PATTERNS.some((p) => p.test(line))
  );

  if (!hasSuppression) {
    for (const line of questionCandidates) {
      if (line.trim().endsWith("?")) {
        return "question";
      }
      if (QUESTION_START_WORDS.test(line) && line.trim().length < 200) {
        return "question";
      }
    }
  }

  // Priority 4: PromptDetector saw a standard prompt.
  if (isPromptDetected) {
    return "prompt";
  }

  // Default: if we're going idle, a prompt is the safest assumption
  return "prompt";
}

/**
 * Trailing rows scanned for a rate-limit banner: a banner sits at the tail
 * when it lands, and one scrolled far up is old news.
 */
const RATE_LIMIT_SCAN_LINES = 12;

/** Whether the tail of a viewport shows an agent's rate-limit banner (#12797). */
export function hasRateLimitMessage(lines: readonly string[]): boolean {
  const tail = lines.slice(-RATE_LIMIT_SCAN_LINES);
  for (const line of tail) {
    const stripped = stripAnsi(line);
    if (RATE_LIMIT_PATTERNS.some((p) => p.test(stripped))) return true;
    if (LIMIT_ERROR_BANNER_PATTERNS.some((p) => p.test(stripped))) return true;
  }
  return false;
}
