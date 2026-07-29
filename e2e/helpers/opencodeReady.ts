// Pure decision logic for the OpenCode online gate (#11476). The Playwright
// driver lives in e2e/online/opencode-online.spec.ts; everything that can be
// decided from a terminal snapshot alone lives here so it can be unit-tested
// without a 6-minute credentialed E2E run.
//
// Background: the `opencode` CLI can die at startup inside its own keymap
// parser with `Invalid key name: key name cannot be empty`. That throw sits on
// the runtime key-decode path (an incoming keystroke whose name normalizes to
// empty) and is NOT wrapped by the CLI's `[Keymap] Error` handler, so it kills
// the process. Driving synthetic keypresses into a TUI that has not finished
// attaching its raw-mode stdin reader is the trigger we can control, hence the
// stabilization gate below.

export type OpenCodeOutputKind =
  "crashed" | "needs-restart" | "ready" | "awaiting-api-key" | "awaiting-provider" | "pending";

export type OpenCodeClassification =
  | { kind: "crashed"; signature: string }
  | { kind: "needs-restart" }
  | { kind: "ready" }
  | { kind: "awaiting-api-key" }
  | { kind: "awaiting-provider" }
  | { kind: "pending" };

/** Kinds that make the driver send a keystroke — the only ones the gate delays. */
export type ActionableOpenCodeKind = "awaiting-api-key" | "awaiting-provider";

export const OPENCODE_CRASH_SIGNATURE = "Invalid key name: key name cannot be empty";

// The buffer reader returns one string per terminal ROW
// (`translateToString(true)` joined with "\n"), so a message wider than the
// terminal wraps and the row break can land mid-word — "can" / "not be empty".
// Comparing with whitespace collapsed out entirely is the only wrap-robust way
// to require the complete message. Matching a prefix like "invalid key name"
// alone, or the CLI's `[Keymap] Error` label, is deliberately avoided: that
// label also fronts recoverable upstream errors, and a false-positive fatal
// detector would fail releases that would otherwise pass.
const CRASH_NEEDLE = OPENCODE_CRASH_SIGNATURE.replace(/\s+/g, "").toLowerCase();

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

export function hasOpenCodeCrashSignature(text: string): boolean {
  return collapseWhitespace(text).includes(CRASH_NEEDLE);
}

export function classifyOpenCodeOutput(text: string): OpenCodeClassification {
  // Crash outranks everything: a TUI that painted a ready prompt and then died
  // still has the ready text sitting in the buffer above the stack trace.
  if (hasOpenCodeCrashSignature(text)) {
    return { kind: "crashed", signature: OPENCODE_CRASH_SIGNATURE };
  }

  const lower = text.toLowerCase();

  if (lower.includes("update complete") && lower.includes("restart the application")) {
    return { kind: "needs-restart" };
  }

  if (
    lower.includes("ask anything") ||
    /build\s+opencode/i.test(text) ||
    /\d+\.\d+\.\d+$/.test(text.trim())
  ) {
    return { kind: "ready" };
  }

  // API key before provider: a key prompt names the provider it wants a key
  // for, so the broader provider match would swallow it and send Enter where
  // the flow needs ArrowUp + Enter.
  if (lower.includes("api key")) return { kind: "awaiting-api-key" };
  if (lower.includes("provider") || lower.includes("/connect")) {
    return { kind: "awaiting-provider" };
  }

  return { kind: "pending" };
}

export function isActionableOpenCodeKind(kind: OpenCodeOutputKind): kind is ActionableOpenCodeKind {
  return kind === "awaiting-api-key" || kind === "awaiting-provider";
}

// No ANSI stripping here on purpose: both sources getTerminalText can return
// are already escape-free — xterm resolves sequences before
// __daintreeReadTerminalBuffer reads cells, and the DOM fallback reads
// rendered innerText. A control-character regex would be dead code.
//
// Spinners repaint every frame, so a TUI showing one is never byte-identical
// twice; folding the known frame sets to one sentinel lets an otherwise-static
// screen count as settled. Only the unambiguous non-ASCII sets are folded —
// braille (U+2800-U+28FF) and the circle/quadrant glyphs are used by nothing
// else. The ASCII `|/-\` spinner is deliberately NOT folded: those characters
// carry meaning in paths and prose, and collapsing them could make genuinely
// different screens compare equal. Unrecognized spinners are covered by the
// max-wait fallback instead.
const SPINNER_FRAMES = /[⠀-⣿◢-◥◰-◳◐-◓]/g;

