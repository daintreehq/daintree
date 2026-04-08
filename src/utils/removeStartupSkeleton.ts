const SKELETON_ID = "startup-skeleton";
const FADE_DURATION_MS = 250;

/**
 * Fade out and remove the startup skeleton overlay.
 * Uses requestAnimationFrame to ensure React has painted real content
 * before the fade begins, preventing a flash of empty background.
 */
export function removeStartupSkeleton(): void {
  const el = document.getElementById(SKELETON_ID);
  if (!el) return;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.setAttribute("aria-busy", "false");
      el.classList.add("fade-out");

      setTimeout(() => {
        el.remove();
      }, FADE_DURATION_MS);
    });
  });
}
