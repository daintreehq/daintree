import { useEffect, useRef } from "react";
import { useRecipeStore } from "@/store/recipeStore";

const FOCUS_REFRESH_DEDUPE_MS = 500;

/**
 * Refreshes in-repo recipes when the window regains focus or becomes visible
 * (#9186). Without this, `.daintree/recipes/*.json` only loads at project
 * switch — so a `git pull` or branch switch in another terminal leaves the
 * app's in-memory state stale and the next save hits the staleness gate. A
 * window-focus reload bypasses the conflict for the common path where the
 * user wants the on-disk version anyway.
 *
 * Pattern mirrors `ProjectPulseCard.tsx` focus refresh: pair the bare `focus`
 * event with `visibilitychange` (the more reliable signal when the OS sends
 * a focus event for a window that's not actually visible) and dedupe with a
 * short ref-tracked window so alt-tab spam doesn't fan out into multiple
 * loads. Fire-and-forget by design — `loadRecipesRequestId` inside the store
 * already protects against concurrent loads (#4852).
 */
export function useRecipeFocusReload(): void {
  const lastFiredRef = useRef(0);

  useEffect(() => {
    const trigger = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const now = Date.now();
      if (now - lastFiredRef.current < FOCUS_REFRESH_DEDUPE_MS) return;
      lastFiredRef.current = now;
      const projectId = useRecipeStore.getState().currentProjectId;
      if (!projectId) return;
      void useRecipeStore.getState().loadRecipes(projectId);
    };

    const handleFocus = () => trigger();
    const handleVisibility = () => {
      if (!document.hidden) trigger();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}
