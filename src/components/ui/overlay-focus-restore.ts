import * as React from "react";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";

/**
 * Close-time focus policy shared by every anchored overlay primitive
 * (`DropdownMenu`, `Popover`, `ContextMenu`).
 *
 * Radix hands focus back when one of these closes, which is right for the
 * keyboard and wrong for the pointer in two visible ways: the trigger's
 * tooltip re-opens with the pointer nowhere near it, and Chromium paints
 * `:focus-visible` on the programmatic `.focus()`, so a mouse user gets an
 * accent focus ring they never asked for.
 *
 * The three closes are genuinely different and each needs its own answer:
 *
 * - **Clicked away.** For a dropdown or a popover the clicked target owns
 *   focus, so there is nothing to restore and no ring to leave behind: cancel
 *   the restoration outright — unless nothing actually took focus, which is
 *   the common case for a MODAL overlay, whose dismissing press never reaches
 *   what was under it. Focus then sits on `document.body` and the next Tab
 *   restarts from the top of the document, so the trigger takes it back,
 *   ringless. A context menu skips the check entirely
 *   (`restoreFocusOnPointerClose`): its restore target is the surface the user
 *   was working in, not a control they just dismissed, so losing that surface's
 *   keyboard handling for even a task is worth avoiding.
 * - **Clicked an item.** Focus still has to come back, or Radix's already
 *   unmounted item drops it on `document.body` and a keyboard user is
 *   stranded. Take the restoration over and ask for focus WITHOUT the visible
 *   state.
 * - **Keyboard.** Leave it alone. Radix restores, and the ring is correct.
 *
 * Telling the pointer cases apart is the fiddly half. Radix implements
 * Enter/Space selection by calling `.click()` on the item, and a synthetic
 * click carries `detail === 0` where a real one carries 1 or more — so
 * "landed on an item" plus "detail > 0" separates them. Radix also has a
 * pointer-up fallback (press elsewhere, release over the item) whose synthetic
 * click carries `detail === 0` like a keyboard one, which the "a pointer went
 * down inside this content" flag catches, because the keyboard cannot do that.
 * Clicks on padding, a label or a separator match neither and leave the flags
 * alone — those do not close the menu, and claiming them would strand a flag
 * onto whatever gesture does.
 *
 * State lives on the ROOT rather than the content so it can be cleared on
 * every opening: our content wrappers stay mounted across open/close, so a
 * close that skips `onCloseAutoFocus` entirely would otherwise leak its flags
 * into the next opening.
 *
 * Canonical consumers: `dropdown-menu.tsx`, `popover.tsx`, `context-menu.tsx`.
 * Nothing outside those three should need to reimplement this.
 */
export interface OverlayFocusRestore {
  /**
   * Records where focus goes after a pointer selection: the trigger for a
   * dropdown or a popover, whatever was focused before the menu opened for a
   * context menu, which has no focusable trigger of its own.
   *
   * A setter rather than the ref itself. Handing the ref out and letting each
   * consumer assign `.current` is a mutation of a value returned from a hook,
   * which bails the React Compiler out of every component that does it.
   */
  setRestoreTarget: (node: HTMLElement | null) => void;
  /** Called by the root on every open transition. */
  resetForOpen: () => void;
  /**
   * Hand this close back to Radix's own policy, from a consumer that owns its
   * restoration and wants the default rather than the shared one. Clears the
   * gesture flags, so the shared handler sees no pointer close to act on. The
   * tooltip suppression still fires — that half is never a policy choice.
   */
  deferToRadix: () => void;
  onContentPointerDown: () => void;
  onContentPointerDownOutside: () => void;
  onContentInteractOutside: (event: { defaultPrevented: boolean }) => void;
  onContentKeyDown: () => void;
  onContentClick: (event: React.MouseEvent) => void;
  onContentCloseAutoFocus: (event: Event) => void;
}

/**
 * What counts as "the thing the user picked", across all three overlays.
 *
 * The menu roles cover dropdowns and context menus, `option` covers the
 * anchored palettes and any listbox. The plain interactive elements matter for
 * popovers, which routinely close from an ordinary button in their own body
 * (`PresetColorPicker`'s Clear and Done, say) rather than from anything
 * role-flagged — without them those closes fall through to Radix's bare
 * `.focus()` and keep exactly the ring this exists to remove.
 */
const ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  "button",
  '[role="button"]',
  "a[href]",
].join(",");

export const OverlayFocusRestoreContext = React.createContext<OverlayFocusRestore | null>(null);

export function useOverlayFocusRestore(): OverlayFocusRestore | null {
  return React.useContext(OverlayFocusRestoreContext);
}

// Module scope on purpose: assigning through a forwarded ref inside a
// component reads to the React Compiler as mutating a hook argument.
function assignForwardedRef<T>(forwardedRef: React.ForwardedRef<T>, value: T | null): void {
  if (typeof forwardedRef === "function") {
    forwardedRef(value);
  } else if (forwardedRef) {
    forwardedRef.current = value;
  }
}

/**
 * Callback ref for a trigger: records the node as the overlay's restore target
 * and still honours whatever ref the caller forwarded.
 */
export function useOverlayTriggerRef<T extends HTMLElement>(
  forwardedRef: React.ForwardedRef<T>
): React.RefCallback<T> {
  const overlay = useOverlayFocusRestore();
  return React.useCallback(
    (node: T | null) => {
      overlay?.setRestoreTarget(node);
      assignForwardedRef(forwardedRef, node);
    },
    [overlay, forwardedRef]
  );
}

