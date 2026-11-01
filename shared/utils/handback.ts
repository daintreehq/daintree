import {
  HANDBACK_CODE_ALPHABET,
  HANDBACK_CODE_LENGTH,
  HANDBACK_CODE_PATTERN,
  HANDBACK_CODE_TOKEN,
  HANDBACK_INSTRUCTION_TEMPLATE,
  HANDBACK_RUN_INSTRUCTION_TEMPLATE,
  type HandbackInstruction,
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

/** The instruction sentence for `code`: the ordinary one, or a scheduled run's. */
export function buildHandbackInstruction(
  code: string,
  instruction: HandbackInstruction = "handback"
): string {
  const template =
    instruction === "run" ? HANDBACK_RUN_INSTRUCTION_TEMPLATE : HANDBACK_INSTRUCTION_TEMPLATE;
  return template.replaceAll(HANDBACK_CODE_TOKEN, code);
}

/**
 * `text` with the instruction appended after a blank line, as the last thing
 * in the submission. Trailing line breaks are dropped first so the instruction
 * sits exactly one blank line below the caller's last line of text.
 */
export function appendHandbackInstruction(
  text: string,
  code: string,
  instruction: HandbackInstruction = "handback"
): string {
  return `${text.replace(/[\r\n]+$/, "")}\n\n${buildHandbackInstruction(code, instruction)}`;
}

/**
 * `submitted` without the instruction {@link appendHandbackInstruction} added
 * for `code`, either kind, or unchanged when it doesn't end with one. Only the
 * trailing line breaks the append dropped are lost.
 */
export function withoutHandbackInstruction(submitted: string, code: string): string {
  for (const instruction of ["handback", "run"] as const) {
    const suffix = `\n\n${buildHandbackInstruction(code, instruction)}`;
    if (submitted.endsWith(suffix)) return submitted.slice(0, -suffix.length);
  }
  return submitted;
}

/** Opening marker for `code`: the agent reports it's done. */
export function handbackStartMarker(code: string): string {
  return `DAINTREE-DONE-${code}`;
}

/**
 * Opening marker for `code` when the agent reports it needs the user. Only a
 * scheduled run's instruction offers it (#15982).
 */
export function handbackNeedsYouMarker(code: string): string {
  return `DAINTREE-NEEDS-YOU-${code}`;
}

/** Closing marker for `code`. */
export function handbackEndMarker(code: string): string {
  return `END-${code}`;
}
