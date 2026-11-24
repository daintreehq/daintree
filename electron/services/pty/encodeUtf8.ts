const encoder = new TextEncoder();

// Encoding into a reused buffer and copying out what was written runs well
// ahead of `encode()`, which sizes and allocates a fresh buffer every call.
// A chunk too large for the buffer to be worth keeping goes through `encode()`.
const SCRATCH_RETAIN_BYTES = 256 * 1024;
let scratch = new Uint8Array(16 * 1024);

/** `text` as UTF-8, in a standalone buffer: offset 0, sized exactly. */
export function encodeUtf8(text: string): Uint8Array {
  // A UTF-16 unit never takes more than 3 bytes; a pair takes 4 for two.
  const worstCase = text.length * 3;
  if (worstCase > SCRATCH_RETAIN_BYTES) return encoder.encode(text);
  if (scratch.length < worstCase) {
    scratch = new Uint8Array(
      Math.min(SCRATCH_RETAIN_BYTES, Math.max(worstCase, scratch.length * 2))
    );
  }
  const { written } = encoder.encodeInto(text, scratch);
  return scratch.slice(0, written);
}
