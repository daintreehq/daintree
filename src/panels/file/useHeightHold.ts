import { useCallback, useEffect, useMemo, useRef } from "react";
import { PANEL_MINIMIZE_DURATION } from "@/lib/animationUtils";

/**
 * Longest a hold survives without a release signal. The rendered document
 * reports its first commit well inside this; the cap exists so a chunk that
 * never resolves can't pin the dialog at the source height for the rest of the
 * session.
 */
const HOLD_CAP_MS = 4000;

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
  /** Drop the hold immediately, without the settle transition. */
  cancel: () => void;
}

/**
 * Pins an element's height across a subtree swap that would otherwise let it
 * collapse and re-expand.
 *
 * `min-height` is a floor, not a cap: content taller than the hold grows the
 * box on its own and the release is a no-op, while content shorter than the
 * hold stays pinned until the release settles it down in one move. That is why
 * this needs no ResizeObserver — there is no sequence in which a held box
 * shrinks and then grows again.
 */
export function useHeightHold(): HeightHoldController {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({
    active: false,
    /** Bumped by every hold/cancel so a queued release can detect it went stale. */
    epoch: 0,
    frames: [] as number[],
    capTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    settleTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    onTransitionEnd: undefined as ((event: TransitionEvent) => void) | undefined,
  });

  const clearPending = useCallback(() => {
    const state = stateRef.current;
    for (const frame of state.frames) cancelAnimationFrame(frame);
    state.frames = [];
    if (state.capTimer !== undefined) {
      clearTimeout(state.capTimer);
      state.capTimer = undefined;
    }
    if (state.settleTimer !== undefined) {
      clearTimeout(state.settleTimer);
      state.settleTimer = undefined;
    }
    if (state.onTransitionEnd) {
      bodyRef.current?.removeEventListener("transitionend", state.onTransitionEnd);
      state.onTransitionEnd = undefined;
    }
  }, []);

  const release = useCallback(() => {
    const state = stateRef.current;
    if (!state.active) return;
    clearPending();
    state.active = false;
    state.epoch += 1;

    const node = bodyRef.current;
    if (!node) return;

    node.classList.add(RELEASING_CLASS);
    node.style.minHeight = "";

    const finish = () => {
      clearPending();
      node.classList.remove(RELEASING_CLASS);
    };
    // Reduced motion drops the transition entirely and a hold that matched the
    // rendered height never animates, so `transitionend` is not guaranteed —
    // the timer, not the event, is what bounds this.
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== node || event.propertyName !== "min-height") return;
      finish();
    };
    state.onTransitionEnd = onTransitionEnd;
    node.addEventListener("transitionend", onTransitionEnd);
    state.settleTimer = setTimeout(finish, PANEL_MINIMIZE_DURATION + TRANSITION_GRACE_MS);
  }, [clearPending]);

  const hold = useCallback(() => {
    const node = bodyRef.current;
    if (!node) return;
    const { height } = node.getBoundingClientRect();
    // A panel that isn't laid out (hidden host, jsdom default) has nothing
    // worth pinning, and a 0px floor would be indistinguishable from no hold.
    if (height <= 0) return;

    clearPending();
    const state = stateRef.current;
    state.active = true;
    state.epoch += 1;
    // Ceil: a fractional height rounded down lets the box shrink by a sub-pixel
    // sliver, which is the flicker this exists to prevent. The hold is applied
    // without the transition class — it has to take effect in the same frame as
    // the swap, otherwise it animates the collapse instead of preventing it.
    node.classList.remove(RELEASING_CLASS);
    node.style.minHeight = `${Math.ceil(height)}px`;
    state.capTimer = setTimeout(release, HOLD_CAP_MS);
  }, [clearPending, release]);

  const handleRendered = useCallback(() => {
    const state = stateRef.current;
    if (!state.active) return;
    const epoch = state.epoch;
    // Two frames: the first lets the rendered commit lay out, the second lets it
    // paint. Releasing in the commit's own frame hands the dialog a pre-layout
    // content height, which reintroduces the jump.
    state.frames.push(
      requestAnimationFrame(() => {
        state.frames.push(
          requestAnimationFrame(() => {
            if (stateRef.current.epoch !== epoch) return;
            release();
          })
        );
      })
    );
  }, [release]);

  const cancel = useCallback(() => {
    const state = stateRef.current;
    if (!state.active) return;
    clearPending();
    state.active = false;
    state.epoch += 1;
    const node = bodyRef.current;
    if (!node) return;
    // No settle transition: the caller is reverting to a view that supplies its
    // own height immediately, so animating down would lag behind the content.
    node.classList.remove(RELEASING_CLASS);
    node.style.minHeight = "";
  }, [clearPending]);

  useEffect(() => clearPending, [clearPending]);

  return useMemo(
    () => ({ bodyRef, hold, handleRendered, cancel }),
    [hold, handleRendered, cancel]
  );
}
