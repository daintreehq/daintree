// Streaming parser for OSC 9;4 taskbar-progress sequences. Taps the raw PTY
// stream upstream of `stripIdleTerminalSequences` so agent state (#8701) can
// react to a viewport-independent signal — the existing simpleOutputState path
// only sees N visible terminal lines, which starves detection in small grid
// tiles. This parser is read-only; the OSC_NOISE stripper in
// `IdleSequenceFilter` still removes the sequence from the ActivityMonitor
// byte-volume / activity-gate path so those detectors stay clean (the
// renderer receives the raw bytes and renders the progress bar). The
// strip-on-success invariant is the same one `OscResponder` follows for OSC 10/11.
//
// OSC 9;4 format: `\x1b]9;4;<state>;<progress>\x07` or terminated by ST
// (`\x1b\\`). State codes (from the de-facto Windows ConEmu spec that Claude
// Code adopted in v2.0.56):
//   0 — remove/hide (between tool calls; advisory only — `onOscProgressIdle`
//       is a deliberate no-op in `ActivityMonitor`)
//   1 — normal/determinate (working, percent follows)
//   2 — error
//   3 — indeterminate (working, no percent)
//   4 — paused
//
// Only states 1, 3 (working) and 0 (idle) drive callbacks; 2 and 4 are
// ignored — there is no matching agent state in the state machine and
// silently passing them up would widen the surface area beyond the bug fix.
//
// Sequences can split across PTY chunk boundaries (node-pty reads at OS
// boundaries), so the parser is stateful — `carry` retains the partial
// fragment between chunks. The 600-byte cap is a safety valve against a
// malformed stream that never delivers a terminator; real OSC 9;4 sequences
// are ~15-25 chars.

const ESC = "\x1b";
const BEL = "\x07";
const ST_FIRST = "\x1b";
const ST_SECOND = "\\";

// Real OSC 9;4 sequences are short; this is a defensive cap against malformed
// or hostile PTY peers that emit an unbounded fragment without a terminator.
const MAX_CARRY_BYTES = 600;

export type Osc94State = 0 | 1 | 2 | 3 | 4;

export type Osc94Callbacks = {
  onWorking: (now: number) => void;
  onIdle: (now: number) => void;
};

export class Osc94Parser {
  private carry = "";

  constructor(private readonly callbacks: Osc94Callbacks) {}

  feed(chunk: string, now: number): void {
    if (!chunk) return;

    // Fast guard — keep allocation-free when the chunk contains no OSC 9;4
    // candidate and the carry is empty. `\x1b]9` is the minimal prefix for
    // both OSC 9;4 and the unrelated single-digit OSC 9 (notifications);
    // discriminating happens below after we have a complete payload. A chunk
    // ending in ESC OR in `ESC]` must still flow through so a sequence split
    // across the chunk boundary (chunk1: "...\x1b", chunk2: "]9;4;1;50\x07")
    // OR (chunk1: "...\x1b]", chunk2: "9;4;1;50\x07") doesn't lose its
    // introducer.
    if (
      this.carry.length === 0 &&
      !chunk.includes("\x1b]9") &&
      !chunk.endsWith(ESC) &&
      !chunk.endsWith("\x1b]")
    ) {
      return;
    }

    this.carry += chunk;

    while (true) {
      const oscIdx = this.carry.indexOf("\x1b]");
      if (oscIdx === -1) {
        // No OSC start anywhere — drop everything except a trailing ESC, which
        // could still be the first byte of an OSC introducer split across the
        // chunk boundary.
        this.carry = this.carry.endsWith(ESC) ? ESC : "";
        return;
      }

      // Locate the nearest terminator (BEL or ST) after the OSC start.
      const belIdx = this.carry.indexOf(BEL, oscIdx);
      const stIdx = this.findStTerminator(oscIdx);

      let termIdx = -1;
      let termLen = 0;
      if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
        termIdx = belIdx;
        termLen = 1;
      } else if (stIdx !== -1) {
        termIdx = stIdx;
        termLen = 2;
      }

      if (termIdx === -1) {
        // Terminator hasn't arrived yet. Retain from `\x1b]` onward so the
        // next chunk can complete the sequence. Cap the carry as a safety net
        // against malformed streams that never close.
        this.carry = this.carry.substring(oscIdx);
        if (this.carry.length > MAX_CARRY_BYTES) {
          this.carry = "";
        }
        return;
      }

      const payload = this.carry.substring(oscIdx + 2, termIdx);

      if (this.handlePayload(payload, now)) {
        // Recognized OSC 9;4 — consume past the terminator and continue.
        this.carry = this.carry.substring(termIdx + termLen);
        continue;
      }

      // Payload was an unrelated OSC (e.g. an unterminated OSC 9 notification
      // that grew until a later OSC 9;4's BEL was treated as its terminator).
      // The unrelated payload may contain a *nested* `\x1b]` that belongs to
      // a real OSC sequence; if so, re-seed carry from that nested introducer
      // so the next loop iteration can match it. Without this, a valid
      // OSC 9;4 buried inside a malformed peer's payload would be silently
      // lost.
      const nestedOscIdx = payload.indexOf("\x1b]");
      if (nestedOscIdx === -1) {
        this.carry = this.carry.substring(termIdx + termLen);
      } else {
        // Reseed from the absolute position of the nested introducer (which
        // is `oscIdx + 2 + nestedOscIdx` in the original carry) — preserves
        // both the inner payload and the terminator that we just hijacked.
        this.carry = this.carry.substring(oscIdx + 2 + nestedOscIdx);
      }
    }
  }

  reset(): void {
    this.carry = "";
  }

  // Find the ST terminator (`\x1b\\`) at-or-after `from`, but **not** at `from`
  // itself — that ESC is the OSC introducer, not a terminator.
  private findStTerminator(from: number): number {
    let searchFrom = from + 1;
    while (searchFrom < this.carry.length) {
      const idx = this.carry.indexOf(ST_FIRST, searchFrom);
      if (idx === -1) return -1;
      if (idx + 1 >= this.carry.length) {
        // Trailing ESC — wait for next chunk to know if it's `\\` or another
        // OSC introducer.
        return -1;
      }
      if (this.carry[idx + 1] === ST_SECOND) return idx;
      searchFrom = idx + 1;
    }
    return -1;
  }

  // Returns `true` when the payload was recognized as an OSC 9;4 sequence
  // (whether it fired a callback or was an ignored state code 2/4), `false`
  // for unrelated OSC payloads. The caller uses the return value to decide
  // whether to scan the consumed payload for a nested `\x1b]` introducer.
  private handlePayload(payload: string, now: number): boolean {
    if (!payload.startsWith("9;4;")) return false;

    const parts = payload.split(";");
    if (parts.length < 3) return true;

    const rawState = parts[2];
    // Only single-digit states 0-4 are defined in the spec; reject anything
    // else (including empty, multi-char, non-numeric) so we don't fire on
    // malformed input. Still return `true` — this was an OSC 9;4 payload,
    // just with a malformed state; we consume it cleanly.
    if (rawState.length !== 1) return true;
    const state = rawState.charCodeAt(0) - 48;
    if (state < 0 || state > 4) return true;

    if (state === 1 || state === 3) {
      this.callbacks.onWorking(now);
    } else if (state === 0) {
      this.callbacks.onIdle(now);
    }
    // State 2 (error) and 4 (paused) are ignored — no matching agent state.
    return true;
  }
}
