// The 400ms wipe IS the theme-reveal signal — it encodes the origin/direction of the switch via clip-path animation (semantic exception).
export const THEME_WIPE_DURATION = 400;

type ViewTransitionDocument = Document & {
  activeViewTransition?: { skipTransition: () => void };
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.body.dataset.reduceAnimations === "true" ||
    document.body.dataset.performanceMode === "true"
  );
}

export function runThemeReveal(origin: { x: number; y: number } | null, mutate: () => void): void {
  const doc = typeof document !== "undefined" ? (document as ViewTransitionDocument) : null;

  if (
    !doc ||
    prefersReducedMotion() ||
    typeof doc.startViewTransition !== "function" ||
    doc.visibilityState !== "visible"
  ) {
    mutate();
    return;
  }

  const wipeFromLeft = (origin?.x ?? 0) < window.innerWidth / 2;

  doc.activeViewTransition?.skipTransition();
  const transition = doc.startViewTransition(mutate);

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
