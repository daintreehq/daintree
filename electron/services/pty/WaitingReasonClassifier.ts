import type { WaitingReason } from "../../../shared/types/agent.js";
import { stripAnsi } from "./AgentPatternDetector.js";
import { UNIVERSAL_APPROVAL_HINT_PATTERNS } from "./terminalActivityPatterns.js";

/**
 * Number of trailing visible lines the classifier wants to see. Wider than
 * promptScanLineCount (6) because approval dialogs are multi-row: the
 * question sits above 2-4 selector rows, and the input-box chrome below can
 * push it out of a 6-line window.
 */
export const WAITING_REASON_SCAN_LINE_COUNT = 12;

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
  // Shared with prompt-hint detection (allow once/always, approve once,
  // trust this directory, [y/n], proceed? [y…), minus the weak hints above.
  ...UNIVERSAL_APPROVAL_HINT_PATTERNS.filter((p) => !WEAK_APPROVAL_HINTS.has(p)).map(
    (p) => new RegExp(p, "i")
  ),
];

// Blocking-error markers. Precision over recall: only phrasings that rarely
// appear in agent prose while it is working normally. Bare "error:"/"failed"
// stay out — compiler output scrolling past a settling agent would
// misclassify an ordinary prompt wait as an error wait.
const ERROR_PATTERNS: RegExp[] = [
  // Rate limiting / capacity
  /\brate.?limit(?:ed|s)?\b/i,
  /\bquota (?:exceeded|reached)\b/i,
  /\busage limit\b/i,
  /\btoo many requests\b/i,
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

const QUESTION_START_WORDS = /^\s*(what|where|which|why|how|should|would|do|is|are|can|could)\b/i;

// Bare input-box chrome (prompt glyphs, box-drawing borders) — carries no
// classification signal of its own.
const PROMPT_CHROME_LINE = /^[\s>❯›⟩$%#│╭╰─╮╯]*$/;

// Approval dialogs span several rows (question + selector + chrome); error
// banners settle right at the tail. The tighter error window keeps a stale
// error further up the screen from relabelling an ordinary prompt wait.
const APPROVAL_SCAN_LINES = 10;
const ERROR_SCAN_LINES = 4;

export function classifyWaitingReason(lines: string[], isPromptDetected: boolean): WaitingReason {
  const strippedLines = lines.map((l) => stripAnsi(l));
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

  // Priority 2: the agent settled right after a blocking error.
  const errorCandidates = nonEmpty.slice(-ERROR_SCAN_LINES);
  for (const line of errorCandidates) {
    if (ERROR_PATTERNS.some((p) => p.test(line))) {
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
