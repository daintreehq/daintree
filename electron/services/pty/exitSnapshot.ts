import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";

/**
 * Hard cap on a persisted exit snapshot, in UTF-8 bytes (#10850). This is a
 * short preview tail — NOT the multi-megabyte session-restore buffer gated by
 * `SESSION_SNAPSHOT_MAX_BYTES` in `terminalSessionPersistence.ts`. 32 KB holds
 * a few hundred lines of agent output, enough to recall what a closed session
 * was doing without turning the resume journal into a transcript store.
 */
export const EXIT_SNAPSHOT_MAX_BYTES = 32 * 1024;

/**
 * Number of visible characters to pull from the terminal tail before scrubbing
 * and byte-capping. Matches `TerminalInstanceService.captureBufferText`'s
 * default so the pty-host capture behaves like the known-good renderer scan.
 */
export const EXIT_SNAPSHOT_CAPTURE_CHARS = 20000;

/**
 * Prepare a captured terminal tail for persistence: scrub obvious secret-shaped
 * strings, THEN truncate to the byte cap.
 *
 * Order is load-bearing (documented in `secretScrubber.ts`): truncating first
 * could slice mid-token and strand the leading bytes of a secret that straddled
 * the cut, whereas scrubbing the full text first replaces any recognized secret
 * with `[REDACTED]` before the cap is applied — a later truncation can never
 * reintroduce one. Truncation keeps the TAIL (most recent output), and clips on
 * a UTF-8 code-point boundary so a multi-byte character is never split.
 */
export function prepareExitSnapshot(raw: string): string {
  if (!raw) return "";
  const scrubbed = scrubSecrets(raw);
  return truncateTailToBytes(scrubbed, EXIT_SNAPSHOT_MAX_BYTES);
}

/**
 * Keep the trailing portion of `text` that fits within `maxBytes` UTF-8 bytes,
 * without splitting a multi-byte code point. Returns `text` unchanged when it
 * already fits.
 */
function truncateTailToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // Walk backward over code points (not UTF-16 units) accumulating byte cost
  // until the next one would exceed the budget, then keep everything from there.
  const codePoints = Array.from(text);
  let bytes = 0;
  let startIndex = codePoints.length;
  for (let i = codePoints.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(codePoints[i], "utf8");
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    startIndex = i;
  }
  return codePoints.slice(startIndex).join("");
}
