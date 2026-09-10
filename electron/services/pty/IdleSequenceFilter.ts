import { stripCosmeticParticles } from "./CosmeticParticleFilter.js";

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
// The filter is intentionally stateless. A sequence split across a PTY chunk
// boundary is not reassembled — but both halves are dropped from the count:
// a chunk cannot end in a printable glyph if it ends mid-escape, and the
// parameter-bytes-plus-final tail that opens the next chunk is likewise never
// text. That matters once a TUI repaints continuously: node-pty's ~1 KB reads
// split Codex's 1–2 KB composer-sparkle frames at every boundary, and the
// leaked `;30;30;30m` / `\x1b[38;2;` fragments alone came to ~175 B/s on a
// real capture — above the simple-output bucket's 100 B/s drain, so an idle
// agent never settled. Over-stripping is the safe direction here: at worst a
// chunk that genuinely starts with "5m ago" loses two bytes from a volume
// count that the rest of the stream will replenish. OutputVolumeDetector's
// maxBytesPerFrame cap remains the secondary defense.
//
// `?2026h` / `?2026l` (DEC mode 2026 — Synchronized Output) is stripped here
// for the byte-volume / activity-gate path, but the headless terminal in
// TerminalProcess writes the raw PTY data straight through, which lets
// SynchronizedFrameDetector hook xterm's parser for frame-close events
// (#6668). Removing 2026 from this list would re-introduce the false-positive
// idle→busy escalations on cosmetic redraws that the structural tier exists
// to prevent.

// Combined-mode private sequences (e.g. `\x1b[?25;2026h`) are stripped only when
// every code is in the known-noise allowlist; sequences carrying any unknown
// code (e.g. `\x1b[?25;9999h`) pass through untouched so meaningful TUI modes
// stay observable.
// eslint-disable-next-line no-control-regex
const DECSET_NOISE = /\x1b\[\?(?:25|1004|2004|2026|1049)(?:;(?:25|1004|2004|2026|1049))*[hl]/gu;
// `1337` must precede `133` in the alternation: JS regex picks the leftmost
// matching branch, not the longest, so reordering would leave a stray `7` in
// OSC 1337 sequences.
// eslint-disable-next-line no-control-regex
const OSC_NOISE = /\x1b\](?:1337|133|633|52|12|11|10|[0-9])[;:][^\x07\x1b]{0,512}(?:\x07|\x1b\\)/gu;
// eslint-disable-next-line no-control-regex
const CPR_NOISE = /\x1b\[\d{1,4};\d{1,4}R/gu;
// eslint-disable-next-line no-control-regex
const DSR_NOISE = /\x1b\[6n/gu;
// eslint-disable-next-line no-control-regex
const BPASTE_NOISE = /\x1b\[20[01]~/gu;
// Grok redraws delete the same Kitty image even when it is already absent.
// Keep image transmission/display commands observable; only delete commands
// without an image payload are protocol noise.
// eslint-disable-next-line no-control-regex
const KITTY_DELETE_NOISE = /\x1b_Ga=d(?:,[a-zA-Z]=[a-zA-Z0-9]{1,10}){0,16}\x1b\\/gu;
// The two halves of an escape sequence split by a chunk boundary. The tail is
// limited to the finals that continuous redraws actually split (SGR, CUP, EL,
// ED); 32 parameter bytes covers a full 24-bit fg+bg SGR with room to spare.
// A tail must look like one — open with the CSI bracket the ESC left behind,
// carry a `;` separator, or be the bare final byte — so a chunk that happens
// to start with prose like "5m ago" keeps its digits.
const SPLIT_SEQUENCE_TAIL = /^(?:\[[0-9;:?]{0,32}|[0-9:?]{0,16};[0-9;:?]{0,32})?[mHKJ]/u;
// eslint-disable-next-line no-control-regex
const SPLIT_SEQUENCE_HEAD = /\x1b(?:\[[0-9;:?]{0,32})?$/u;

export function stripIdleTerminalSequences(data: string): string {
  // Every pattern below requires a literal ESC; skip all passes when absent.
  if (!data.includes("\x1b")) {
    return data;
  }
  // Ambient particle animations (Codex's composer sparkles) are cosmetic in the
  // same sense as the protocol noise below: emitted every frame regardless of
  // work progress. See CosmeticParticleFilter for why spinners are unaffected.
  return stripCosmeticParticles(data)
    .replace(OSC_NOISE, "")
    .replace(DECSET_NOISE, "")
    .replace(CPR_NOISE, "")
    .replace(DSR_NOISE, "")
    .replace(BPASTE_NOISE, "")
    .replace(KITTY_DELETE_NOISE, "")
    .replace(SPLIT_SEQUENCE_TAIL, "")
    .replace(SPLIT_SEQUENCE_HEAD, "");
}