export function normalizeOpenCodeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(SPINNER_FRAMES, "·").trimEnd())
    .join("\n")
    .replace(/\n+$/, "");
}

export function areOpenCodeOutputsEquivalent(left: string, right: string): boolean {
  return normalizeOpenCodeOutput(left) === normalizeOpenCodeOutput(right);
}

export type StabilizationPolicy = {
  /** Consecutive equivalent snapshots required before a keystroke is allowed. */
  requiredSamples: number;
  /** Cap on how long one actionable prompt may be held back. */
  maxWaitMs: number;
};

// Four samples at the driver's 500ms poll gives ~1.5s of settled output before
// the first keystroke. maxWaitMs bounds the case the sample streak can never
// be met — an unrecognized animation repainting forever — so the gate always
// terminates instead of burning the ready deadline.
export const DEFAULT_STABILIZATION_POLICY: StabilizationPolicy = {
  requiredSamples: 4,
  maxWaitMs: 5_000,
};

export type StabilizationState = {
  kind: ActionableOpenCodeKind | null;
  normalized: string | null;
  sampleCount: number;
  firstSeenAt: number;
};

export type StabilizationDecision = "wait" | "act" | "not-actionable";

export function initialStabilizationState(): StabilizationState {
  return { kind: null, normalized: null, sampleCount: 0, firstSeenAt: 0 };
}

/**
 * Fold one polled snapshot into the gate. Pure and timestamp-driven so tests
 * can drive it with explicit clocks instead of real or faked timers.
 *
 * A different actionable kind restarts the gate outright. Changed text within
 * the same kind resets only the equivalent-sample streak — deliberately NOT
 * `firstSeenAt`, or an animated prompt would reset its own cap every poll and
 * never reach the fallback.
 */
export function observeOpenCodeOutput(
  state: StabilizationState,
  observation: { kind: OpenCodeOutputKind; text: string; now: number },
  policy: StabilizationPolicy = DEFAULT_STABILIZATION_POLICY
): { state: StabilizationState; decision: StabilizationDecision } {
  const { kind, text, now } = observation;

  if (!isActionableOpenCodeKind(kind)) {
    return { state: initialStabilizationState(), decision: "not-actionable" };
  }

  const normalized = normalizeOpenCodeOutput(text);
  const sameKind = state.kind === kind;
  const next: StabilizationState = sameKind
    ? {
        kind,
        normalized,
        sampleCount: state.normalized === normalized ? state.sampleCount + 1 : 1,
        firstSeenAt: state.firstSeenAt,
      }
    : { kind, normalized, sampleCount: 1, firstSeenAt: now };

  const settled = next.sampleCount >= policy.requiredSamples;
  const waitedOut = now - next.firstSeenAt >= policy.maxWaitMs;

  return { state: next, decision: settled || waitedOut ? "act" : "wait" };
}

export function formatTerminalTail(
  text: string,
  { maxLines = 20, maxChars = 2_000 }: { maxLines?: number; maxChars?: number } = {}
): string {
  const lines = normalizeOpenCodeOutput(text).split("\n").slice(-maxLines);
  const tail = lines.join("\n");
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

function withTail(header: string, text: string): string {
  const tail = formatTerminalTail(text);
  return tail ? `${header}\n\nTerminal tail:\n${tail}` : header;
}

export function formatOpenCodeCrashError(signature: string, text: string): string {
  return withTail(
    [
      "OpenCode CLI crashed before reaching ready state.",
      `Fatal signature: ${signature}`,
      "",
      "This is the upstream OpenCode stdin/keymap parser dying on a keystroke it",
      "could not decode — not a Daintree ready-state regression. The online gate",
      "fails hard on purpose. If an upstream release fixes it, bump the pin in",
      "scripts/ci/install-opencode.mjs.",
    ].join("\n"),
    text
  );
}

export function formatOpenCodeTimeoutError(kind: OpenCodeOutputKind, text: string): string {
  return withTail(
    `OpenCode did not reach ready state before timeout (last classification: ${kind})`,
    text
  );
}