export interface OverlayFocusRestoreOptions {
  /**
   * Restore focus (ringless) after a click-away instead of dropping it. True
   * only for context menus — see the "Clicked away" note above.
   */
  restoreFocusOnPointerClose?: boolean;
}

export function useOverlayFocusRestoreValue(
  options: OverlayFocusRestoreOptions = {}
): OverlayFocusRestore {
  const { restoreFocusOnPointerClose = false } = options;
  const restoreTargetRef = React.useRef<HTMLElement | null>(null);
  // Set from `onPointerDownOutside`, read at close: dismissing by clicking AWAY
  // should leave no focus ring, and the clicked target takes focus itself.
  // Deliberately not set for clicks on items — Radix has already unmounted the
  // item by then, so cancelling restoration there does not mean "focus without
  // a ring", it means focus falls to `document.body`.
  const wasPointerCloseRef = React.useRef(false);
  // Set when a POINTER activated an item, as opposed to the keyboard.
  const wasPointerSelectRef = React.useRef(false);
  // Whether a pointer has been pressed inside the content during this opening.
  const pointerInsideRef = React.useRef(false);

  return React.useMemo<OverlayFocusRestore>(() => {
    const resetForOpen = () => {
      wasPointerCloseRef.current = false;
      wasPointerSelectRef.current = false;
      pointerInsideRef.current = false;
    };

    return {
      setRestoreTarget: (node) => {
        restoreTargetRef.current = node;
      },
      resetForOpen,
      deferToRadix: resetForOpen,
      onContentPointerDown: () => {
        pointerInsideRef.current = true;
      },
      onContentPointerDownOutside: () => {
        wasPointerCloseRef.current = true;
      },
      onContentInteractOutside: (event) => {
        // Radix fires this after `onPointerDownOutside` and dismisses only if
        // nobody vetoed. A vetoed interaction leaves the overlay OPEN with no
        // close coming — `handleDockInteractOutside` vetoes routinely — so the
        // flag has to be disarmed, or the next close is misread as the pointer
        // dismissal that never happened and loses its focus return.
        if (event.defaultPrevented) wasPointerCloseRef.current = false;
      },
      onContentKeyDown: () => {
        // Keyboard activity supersedes every pointer gesture so far in this
        // opening. Without it a click that did NOT close the overlay — a
        // persistent item holding an inline form, a toggle in a popover body,
        // a press on padding — leaves its flags armed, and the Escape or Enter
        // that finally does close gets treated as a pointer close: the ring a
        // keyboard user is owed goes missing, or focus is dropped outright.
        wasPointerCloseRef.current = false;
        wasPointerSelectRef.current = false;
        pointerInsideRef.current = false;
      },
      onContentClick: (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const onItem = target?.closest(ITEM_SELECTOR) != null;
        wasPointerSelectRef.current = onItem && (event.detail > 0 || pointerInsideRef.current);
      },
      onContentCloseAutoFocus: (event) => {
        // Always, whichever way it closed and whoever owns the restoration:
        // focus is about to land somewhere and would drag a tooltip open with
        // it. Armed here rather than when the close begins — Radix defers
        // restoration past the exit animation, so a window armed at close-time
        // is racing a stall it needn't race.
        armTooltipFocusSuppression();

        const pointerClose = wasPointerCloseRef.current;
        const pointerSelect = wasPointerSelectRef.current;
        resetForOpen();

        // A consumer that already decided (an anchored palette suppressing its
        // own restoration, say) owns the outcome.
        if (event.defaultPrevented) return;
        if (!pointerClose && !pointerSelect) return;

        // Both pointer closes take the restoration over from Radix: its own is
        // a bare `.focus()`, and Chromium paints `:focus-visible` on a
        // programmatic focus, so a mouse user who never asked for a focus ring
        // gets the accent one anyway. Ask for the focus WITHOUT the visible
        // state — or, on a click-away that owns no restore target, for no
        // focus at all.
        event.preventDefault();
        const target = restoreTargetRef.current;
        if (!pointerClose || restoreFocusOnPointerClose) {
          target?.focus({ preventScroll: true, focusVisible: false });
          return;
        }

        // Clicked away, and the clicked target is supposed to own focus now —
        // but for a MODAL overlay it often does not. Radix disables outside
        // pointer events while one is open, so the press that dismissed it
        // never reached what was under it and focus lands on `document.body`,
        // which restarts the next Tab from the top of the document. Checked a
        // task later, once the layer has torn down and whatever did take focus
        // has taken it; a target that took focus, or a trigger that unmounted
        // with the thing it belonged to, leaves this alone.
        setTimeout(() => {
          if (document.activeElement !== null && document.activeElement !== document.body) return;
          if (!target?.isConnected) return;
          // Re-armed, not merely inherited: the arm at the top of this handler
          // disarms on its own zero-delay timer, which was queued BEFORE this
          // one and therefore fires first. Without this the deferred focus
          // lands unguarded and reopens the very tooltip the close suppressed.
          armTooltipFocusSuppression();
          target.focus({ preventScroll: true, focusVisible: false });
        }, 0);
      },
    };
  }, [restoreFocusOnPointerClose]);
}
