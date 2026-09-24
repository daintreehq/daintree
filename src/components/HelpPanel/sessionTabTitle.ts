/**
 * Longest name a session tab will carry, in characters.
 *
 * Tabs are content-width, so this is what keeps one chatty agent from taking the
 * whole strip: at three lanes and the panel's 320px minimum, every tab has to stay
 * readable. CSS still truncates below this — the cap only bounds how much the strip
 * can grow, so a title change resizes it within a known range rather than without one.
 */
export const SESSION_TAB_TITLE_MAX_CHARS = 28;

const ELLIPSIS = "…";
const TRAILING_SEPARATORS = /[\s,.:;|/\\·\-–—]+$/u;

/**
 * An observed task title, reduced to something a tab can hold.
 *
 * OSC titles arrive as terminal-controlled text: runs of spaces, tabs and newlines
 * survive the task-title cleanup, and a tab has no second line to put them on. The
 * cap cuts at a word boundary when one is close enough to the limit to keep most of
 * the text, and by code point otherwise, so a surrogate pair is never split in half.
 *
 * `label` is what the tab shows; `fullTitle` is the same text uncapped, for its
 * tooltip. `null` when nothing readable is left.
 */
export function trimSessionTabTitle(
  raw: string | null | undefined,
  maxChars: number = SESSION_TAB_TITLE_MAX_CHARS
): { label: string; fullTitle: string } | null {
  if (!raw) return null;
  const fullTitle = raw.replace(/\s+/gu, " ").trim();
  if (!fullTitle) return null;
  const chars = Array.from(fullTitle);
  if (chars.length <= maxChars) return { label: fullTitle, fullTitle };

  // Measured in code points throughout, the same unit as the cap — mixing in UTF-16
  // indices would let a title full of emoji fall back far further than intended.
  const head = chars.slice(0, maxChars - 1);
  const wordBreak = head.lastIndexOf(" ");
  const cut = wordBreak >= Math.floor(head.length * 0.6) ? head.slice(0, wordBreak) : head;
  // A cut that lands after "auth:" or "tests," reads as a broken sentence with the
  // ellipsis bolted on; the dangling separator goes with the text it introduced.
  // Separators only: a closing bracket or quote is part of the text before it.
  const tidy = cut.join("").replace(TRAILING_SEPARATORS, "") || head.join("").trimEnd();
  return { label: `${tidy}${ELLIPSIS}`, fullTitle };
}
