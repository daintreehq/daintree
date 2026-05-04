// Strip deterministic "idle-only" terminal control sequences from a PTY chunk
// before byte-volume activity gates see it. Targets sequences that agents emit
// every frame regardless of work progress — DECSET toggles, OSC metadata, CPR
// responses, DSR queries, and bracketed-paste markers — so OutputVolumeDetector
// and HighOutputDetector don't escalate idle→busy on pure protocol noise once
// minBytes is lowered. Spinner frames (\r + status-line text) are NOT stripped
// here; cosmetic-redraw classification handles those separately and they remain
// valid liveness evidence for the debounce path.
//
// All quantifiers are bounded so the patterns are safe against ReDoS even with
// a malicious PTY peer. The OSC negation class [^\x07\x1b]{0,512} avoids the
// catastrophic backtracking risk of .{0,N} when the terminator is missing.
//
// The filter is intentionally stateless — escape sequences split across PTY
// chunk boundaries (rare in practice, since node-pty reads at OS boundaries
// and most idle-noise sequences are short) are not stripped. OutputVolumeDetector's
// maxBytesPerFrame cap is the secondary defense for those cases.
//
// `?2026h` / `?2026l` (DEC mode 2026 — Synchronized Output) is stripped here
// for the renderer-bound and byte-volume paths, but the headless terminal in
// TerminalProcess writes the raw PTY data straight through, which lets
// SynchronizedFrameDetector hook xterm's parser for frame-close events
// (#6668). Removing 2026 from this list would re-introduce the false-positive
// idle→busy escalations on cosmetic redraws that the structural tier exists
// to prevent.

// eslint-disable-next-line no-control-regex
const DECSET_NOISE = /\x1b\[\?(?:25|1004|2004|2026|1049)[hl]/gu;
// eslint-disable-next-line no-control-regex
const OSC_NOISE = /\x1b\](?:[0-9]|133|633)[;:][^\x07\x1b]{0,512}(?:\x07|\x1b\\)/gu;
// eslint-disable-next-line no-control-regex
const CPR_NOISE = /\x1b\[\d{1,4};\d{1,4}R/gu;
// eslint-disable-next-line no-control-regex
const DSR_NOISE = /\x1b\[6n/gu;
// eslint-disable-next-line no-control-regex
const BPASTE_NOISE = /\x1b\[20[01]~/gu;

export function stripIdleTerminalSequences(data: string): string {
  return data
    .replace(OSC_NOISE, "")
    .replace(DECSET_NOISE, "")
    .replace(CPR_NOISE, "")
    .replace(DSR_NOISE, "")
    .replace(BPASTE_NOISE, "");
}
