export const THEME_REVEAL_DURATION = 350;

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.body.dataset.performanceMode === "true"
  );
}

/**
 * Wraps a synchronous DOM mutation (theme swap) in a View Transitions API
 * circular clip-path reveal expanding from `origin`. When reduced motion is
 * requested, the API is unavailable, or the document is not visible, the
 * mutation runs immediately without animation.
 *
 * `mutate` MUST be synchronous — no awaits. Any async work (e.g. IPC persist)
 * must be performed by the caller outside this function.
 */
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

  const width = window.innerWidth;
  const height = window.innerHeight;
  const x = origin?.x ?? width / 2;
  const y = origin?.y ?? height / 2;
  const endRadius = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));

  const transition = doc.startViewTransition(mutate);

  transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
        },
        {
          duration: THEME_REVEAL_DURATION,
          easing: "ease-in-out",
          pseudoElement: "::view-transition-new(root)",
        }
      );
    })
    .catch(() => {
      /* transition aborted (e.g. rapid reclick) — mutation already applied */
    });
}
