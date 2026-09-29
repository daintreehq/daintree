// First: the bridge must exist before any store module reads it.
import "./tourShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TOUR_CHAPTERS } from "../tourChapters";
import { DAINTREE_TOUR } from "../daintreeTour";
import { TourDialog } from "../TourDialog";
import type { TourPlayer } from "@daintreehq/tour";
import { TOUR_KEYBOARDS, type TourKeyboard } from "../tourKeys";
import "@/index.css";

/**
 * Visual-review harness for the Daintree Tour dialog.
 *
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?chapter=<id>             open on a chapter (default: the first)
 *   ?t=<seconds>              freeze the scene at a moment (no playback)
 *   ?muted=1                  start muted (captions show)
 *   ?keyboard=mac|pc          narrate and draw that keyboard's shortcuts
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
const keyboardParam = params.get("keyboard");
const keyboard = TOUR_KEYBOARDS.find((k): k is TourKeyboard => k === keyboardParam);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

/**
 * Canvas-space centres of every `data-tour-anchor`, for refreshing `ANCHOR` in
 * MockApp.tsx and for working out a cursor step's `dx`/`dy` from its anchor.
 */
Reflect.set(window, "__tourAnchors", () => {
  const canvas = document.querySelector<HTMLElement>("[data-tour-canvas]");
  if (!canvas) return {};
  const box = canvas.getBoundingClientRect();
  const scale = box.width / canvas.offsetWidth;
  const anchors: Record<string, { x: number; y: number }> = {};
  for (const el of document.querySelectorAll<HTMLElement>("[data-tour-anchor]")) {
    const r = el.getBoundingClientRect();
    anchors[el.dataset.tourAnchor!] = {
      x: Math.round((r.left + r.width / 2 - box.left) / scale),
      y: Math.round((r.top + r.height / 2 - box.top) / scale),
    };
  }
  return anchors;
});

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
        tour={DAINTREE_TOUR}
        onClose={() => {}}
        initialChapter={chapterIndex}
        initialMuted={params.get("muted") === "1"}
        onChapterReached={() => {}}
        onCompleted={() => {}}
        onMutedChange={() => {}}
        onPlayer={onPlayer}
        keyboard={keyboard}
      />
    </TooltipProvider>
  </StrictMode>
);
