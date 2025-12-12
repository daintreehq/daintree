/**
 * URL Styling for terminal output using OSC 8 hyperlinks.
 *
 * Links in xterm.js terminals need explicit hyperlink sequences to be both
 * visually styled and clickable. OSC 8 is the standard terminal hyperlink
 * escape sequence, supported natively by xterm.js without requiring WebLinksAddon.
 *
 * OSC 8 Format: \x1b]8;;URI\x07DISPLAY_TEXT\x1b]8;;\x07
 */

// OSC 8 escape sequence components
const ESC = "\x1b";
const BEL = "\x07"; // String Terminator
const OSC_START = `${ESC}]8;;`; // Start hyperlink: ESC ] 8 ; params ; URI
const OSC_END = `${ESC}]8;;${BEL}`; // End hyperlink: ESC ] 8 ; ; ST

// ANSI styling for the link text (blue + underline)
const ANSI = {
  BLUE_FG: `${ESC}[38;2;56;189;248m`, // #38bdf8 (sky-400)
  UNDERLINE_ON: `${ESC}[4m`,
  RESET: `${ESC}[0m`,
} as const;

// Compiled URL regex for performance
// Conservative pattern to minimize false positives
// Excludes trailing punctuation and angle brackets at word boundaries
// eslint-disable-next-line no-useless-escape
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

// Pattern to detect existing ANSI/OSC escape sequences
// eslint-disable-next-line no-control-regex, no-useless-escape
const ESCAPE_REGEX = /\x1b[\[\]]/;

/**
 * Wrap a URL with OSC 8 hyperlink sequence and ANSI styling.
 *
 * Creates a native terminal hyperlink that is:
 * - Clickable without WebLinksAddon
 * - Styled with blue color and underline
 */
function wrapUrl(url: string): string {
  // OSC 8 hyperlink with ANSI styling for the display text
  // Format: OSC_START + URI + BEL + STYLED_TEXT + OSC_END
  const styledText = `${ANSI.BLUE_FG}${ANSI.UNDERLINE_ON}${url}${ANSI.RESET}`;
  return `${OSC_START}${url}${BEL}${styledText}${OSC_END}`;
}

/**
 * Style URLs in terminal output with OSC 8 hyperlinks.
 *
 * Strategy:
 * - Fast path: skip regex entirely if no URL protocol present
 * - Skip text that already contains escape sequences (let apps style themselves)
 * - Replace URLs with OSC 8 hyperlinks sequences
 * - Preserve all other text unchanged
 *
 * @param text - Raw terminal output
 * @returns Text with URLs as OSC 8 hyperlinks
 */
export function styleUrls(text: string): string {
  // Fast path: skip if no URL protocol present (reduces false positives)
  if (!text.includes("://")) {
    return text;
  }

  // Skip if text already contains escape sequences
  // This preserves styling from applications like `ls --color`
  if (ESCAPE_REGEX.test(text)) {
    return text;
  }

  // Replace URLs with OSC 8 hyperlinks, trimming trailing punctuation
  return text.replace(URL_REGEX, (match) => {
    // Trim common trailing punctuation that shouldn't be part of the link
    let url = match;
    while (url.length > 0 && /[.,;:!?)>]$/.test(url)) {
      url = url.slice(0, -1);
    }
    // Return the hyperlink for the trimmed URL plus any trailing punctuation
    const trailing = match.slice(url.length);
    return wrapUrl(url) + trailing;
  });
}

/**
 * Check if text contains any URLs.
 * Useful for optimization (skip processing if no URLs present).
 */
export function containsUrl(text: string): boolean {
  URL_REGEX.lastIndex = 0;
  return URL_REGEX.test(text);
}
