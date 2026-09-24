// First: the bridge must exist before any store module reads it.
import "./tourShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TOUR_CHAPTERS } from "../tourChapters";
import { TourDialog } from "../TourDialog";
import type { TourPlayer } from "../TourPlayer";
import "@/index.css";

/**
 * Visual-review harness for the Daintree Tour dialog.
 *
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?chapter=<id>             open on a chapter (default: the first)
 *   ?t=<seconds>              freeze the scene at a moment (no playback)
 *   ?muted=1                  start muted (captions show)
 *
 * `window.__tour` is the live player, for specs that step through cues.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const chapterIndex = Math.max(
  0,
  TOUR_CHAPTERS.findIndex((c) => c.id === params.get("chapter"))
);
const freezeAt = params.get("t");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function onPlayer(player: TourPlayer) {
  Reflect.set(window, "__tour", player);
  if (freezeAt !== null) {
    player.pause();
    player.seek(Number(freezeAt));
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <TourDialog
        isOpen
        onClose={() => {}}
        initialChapter={chapterIndex}
        initialMuted={params.get("muted") === "1"}
        onChapterReached={() => {}}
        onCompleted={() => {}}
        onMutedChange={() => {}}
        onPlayer={onPlayer}
      />
    </TooltipProvider>
  </StrictMode>
);
