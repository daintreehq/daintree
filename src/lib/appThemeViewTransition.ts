import { UI_ENTER_DURATION } from "./animationUtils";

// The 400ms wipe IS the theme-reveal signal — it encodes the origin/direction of the switch via clip-path animation (semantic exception).
export const THEME_WIPE_DURATION = 400;

type ViewTransitionDocument = Document & {
  activeViewTransition?: { skipTransition: () => void };
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

type TransitionCapableDocument = ViewTransitionDocument & {
  startViewTransition: NonNullable<ViewTransitionDocument["startViewTransition"]>;
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.body.dataset.reduceAnimations === "true" ||
    document.body.dataset.performanceMode === "true"
  );
}

function canRunThemeTransition(
  doc: ViewTransitionDocument | null
): doc is TransitionCapableDocument {
  return (
    doc !== null &&
    !prefersReducedMotion() &&
    typeof doc.startViewTransition === "function" &&
    doc.visibilityState === "visible"
  );
}

function themeTransitionDocument(): ViewTransitionDocument | null {
  return typeof document !== "undefined" ? (document as ViewTransitionDocument) : null;
}

function startThemeTransition(doc: TransitionCapableDocument, mutate: () => void) {
  doc.activeViewTransition?.skipTransition();
  return doc.startViewTransition(mutate);
}

export function runThemeReveal(origin: { x: number; y: number } | null, mutate: () => void): void {
  const doc = themeTransitionDocument();

  if (!canRunThemeTransition(doc)) {
    mutate();
    return;
  }

  const wipeFromLeft = (origin?.x ?? 0) < window.innerWidth / 2;

  const transition = startThemeTransition(doc, mutate);

  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: wipeFromLeft
            ? ["inset(0 0 0 0)", "inset(0 0 0 100%)"]
            : ["inset(0 0 0 0)", "inset(0 100% 0 0)"],
        },
        {
          duration: THEME_WIPE_DURATION,
          easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          pseudoElement: "::view-transition-old(root)",
          fill: "forwards",
        }
      );
    })
    .catch(() => {
      /* transition aborted (e.g. rapid reclick) — mutation already applied */
    });
}

/**
 * Crossfade a programmatic theme change (OS appearance switch, first-run auto-select)
 * instead of hard-cutting every token in one frame. Deliberately NOT the directional
 * wipe — that encodes a user gesture's origin, which these paths don't have.
 *
 * The root pseudo-elements carry `animation: none` (src/index.css) so the wipe can drive
 * its own clip-path, which also kills the UA's default crossfade — hence the manual WAAPI
 * fade here. Fading the old snapshot alone is enough: it sits at z-index 2 over an opaque
 * new snapshot, so its opacity IS the crossfade.
 */
export function runThemeCrossfade(mutate: () => void): void {
  const doc = themeTransitionDocument();

  if (!canRunThemeTransition(doc)) {
    mutate();
    return;
  }

  const transition = startThemeTransition(doc, mutate);

  transition.ready
    .then(() => {
      document.documentElement.animate(
        { opacity: [1, 0] },
        {
          duration: UI_ENTER_DURATION,
          easing: "ease-out",
          pseudoElement: "::view-transition-old(root)",
          fill: "forwards",
        }
      );
    })
    .catch(() => {
      /* transition aborted (e.g. a newer theme change superseded it) — mutation already applied */
    });
}
