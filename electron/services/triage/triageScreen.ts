import { createHash } from "node:crypto";

/**
 * Box frames and quote gutters agent CLIs draw around dialogs. Taken off both
 * ends of a row so the classifier reads the words, not the frame.
 */
const FRAME = /^[\s│▌╭╮╰╯─┃┏┓┗┛║]+|[\s│▌╭╮╰╯─┃┏┓┗┛║]+$/g;

/**
 * Rows every agent draws permanently — its empty input box and status footer.
 *
 * They are always on screen, so to a reader they look like a prompt waiting
 * for input. Leaving them in made the classifier pick "Ask Codex to do
 * anything" as the question being asked on a third of finished runs.
 */
const CHROME =
  /^(?:>|›|❯)\s*(?:Ask Codex to do anything|Type your message or @path\/to\/file)?\s*$|accept edits on \(shift\+tab|\d+% context left|Context left(?: until auto-compact)?: \d+%|\? for shortcuts|no sandbox\s+\S|bypass permissions on|⏵⏵\s*(?:auto mode|accept edits|bypass permissions|plan mode) on\b|auto mode on \(shift\+tab|Transcript saving is off\b/;

/**
 * The suggestion an empty input box shows as placeholder text: Claude Code's
 * `> Try "fix typecheck errors"`, and Codex's rotating `› Explain this
 * codebase`-style prompts. They read exactly like a question to a classifier —
 * a live session was carded as asking "Try "fix typecheck errors"" — and they
 * are never something the agent asked.
 */
const PLACEHOLDER =
  /^(?:>|›|❯)\s*(?:Try ".*"|Explain this codebase|Summarize recent commits|Implement \{feature\}|Find and fix a bug in @filename|Write tests for @filename|Improve documentation in @filename|Run \/review on my current changes|Use \/skills to list available skills)\s*$/;

const AGENT_BULLET = /^(?:⏺|•|✦|●|▌|■|⎿)\s*/;

/**
 * Obvious credentials, so the screen that leaves the machine carries none of
 * them. A best-effort net, not a guarantee: anything shaped like a known key
 * or an `x=secret` assignment is replaced before the text is sent.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // `KEY=value`, `export FOO_API_KEY=value`, `"token": "value"`, `password: value`.
  // The name may carry a prefix (`CEREBRAS_API_KEY`), which a word boundary
  // before `api` would miss.
  // A quoted value is taken whole, spaces and escaped quotes included.
  /([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*\2/gi,
  /([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*)[^\s"',}]{6,}/gi,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `extra` is exact strings to remove wherever they appear — the provider keys
 * themselves, which no pattern is guaranteed to recognise.
 */
export function redactSecrets(text: string, extra: readonly string[] = []): string {
  let out = text;
  for (const secret of extra) {
    if (secret.length >= 8) out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: unknown) => {
      if (typeof prefix !== "string" || !match.startsWith(prefix)) return "[redacted]";
      return /[\s:=]$/.test(prefix) ? `${prefix}[redacted]` : `${prefix} [redacted]`;
    });
  }
  return out;
}

export interface PreparedScreen {
  /** Cleaned rows, newest last. */
  lines: string[];
  /** The cleaned rows joined, already redacted — the only form that is sent. */
  text: string;
  /**
   * Identity of the screen for change detection. Digits are folded so a ticking
   * spinner timer ("38s", "2.1k tokens") does not count as a change; anything
   * else that moves on screen does.
   */
  hash: string;
  /** The newest meaningful row, for the card's live activity line. */
  activity: string | null;
}

/**
 * What only moves because time passes: spinner frames, elapsed timers, token
 * counters, retry attempts. Folded for the change hash so a working agent's
 * ticking status line is not a new screen — and nothing else is, so a real
 * question that differs only by a number still counts as changed.
 */
const TICKING = [
  /[✻✶✢✳✽✺·*⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g,
  /\b\d+[hm]\s?\d+[ms]\b/g,
  /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h|k)\b/g,
  /\b\d+(?:\.\d+)?k?\s+tokens\b/g,
  /\battempt \d+\/\d+/g,
];

function foldTicking(text: string): string {
  let out = text;
  for (const pattern of TICKING) out = out.replace(pattern, "#");
  return out.replace(/#(?:\s*#)+/g, "#");
}

export function prepareScreen(raw: string, extraSecrets: readonly string[] = []): PreparedScreen {
  const lines: string[] = [];
  for (const row of raw.replace(/\r/g, "").split("\n")) {
    const line = row.replace(FRAME, "").replace(/\s{3,}/g, "  ");
    if (CHROME.test(line) || PLACEHOLDER.test(line)) continue;
    // Collapse runs of blank rows; a dialog's spacing carries no meaning here.
    if (line.length === 0 && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const text = redactSecrets(lines.join("\n"), extraSecrets);
  const hash = createHash("sha1").update(foldTicking(text)).digest("hex");
  return { lines: text.split("\n"), text, hash, activity: findActivity(lines, extraSecrets) };
}

function findActivity(lines: readonly string[], extraSecrets: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length < 4) continue;
    return redactSecrets(line.replace(AGENT_BULLET, ""), extraSecrets).slice(0, 160);
  }
  return null;
}

export { isSecretPrompt } from "../../../shared/utils/secretPrompt.js";
