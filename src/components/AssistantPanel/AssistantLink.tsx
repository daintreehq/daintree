import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Navigable text in rendered assistant prose — the panel's ONE hyperlink primitive.
 *
 * ## Why both forms live in one file
 *
 * A markdown link and a forge reference are different ELEMENTS — an `<a href>` and a
 * `<button>` — for a mechanical reason: a reference carries no URL. It names an issue
 * number, and only the project's resolved forge provider knows what address that is, so
 * it is resolved at click time rather than written into an href this renderer would
 * have to guess.
 *
 * They are not different SIGNALS, though, and they must not look like they are. Both
 * make the same promise and both keep it the same way: `forge.openPR` and
 * `forge.openIssue` end in `openExternalUrl`, so a reference opens the system browser
 * exactly as a link does. An earlier version of this file drew references with a dotted
 * underline to mean "stays in the app" — which was simply untrue, and a false promise
 * about where a click goes is worse than no distinction at all. If an in-app forge
 * surface ever exists, THAT is when a second affordance earns itself.
 *
 * Written as two branches of one component so the accent is declared EXACTLY ONCE. That
 * is what the panel's accent-restraint contract is asking for: not "one DOM node in the
 * transcript may be accented" — a paragraph with three links has always painted three —
 * but "one thing in this region may claim the accent's meaning". Here that thing is:
 * navigable.
 *
 * ## Separating a link from a code span
 *
 * The underline, not the hue. The panel's accent is the terminal's cursor colour and
 * its code colour is the terminal's cyan slot, and on some shipped schemes those are
 * close or identical — on Hokkaido they resolve to the same hex, and on Fiordland and
 * Solarized Dark they sit 15° and 18° apart in OKLCH hue. On those themes a link and a
 * code span are not separable by colour at all. The underline here and the chip-and-rule
 * on `.assistant-prose code` are what actually tell them apart.
 */

/** The one accent declaration in the assistant panel's prose. */
const LINK_INK =
  "text-[var(--assistant-accent)] underline underline-offset-2 decoration-[var(--assistant-accent)]/40 hover:decoration-[var(--assistant-accent)]";

export interface AssistantLinkProps {
  children: ReactNode;
  /** An address to open directly. Mutually exclusive with `onActivate`. */
  href?: string;
  /**
   * Resolves and opens a reference that has no address of its own. Still leaves the
   * app — see the note above.
   */
  onActivate?: () => void;
}

export function AssistantLink({ children, href, onActivate }: AssistantLinkProps) {
  if (onActivate) {
    return (
      <button
        type="button"
        onClick={onActivate}
        className={cn(
          LINK_INK,
          "cursor-pointer",
          // The panel's own focus ink, which answers to the 3:1 graphical floor rather
          // than the text one — a ring pushed to a text floor stops being the theme's
          // colour and becomes near-black or near-white.
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]"
        )}
      >
        {children}
      </button>
    );
  }
  return (
    // `noreferrer` matters because the target is MODEL-AUTHORED: the page being opened
    // should not learn where it was opened from.
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_INK}>
      {children}
    </a>
  );
}
