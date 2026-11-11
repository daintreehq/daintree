/**
 * `agy models` output as the catalog service receives it from a piped child.
 * Built from agy 1.5.5's reported shape (spinner frames while the list is
 * fetched, then `<id>  <Display Name>` rows), with the braille cycle and
 * two-space gap agy draws in its TUI.
 */

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ERASE_LINE = "\r\x1b[2K";

function spinner(text: string, glyphs = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻"]): string {
  return glyphs.map((glyph) => `${ERASE_LINE}\x1b[36m${glyph}\x1b[0m  ${text}`).join("");
}

/** The rows every fixture below lists, in printed order. */
export const AGY_MODELS: readonly { id: string; name: string }[] = [
  { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
  { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
  { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

const ROWS = AGY_MODELS.map(({ id, name }) => [id, name] as const);

const WIDTH = Math.max(...ROWS.map(([id]) => id.length)) + 2;

function rows(eol: string): string {
  return ROWS.map(([id, name]) => `${id.padEnd(WIDTH)}${name}${eol}`).join("");
}

/** `rows` as `agy models` prints them: the spinner erased in place, then the list. */
export function agyModelsListing(listed: readonly { id: string; name: string }[]): string {
  const width = Math.max(...listed.map(({ id }) => id.length)) + 2;
  const body = listed.map(({ id, name }) => `${id.padEnd(width)}${name}\n`).join("");
  return `${HIDE_CURSOR}${spinner("Fetching models…")}${ERASE_LINE}${SHOW_CURSOR}${body}`;
}

/** Spinner erased in place, cursor restored, then the rows. */
export const AGY_MODELS_SPINNER_CLEARED = agyModelsListing(AGY_MODELS);

/** The first row written over the last spinner frame without its own line. */
export const AGY_MODELS_SPINNER_OVERWRITTEN = `${spinner("Fetching models…")}\r${rows("\n")}`;

/** A Windows console: CRLF line ends, and each frame left on its own line. */
export const AGY_MODELS_WINDOWS = `${["⣷", "⣯", "⣟"].map((g) => `${g}  Fetching models…\r\n`).join("")}${rows("\r\n")}`;

/** Ids bolded and names dimmed with SGR, as a colour terminal shows them. */
export const AGY_MODELS_STYLED = ROWS.map(
  ([id, name]) => `\x1b[1m${id}\x1b[0m${" ".repeat(WIDTH - id.length)}\x1b[2m${name}\x1b[0m\n`
).join("");

/** An offline machine: the spinner, then the fetch failure and no rows. */
export const AGY_MODELS_OFFLINE = `${HIDE_CURSOR}${spinner("Fetching models…")}${ERASE_LINE}${SHOW_CURSOR}Error: failed to fetch available models: dial tcp: lookup antigravity.googleapis.com: no such host\n`;
