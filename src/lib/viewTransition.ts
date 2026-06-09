// Run a DOM mutation inside a View Transition so structural changes
// (maximize/restore, palette/dialog swaps, dock↔grid moves) animate instead of
// hard-cutting. Falls back to a plain synchronous mutation when reduced-motion,
// reduce-animations, or performance mode is active, when the API is missing, or
// when the document is hidden — matching `runThemeReveal`'s guards.
//
// Pass `scope` to confine the transition to a subtree via the element-scoped
// API (`element.startViewTransition`, Chromium 147+) so unrelated panels (and
// their xterm canvases) aren't snapshotted; omit it for a document-level
// transition. To morph a specific element between its before/after positions,
// assign a matching `view-transition-name` to it in both states (the caller
// owns naming); with no names the captured root simply crossfades.
import { prefersReducedMotion } from "./appThemeViewTransition";

type ViewTransition = { ready: Promise<void>; finished: Promise<void> };
type StartViewTransition = (callback: () => void) => ViewTransition;

type ViewTransitionDocument = Document & {
  activeViewTransition?: { skipTransition: () => void };
  startViewTransition?: StartViewTransition;
};

type ViewTransitionElement = Element & {
  startViewTransition?: StartViewTransition;
};

export function supportsViewTransitions(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as ViewTransitionDocument).startViewTransition === "function"
  );
}

export function withViewTransition(
  mutate: () => void,
  scope?: Element | null
): ViewTransition | null {
  // `mutate` runs as the transition's update callback — asynchronously in the
  // transition path, synchronously in the fallback path — and update callbacks
  // run in call order, so keep `mutate` idempotent / order-independent. Don't
  // depend on it having completed synchronously after this returns.
  const doc = typeof document !== "undefined" ? (document as ViewTransitionDocument) : null;
  const start: StartViewTransition | undefined = scope
    ? (scope as ViewTransitionElement).startViewTransition?.bind(scope)
    : doc?.startViewTransition?.bind(doc);

  if (
    !doc ||
    prefersReducedMotion() ||
    typeof start !== "function" ||
    doc.visibilityState !== "visible"
  ) {
    mutate();
    return null;
  }

  // End any in-flight document transition's animation (e.g. a rapid re-click)
  // so we don't stack overlapping snapshots. This only skips the animation; the
  // prior update callback still runs, preserving mutation order.
  doc.activeViewTransition?.skipTransition();
  const transition = start(mutate);
  transition.finished.catch(() => {
    /* transition aborted (e.g. superseded) — mutation already applied */
  });
  return transition;
}
