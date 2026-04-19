const SKELETON_ID = "startup-skeleton";
const FADE_DURATION_MS = 250;

let firstInteractiveNotified = false;

function notifyFirstInteractive(): void {
  if (firstInteractiveNotified) return;
  firstInteractiveNotified = true;
  try {
    window.electron?.app?.notifyFirstInteractive?.().catch(() => {
      // Main process may already have drained the queue or fallback fired — safe to ignore
    });
  } catch {
    // Preload bridge may be unavailable in exotic test contexts — safe to ignore
  }
}

/**
 * Fade out and remove the startup skeleton overlay, and signal the main
 * process that the renderer is interactive so it can drain its deferred
 * service queue. Uses requestAnimationFrame to ensure React has painted
 * real content before both the fade and the signal fire.
 */
export function removeStartupSkeleton(): void {
  const el = document.getElementById(SKELETON_ID);
  if (!el) {
    notifyFirstInteractive();
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      notifyFirstInteractive();

      el.setAttribute("aria-busy", "false");
      el.classList.add("fade-out");

      setTimeout(() => {
        el.remove();
      }, FADE_DURATION_MS);
    });
  });
}
