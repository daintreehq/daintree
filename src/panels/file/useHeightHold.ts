import { useCallback, useEffect, useMemo, useRef } from "react";
import { PANEL_MINIMIZE_DURATION } from "@/lib/animationUtils";

/** Slack over the CSS duration before we stop waiting for `transitionend`. */
const TRANSITION_GRACE_MS = 50;

/** Carries the release transition; see `.file-pane-body-releasing` in panels.css. */
export const RELEASING_CLASS = "file-pane-body-releasing";

export interface HeightHoldController {
  /** Attach to the element whose height should be held across a subtree swap. */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** Pin the element's measured height. Call before the swap that would shrink it. */
  hold: () => void;
  /** The held content committed; release once it has laid out and painted. */
  handleRendered: () => void;
  /** Drop the pin immediately, without the settle transition. */
  cancel: () => void;
}

/**
 * Pins an element's height across a subtree swap that would otherwise let it
 * collapse and re-expand.
 *
 * `min-height` is a floor, not a cap: content taller than the pin grows the box
 * on its own and the release is a no-op, while content shorter than the pin
 * stays held until the release settles it down in one move. That is why this
 * needs no ResizeObserver — there is no sequence in which a held box shrinks
 * and then grows again.
 *
 * There is deliberately no timeout. A pin that never receives its release
 * signal holds the box at the height it already had, which is the desired end
 * state anyway; a deadline would instead drop the pin mid-load and produce
 * exactly the collapse-then-expand this exists to prevent. The caller cancels
 * on the real exits — reverting the swap, changing content, unmounting.
 */
export function useHeightHold(): HeightHoldController {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({
    active: false,
    /** Bumped by every hold/cancel so a queued release can detect it went stale. */
    epoch: 0,
    frames: [] as number[],
    settleTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    /** The pinned node itself — captured, so a reassigned ref can't strand it. */
    heldNode: null as HTMLElement | null,
    /** The node the settle listener sits on, so it comes off that same node. */
    listenerNode: null as HTMLElement | null,
    onTransitionEnd: undefined as ((event: TransitionEvent) => void) | undefined,
  });

  const clearPending = useCallback(() => {
    const state = stateRef.current;
    for (const frame of state.frames) cancelAnimationFrame(frame);
    state.frames = [];
    if (state.settleTimer !== undefined) {
      clearTimeout(state.settleTimer);
      state.settleTimer = undefined;
    }
    if (state.onTransitionEnd && state.listenerNode) {
      state.listenerNode.removeEventListener("transitionend", state.onTransitionEnd);
    }
    state.onTransitionEnd = undefined;
    state.listenerNode = null;
  }, []);

  const cancel = useCallback(() => {
    const state = stateRef.current;
    const node = state.heldNode;
    clearPending();
    state.active = false;
    state.epoch += 1;
    state.heldNode = null;
    if (!node) return;
    // Covers a pin still settling as well as one still held: `release` clears
    // `active` before the transition starts, so keying this on `active` would
    // leave a mid-settle node carrying its floor into replacement content.
    // No settle transition of its own — the caller is switching to content that
    // supplies its own height immediately, so an animated climb-down lags it.
    node.classList.remove(RELEASING_CLASS);
    node.style.minHeight = "";
  }, [clearPending]);

  const release = useCallback(() => {
    const state = stateRef.current;
    if (!state.active) return;
    const node = state.heldNode;
    clearPending();
    state.active = false;
    state.epoch += 1;
    if (!node) {
      state.heldNode = null;
      return;
    }

    node.classList.add(RELEASING_CLASS);
    node.style.minHeight = "";

    const finish = () => {
      clearPending();
      node.classList.remove(RELEASING_CLASS);
      if (stateRef.current.heldNode === node) stateRef.current.heldNode = null;
    };
    // Reduced motion drops the transition entirely, and a pin that already
    // matched the rendered height animates nothing, so `transitionend` is not
    // guaranteed — the timer, not the event, is what bounds this.
    const onTransitionEnd = (event: TransitionEvent) => {
      // `transitionend` bubbles, so a descendant animating its own min-height
      // would otherwise cut the settle short.
      if (event.target !== node || event.propertyName !== "min-height") return;
      finish();
    };
    state.onTransitionEnd = onTransitionEnd;
    state.listenerNode = node;
    node.addEventListener("transitionend", onTransitionEnd);
    state.settleTimer = setTimeout(finish, PANEL_MINIMIZE_DURATION + TRANSITION_GRACE_MS);
  }, [clearPending]);

  const hold = useCallback(() => {
    const node = bodyRef.current;
    // Supersede any in-flight pin or settle up front, so a measurement we end
    // up rejecting can't leave the previous operation half-armed.
    cancel();
    if (!node) return;
    const { height } = node.getBoundingClientRect();
    // A pane that isn't laid out (hidden host, jsdom default) has nothing worth
    // pinning, and a 0px floor is indistinguishable from no pin at all.
    if (height <= 0) return;

    const state = stateRef.current;
    state.active = true;
    state.epoch += 1;
    state.heldNode = node;
    // Ceil: a fractional height rounded down lets the box shrink by a sub-pixel
    // sliver, which is the flicker this exists to prevent. Applied without the
    // release class — the pin has to land in the swap's own frame, or it
    // animates the collapse instead of preventing it.
    node.classList.remove(RELEASING_CLASS);
    node.style.minHeight = `${Math.ceil(height)}px`;
  }, [cancel]);

  const handleRendered = useCallback(() => {
    const state = stateRef.current;
    if (!state.active) return;
    // StrictMode double-invokes the reporting effect, and a document may report
    // more than once; one queued release per pin is enough.
    if (state.frames.length > 0) return;
    const epoch = state.epoch;
    // Two frames: the first lets the rendered commit lay out, the second lets it
    // paint. Releasing in the commit's own frame hands the dialog a pre-layout
    // content height, which reintroduces the jump.
    state.frames.push(
      requestAnimationFrame(() => {
        state.frames.push(
          requestAnimationFrame(() => {
            // `cancelAnimationFrame` can't retract a callback already dequeued
            // into the running batch, so re-check the generation here.
            if (stateRef.current.epoch !== epoch) return;
            release();
          })
        );
      })
    );
  }, [release]);

  useEffect(() => clearPending, [clearPending]);

  return useMemo(() => ({ bodyRef, hold, handleRendered, cancel }), [hold, handleRendered, cancel]);
}
