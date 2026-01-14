import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Extracts the base title from a terminal/agent title that may contain a command summary.
 * Command summaries are appended with separators like " – " (en dash), " — " (em dash), or " - ".
 *
 * Examples:
 *   "Claude Code Agent – fix authentication bug" → "Claude Code Agent"
 *   "Terminal — npm run dev" → "Terminal"
 *   "Claude" → "Claude" (no change)
 *
 * @param title The full title that may contain a command summary
 * @returns The base title without the command summary
 */

// Regex hoisted to module scope for performance (avoid per-call construction)
// Matches: en dash (–), em dash (—), or spaced hyphen ( - ) with content after
const TITLE_SEPARATOR_REGEX = /^(.+?)\s*[–—]\s+.+$|^(.+?)\s+-\s+.+$/;

export function getBaseTitle(title: string): string {
  // Match common separators: en dash (–), em dash (—), or spaced hyphen ( - )
  // Only match if there's content before and after the separator
  const separatorMatch = title.match(TITLE_SEPARATOR_REGEX);
  if (separatorMatch) {
    // Return the first capture group that matched
    return (separatorMatch[1] ?? separatorMatch[2] ?? title).trim();
  }
  return title;
}
