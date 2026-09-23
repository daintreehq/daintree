import { useEffect, useState } from "react";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

/**
 * True for the first 400ms (Doherty) after a badge's number arrives with no
 * title, so the card shows its glyph alone rather than flashing a raw `#NNN`
 * that the in-flight title fetch replaces a moment later (#8079). After the
 * window the number is the honest fallback and shows.
 *
 * The window closes on a timer and nothing else. The previous version compared
 * the number against a ref written in an effect, which held only until the badge
 * next re-rendered — and it always does inside 400ms (the credential and
 * provider reads settle), so the number flashed in exactly the case the gap was
 * written for. Keying the reveal to the number means a later number change opens
 * a fresh window, while a re-render of the same number can't close one early.
 */
export function useColdNumberGap(num: number, title: string | undefined, enabled = true): boolean {
  const [revealedFor, setRevealedFor] = useState<number | null>(null);
  const waiting = enabled && !title && revealedFor !== num;

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setRevealedFor(num), UI_DOHERTY_THRESHOLD);
    return () => clearTimeout(timer);
  }, [waiting, num]);

  return waiting;
}
