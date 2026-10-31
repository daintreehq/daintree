import { useEffect, useRef, type ComponentProps } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { captureCopyFlash, showCopyFlash } from "@/lib/copyFlash";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { RevealCopy } from "./revealCopy";

/**
 * Starts a reveal's confirmation from inside the gesture that asked for it, and
 * returns what to call once the reveal succeeded — or null for a real reveal,
 * whose file manager window confirms itself. A remote window's reveal copies
 * the host path in main and changes nothing on screen, so it confirms the way a
 * menu's copy rows do (`copyWithToast`): a "Copied" flash where it was asked
 * for, plus one polite announcement. The flash's origin is read now, while the
 * row that was chosen still holds focus, since the menu closes on select. A
 * control still on screen to draw its own check passes `flash: false`.
 */
export function beginRevealConfirm(
  reveal: RevealCopy
): ((options?: { flash?: boolean }) => void) | null {
  const announcement = reveal.copiedAnnouncement;
  if (announcement === null) return null;
  const ticket = captureCopyFlash();
  return ({ flash = true } = {}) => {
    useAnnouncerStore.getState().announce(announcement, "polite");
    if (flash) showCopyFlash(ticket);
  };
}

/**
 * A reveal from a control that is gone once chosen: a menu row, which closes on
 * select, or a failure banner's Retry, which unmounts on success. `run`
 * resolves true once the action succeeded; a failure is the surface's own to
 * report (its banner or toast), as for a real reveal.
 */
export function runTransientReveal(reveal: RevealCopy, run: () => Promise<boolean>): void {
  const confirm = beginRevealConfirm(reveal);
  void run().then((ok) => {
    if (ok) confirm?.();
  });
}

class RevealFailed extends Error {}

/**
 * A reveal control that stays on screen. Where the reveal copies, the action is
 * the clipboard write (main makes it), so `useCopyWithFeedback` owns the check
 * and its dwell exactly as it does for the path field's copy. The check is
 * keyed to the path it copied, so a control re-aimed at another file never
 * arrives confirmed.
 */
export function useRevealControl(
  reveal: RevealCopy,
  path: string,
  run: () => Promise<boolean>
): { copied: boolean; onClick: () => void } {
  // Silent: the confirmation below is the one announcement, because the hook
  // says nothing once the control has unmounted, and two owners each checking
  // their own mount state could both speak.
  const { copiedText, copy } = useCopyWithFeedback({
    announcement: false,
    write: () =>
      run().then((ok) => {
        if (!ok) throw new RevealFailed();
      }),
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const onClick = () => {
    const confirm = beginRevealConfirm(reveal);
    if (confirm === null) {
      void run();
      return;
    }
    // A control that unmounted before main answered (a toolbar folding into
    // its menu) has no check to draw, so the copy flashes where it was asked
    // for instead, as a menu row's does.
    void copy(path).then((ok) => {
      if (ok) confirm({ flash: !mountedRef.current });
    });
  };
  return { copied: reveal.copiedAnnouncement !== null && copiedText === path, onClick };
}

/**
 * The reveal action in a file viewer's unavailable body: the cause's way out,
 * drawn with the reveal's own glyph, swapping to a check after a copy.
 */
export function RevealActionButton({
  reveal,
  path,
  onReveal,
  variant,
}: {
  reveal: RevealCopy;
  /** The file the reveal aims at; the copied check belongs to it. */
  path: string;
  /** Resolves true once the reveal succeeded. */
  onReveal: () => Promise<boolean>;
  variant: ComponentProps<typeof Button>["variant"];
}) {
  const { copied, onClick } = useRevealControl(reveal, path, onReveal);
  const Icon = copied ? Check : reveal.icon;
  return (
    <Button variant={variant} size="sm" onClick={onClick}>
      <Icon />
      {reveal.label}
    </Button>
  );
}
