import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";

/**
 * Where focus goes when a control in the dock's status tray stops existing (an
 * emptied trash) or stops being shown (a status pill whose count reached zero).
 * ContentDock owns the answer because it owns the rail and the launcher; the
 * pills only ask.
 */
export interface DockFocusLandmark {
  /** The nearest visible control that takes focus, or null when the dock has none. */
  resolve: () => HTMLElement | null;
  /** Focus {@link resolve}'s answer, trying each fallback until one accepts. */
  handoff: () => void;
}

const NO_LANDMARK: DockFocusLandmark = { resolve: () => null, handoff: () => {} };

export const DockFocusLandmarkContext = createContext<DockFocusLandmark>(NO_LANDMARK);

export function useDockFocusLandmark(): DockFocusLandmark {
  return useContext(DockFocusLandmarkContext);
}

// A status pill that has gone quiet stays mounted and is hidden by CSS alone,
// so its buttons are still in the DOM — and `.focus()` on a `display: none`
// button is a silent no-op that strands focus on <body>.
const HIDDEN_ANCESTOR = '[data-visible="false"], [hidden], [inert], [aria-hidden="true"]';

/** Whether `.focus()` on `el` can land: connected, enabled, and not under a hidden pill. */
export function isFocusTargetVisible(el: HTMLElement): boolean {
  if (!el.isConnected || el.matches(":disabled") || el.closest(HIDDEN_ANCESTOR)) return false;
  // jsdom has no layout and no `checkVisibility`, so the structural checks above
  // are what a test sees; a real browser also gets `display`/`visibility`.
  return typeof el.checkVisibility === "function"
    ? el.checkVisibility({ visibilityProperty: true })
    : true;
}

/** Every visible match under `root`, in document order. */
export function visibleFocusables(root: ParentNode | null, selector: string): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(isFocusTargetVisible);
}

/**
 * Focus the first candidate that accepts it. The tooltip suppression is armed
 * first because the target is a tooltip trigger and the move is not the
 * pointer's: without it the destination announces itself with a tooltip.
 */
export function focusFirstAccepting(candidates: (HTMLElement | null | undefined)[]): void {
  armTooltipFocusSuppression();
  for (const candidate of candidates) {
    if (!candidate || !isFocusTargetVisible(candidate)) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) return;
  }
}

/**
 * Drop `ref` once focus has genuinely left the element it names.
 *
 * A focus ref that is only ever set goes stale the moment the user clicks away,
 * and a later removal then looks like it displaced focus that was never there.
 * A blur that names where focus went settles it at once. One that does not is
 * ambiguous — a click on nothing, a window switch, or the element itself being
 * removed or moved by the commit in progress — so it is judged after the
 * current task, by which time a moved element has been refocused and a removed
 * one has been acted on (layout effects run in the commit, before the
 * microtask).
 */
export function releaseFocusOwner(event: React.FocusEvent, ref: { current: Element | null }): void {
  const target = event.target;
  if (event.relatedTarget) {
    if (ref.current === target) ref.current = null;
    return;
  }
  queueMicrotask(() => {
    if (ref.current !== target) return;
    if (target.isConnected && document.activeElement === target) return;
    ref.current = null;
  });
}

/**
 * The element inside a control that holds focus right now, kept across the
 * control's own unmount so a removal can be told apart from the user leaving.
 * Events from portalled content (popovers, dialogs) bubble the React tree, so
 * attaching these to the control's root covers its overlays too.
 */
export function useFocusOwner() {
  const ownerRef = useRef<Element | null>(null);
  // Read-and-clear, so the ref never leaves the hook.
  const takeOwner = useCallback((): Element | null => {
    const owner = ownerRef.current;
    ownerRef.current = null;
    return owner;
  }, []);
  const handlers = {
    onFocusCapture: (event: React.FocusEvent) => {
      ownerRef.current = event.target;
    },
    onBlurCapture: (event: React.FocusEvent) => releaseFocusOwner(event, ownerRef),
  };
  return { takeOwner, handlers };
}

/**
 * Hand focus to the dock when the pill that holds it hides. Spread `handlers`
 * on the pill's root.
 *
 * A layout effect, not a passive one: the removal's own blur is handled in a
 * microtask, which a passive effect can lose the race to.
 */
export function useDockPillHideHandoff(count: number) {
  const { handoff } = useDockFocusLandmark();
  const { takeOwner, handlers } = useFocusOwner();
  useLayoutEffect(() => {
    if (count > 0) return;
    const owner = takeOwner();
    if (!owner) return;
    // Focus that already moved somewhere real was moved on purpose.
    const active = document.activeElement;
    if (active && active !== document.body && active !== owner) return;
    handoff();
  }, [count, handoff, takeOwner]);
  return handlers;
}
