import * as React from "react";

/**
 * Keeps a menu, submenu or popover open while a pointer press it owns is held.
 *
 * Radix portals its content out of the DOM, but React bubbles the content's
 * events through the component tree, so a press on an item also runs the
 * `onPointerDown`/`onMouseDown` of every React ancestor of the trigger. One that
 * pulls focus (a list container keeping its arrow keys, an editor reclaiming the
 * caret) moves focus out of the layer mid-press, and Radix closes a submenu or
 * any non-modal layer on that focus move — before the click that would have
 * selected the item.
 *
 * The policy: while the layer's own press is held — one that landed in its DOM,
 * or in a layer nested under it in the React tree, like its submenu — a
 * focus-outside does not dismiss it. A press on a sibling or parent is not the
 * layer's, so moving to a sibling submenu still closes this one. When the press
 * ends without closing the layer (a cancelled gesture, an item that keeps its
 * menu open), focus still stranded outside every layer is handed back.
 */

const FLOATING_LAYER_SELECTOR = "[data-radix-popper-content-wrapper]";

type FocusOutsideEvent = CustomEvent<{ originalEvent: FocusEvent }>;

interface HeldPress {
  seq: number;
  pointerId: number;
  target: Element | null;
}

let heldPress: HeldPress | null = null;
let pressSeq = 0;
const afterRelease = new Set<() => void>();
let tracking = false;

function releasePress(): void {
  heldPress = null;
  if (afterRelease.size === 0) return;
  const pending = [...afterRelease];
  afterRelease.clear();
  // Past the click the release precedes: an item that closes its menu has
  // started closing it by then, and there is nothing to hand focus back to.
  setTimeout(() => pending.forEach((run) => run()), 0);
}

function startTracking(): void {
  // A stubbed window (some test harnesses) has no event API, and nothing can
  // be pressed in it; left untracked so a real window can still install later.
  if (tracking || typeof window.addEventListener !== "function") return;
  tracking = true;
  // Window capture runs ahead of every React handler, including an ancestor's
  // capture-phase focus grab.
  window.addEventListener(
    "pointerdown",
    (event) => {
      pressSeq += 1;
      heldPress = {
        seq: pressSeq,
        pointerId: event.pointerId,
        target: event.target instanceof Element ? event.target : null,
      };
    },
    true
  );
  const end = (event: PointerEvent) => {
    if (heldPress?.pointerId === event.pointerId) releasePress();
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  // A release outside the window never arrives here.
  window.addEventListener("blur", releasePress);
}

export interface LayerPressFocusGuard<T extends HTMLElement> {
  ref: React.RefCallback<T>;
  onPointerDownCapture: () => void;
  onFocusOutside: (event: FocusOutsideEvent) => void;
}

/** Wire all three onto one Radix content; `forwardedRef` still receives the node. */
export function useLayerPressFocusGuard<T extends HTMLElement>(
  forwardedRef: React.Ref<T> | undefined
): LayerPressFocusGuard<T> {
  const nodeRef = React.useRef<T | null>(null);
  const ownedPressRef = React.useRef(0);
  // Held in a ref so the callback ref below stays stable across renders.
  const forwardedRefHolder = React.useRef(forwardedRef);
  React.useEffect(() => {
    forwardedRefHolder.current = forwardedRef;
  }, [forwardedRef]);
  React.useEffect(startTracking, []);

  const ref = React.useCallback((node: T | null) => {
    nodeRef.current = node;
    const forwarded = forwardedRefHolder.current;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) (forwarded as React.MutableRefObject<T | null>).current = node;
  }, []);

  // React bubbles a nested layer's press through this one's capture too, which
  // is what makes a submenu's press its parent's as well.
  const onPointerDownCapture = React.useCallback(() => {
    if (heldPress) ownedPressRef.current = heldPress.seq;
  }, []);

  const onFocusOutside = React.useCallback((event: FocusOutsideEvent) => {
    const node = nodeRef.current;
    const press = heldPress;
    if (!node || !press) return;
    // The DOM check covers an ancestor's capture-phase focus grab, which runs
    // before this layer's own capture handler has claimed the press.
    const owned =
      ownedPressRef.current === press.seq || (press.target !== null && node.contains(press.target));
    if (!owned) return;
    event.preventDefault();

    const lostFocus = event.detail.originalEvent.relatedTarget;
    afterRelease.add(() => {
      if (!node.isConnected || node.getAttribute("data-state") === "closed") return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest(FLOATING_LAYER_SELECTOR)) return;
      const restore =
        lostFocus instanceof HTMLElement && lostFocus.isConnected && node.contains(lostFocus)
          ? lostFocus
          : node;
      restore.focus({ preventScroll: true, focusVisible: false });
    });
  }, []);

  return { ref, onPointerDownCapture, onFocusOutside };
}
