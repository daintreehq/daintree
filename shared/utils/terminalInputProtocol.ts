import { getEffectiveAgentConfig } from "../config/agentRegistry.js";

// Bracketed paste escape sequences
export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

// Threshold for when to use bracketed paste
export const PASTE_THRESHOLD_CHARS = 200;

/**
 * Get the soft-newline sequence for a given agent type.
 * Reads from agent registry capabilities. For normal terminals (undefined or "terminal"),
 * returns plain LF. For unknown agent IDs, defaults to ESC+CR (most agent CLIs use this).
 */
export function getSoftNewlineSequence(agentType?: string): string {
  if (!agentType || agentType === "terminal") return "\n";
  const config = getEffectiveAgentConfig(agentType);
  if (config) {
    return config.capabilities?.softNewlineSequence ?? "\x1b\r";
  }
  return "\x1b\r";
}

/**
 * Check if text contains a complete bracketed paste sequence.
 */
export function containsFullBracketedPaste(data: string): boolean {
  if (!data.startsWith(BRACKETED_PASTE_START)) {
    return false;
  }
  return data.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length) !== -1;
}

/**
 * Determine if text should use bracketed paste formatting.
 */
export function shouldUseBracketedPaste(
  text: string,
  thresholdChars = PASTE_THRESHOLD_CHARS
): boolean {
  return text.includes("\n") || text.length > thresholdChars;
}

/**
 * Replace every C0 control and DEL with its Control Pictures glyph, so text on
 * its way into a terminal can only ever be read as text.
 *
 * The bytes matter because the destination is a parser, not a text field. ESC
 * introduces a sequence: `\x1b[201~` — legal in a POSIX filename, and also
 * reachable from a DOM id the Site Builder quotes into a prompt — closes a
 * bracketed paste early and hands the remainder over as typed input. The rest
 * of the block is worse: `\x03` interrupts, `\x04` closes stdin, `\x15` clears
 * the line. A length limit does not touch any of this, and neither does
 * wrapping, because the wrapper is made of the same bytes.
 *
 * Pictures rather than deletion (`\x03` becomes `␃`) so the receiving agent
 * still sees that something was there. U+2400 + code covers C0 exactly, which
 * is why ESC lands on U+241B — the glyph this function has always used.
 *
 * `\t` always survives: it is whitespace that indented content legitimately
 * carries, and its worst reading is a completion popup. `\n` survives because
 * it is the caller's own line structure, which every submission path re-encodes
 * into the destination's newline protocol afterwards.
 *
 * `\r` is the one character whose meaning depends on where it lands, which is
 * what `insideBracketedPaste` is for. Bare, it submits the line. Between paste
 * delimiters it is the line separator itself — xterm converts `\n` to `\r`
 * precisely to produce it — and the program reads it as data.
 *
 * NOT for the raw keyboard path. A keystroke is supposed to be a control
 * character; `TerminalInputController.write` exists to carry it verbatim.
 */
export function neutralizeControlCharacters(
  text: string,
  options: { insideBracketedPaste?: boolean } = {}
): string {
  const keepCr = options.insideBracketedPaste === true;
  // Scanned before it is rewritten: ordinary text allocates nothing.
  let first = -1;
  for (let index = 0; index < text.length; index++) {
    if (isNeutralized(text.charCodeAt(index), keepCr)) {
      first = index;
      break;
    }
  }
  if (first === -1) return text;
  let out = text.slice(0, first);
  for (let index = first; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!isNeutralized(code, keepCr)) {
      out += text[index];
    } else if (code === DEL) {
      out += DEL_PICTURE;
    } else {
      out += String.fromCharCode(CONTROL_PICTURE_BASE + code);
    }
  }
  return out;
}

const CONTROL_PICTURE_BASE = 0x2400;
const CR = 0x0d;
const LF = 0x0a;
const TAB = 0x09;
const DEL = 0x7f;
const DEL_PICTURE = "␡";

function isNeutralized(code: number, keepCr: boolean): boolean {
  if (code === LF || code === TAB) return false;
  if (code === CR && keepCr) return false;
  return code < 0x20 || code === DEL;
}

/**
 * Format text with bracketed paste if needed.
 *
 * The body is neutralised before wrapping, so nothing inside it can terminate
 * the wrapper early and hand the remainder to the program as ordinary input —
 * which can include a submit. This mirrors xterm's own `bracketTextForPaste`.
 * The delimiters are added after, because they are the one pair of escape
 * sequences here that we mean.
 */
export function formatWithBracketedPaste(text: string): string {
  const body = neutralizeControlCharacters(text, { insideBracketedPaste: true });
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`;
}
