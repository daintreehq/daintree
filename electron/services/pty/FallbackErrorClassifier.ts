import { stripAnsiCodes } from "../../../shared/utils/artifactParser.js";

/**
 * Classification of why an agent PTY exited. Only `connection` and `auth`
 * indicate a fallback is warranted — `rate-limit` and `user-error` are the
 * provider/user's problem and the user should see/fix them directly.
 */
export type FallbackExitClass =
  | "connection" // 5xx, ECONNREFUSED, DNS, timeout
  | "auth" // 401/403-class, revoked tokens, "Not logged in"
  | "rate-limit" // 429, quota, RESOURCE_EXHAUSTED — NEVER triggers fallback
  | "user-error" // prompt too long, context overflow, tool rejection
  | "clean"; // no matching signal

const CONNECTION_PATTERNS: RegExp[] = [
  // HTTP 5xx server-class
  /\bAPI Error:\s*(?:5\d\d|Repeated\s+5\d\d|Repeated\s+529\s+Overloaded|Overloaded)/i,
  /\b(?:502|503|504)\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /INTERNAL|UNAVAILABLE/,

  // Connection/DNS/timeout
  /\bECONNREFUSED|\bENOTFOUND|\bETIMEDOUT|\bECONNRESET/,
  /\bUnable to connect to (?:the )?API/i,
  /\bgetaddrinfo\s+ENOTFOUND/i,
  /\bCould not resolve host/i,
  /\bfailed to connect to\b/i,
  /\bError on conversation request\b/i,
  /\bpoor internet connection/i,
];

const AUTH_PATTERNS: RegExp[] = [
  // Generic
  /\bNot logged in\b/i,
  /\bInvalid API key\b/i,
  /\bUNAUTHENTICATED\b|\bPERMISSION_DENIED\b/,
  /\b401\s+Unauthorized\b|\b403\s+Forbidden\b/i,
  /\borganization has been (?:disabled|suspended)\b/i,

  // Claude-specific
  /\bPlease run\s+\/login\b/i,
  /\bOAuth token (?:revoked|has expired|is invalid)/i,

  // Codex-specific
  /\bTo use .*? must be logged in\b/i,
  /\bInvalid OAuth token\b/i,
];

// Evaluated before connection/auth so a 429 cannot be misread as a 5xx.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\bAPI Error:\s*Rate limit/i,
  /\b429\b/,
  /\brate[\s-]?limit(?:ed|ing)?\b/i,
  /\bRESOURCE_EXHAUSTED\b/,
  /\brateLimitExceeded\b/i,
  /\bquota exceeded\b/i,
  /\bToo Many Requests\b/i,
];

const USER_ERROR_PATTERNS: RegExp[] = [
  /\bPrompt is too long\b/i,
  /\bRequest too large\b/i,
  /\bcontext (?:window|length) exceeded\b/i,
  /\binput is too long\b/i,
];

export interface ClassifyInput {
  /** Recent PTY output (ANSI sequences allowed; they are stripped before matching). */
  recentOutput: string;
  /** Process exit code (optional — used only for `clean` short-circuit). */
  exitCode?: number | null;
  /** True when the terminal was intentionally killed by the user/app. */
  wasKilled?: boolean;
}

/**
 * Classifies the tail of a PTY output stream at exit-time. Pure function, no
 * side effects. Safe to call synchronously inside onExit handlers.
 *
 * Precedence: rate-limit and user-error patterns are evaluated first so they
 * can short-circuit connection-class matching (a 429 response often contains
 * the substring "API Error:" which would otherwise match a 5xx pattern).
 */
export function classifyExitOutput(input: ClassifyInput): FallbackExitClass {
  if (input.wasKilled) return "clean";
  // A clean exit means the agent handled the error itself and chose to quit —
  // scanning the tail for leftover "UNAVAILABLE" / "5xx" chatter would produce
  // false positives, e.g. an agent that retried a 503, succeeded, and then
  // exited normally.
  if (input.exitCode === 0) return "clean";
  const stripped = stripAnsiCodes(input.recentOutput ?? "");
  if (!stripped.trim()) return "clean";

  // Scan only the tail — connection/auth failures always print near the end.
  const tail = stripped.length > 4000 ? stripped.slice(-4000) : stripped;

  if (RATE_LIMIT_PATTERNS.some((p) => p.test(tail))) return "rate-limit";
  if (USER_ERROR_PATTERNS.some((p) => p.test(tail))) return "user-error";
  if (AUTH_PATTERNS.some((p) => p.test(tail))) return "auth";
  if (CONNECTION_PATTERNS.some((p) => p.test(tail))) return "connection";
  return "clean";
}

/** Whether a classification warrants switching to the next fallback preset. */
export function shouldTriggerFallback(cls: FallbackExitClass): boolean {
  return cls === "connection" || cls === "auth";
}
