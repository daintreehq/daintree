import {
  HANDBACK_CODE_ALPHABET,
  HANDBACK_CODE_LENGTH,
  HANDBACK_CODE_PATTERN,
  HANDBACK_CODE_TOKEN,
  HANDBACK_INSTRUCTION_TEMPLATE,
} from "../types/handback.js";

/** Largest byte value that maps onto the alphabet without modulo bias. */
const UNBIASED_BYTE_LIMIT = 256 - (256 % HANDBACK_CODE_ALPHABET.length);

/**
 * A fresh handback code. New for every submission that asks for one, so a
 * marker replayed from an earlier turn — Codex re-emits its whole transcript
 * on a height change — can never match the code this one is waiting for.
 */
export function mintHandbackCode(): string {
  let code = "";
  const bytes = new Uint8Array(HANDBACK_CODE_LENGTH * 2);
  while (code.length < HANDBACK_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      code += HANDBACK_CODE_ALPHABET[byte % HANDBACK_CODE_ALPHABET.length];
      if (code.length === HANDBACK_CODE_LENGTH) break;
    }
  }
  return code;
}

export function isHandbackCode(value: unknown): value is string {
  return typeof value === "string" && HANDBACK_CODE_PATTERN.test(value);
}

/** The instruction sentence for `code`. */
export function buildHandbackInstruction(code: string): string {
  return HANDBACK_INSTRUCTION_TEMPLATE.replaceAll(HANDBACK_CODE_TOKEN, code);
}

/**
 * `text` with the instruction appended after a blank line, as the last thing
 * in the submission. Trailing line breaks are dropped first so the instruction
 * sits exactly one blank line below the caller's last line of text.
 */
export function appendHandbackInstruction(text: string, code: string): string {
  return `${text.replace(/[\r\n]+$/, "")}\n\n${buildHandbackInstruction(code)}`;
}

/** Opening marker for `code`. */
export function handbackStartMarker(code: string): string {
  return `DAINTREE-DONE-${code}`;
}

/** Closing marker for `code`. */
export function handbackEndMarker(code: string): string {
  return `END-${code}`;
}
