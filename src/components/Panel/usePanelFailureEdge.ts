import { useEffect } from "react";
import { HAND_BACK_SEEN_DWELL_MS } from "@shared/utils/runHandBack";
import { canopyViewIsWatched } from "@/lib/canopySeen";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useCanopyStore } from "@/store/canopyStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectHomeStore } from "@/store/projectHomeStore";
import {
  PANEL_FAILURE_SOURCES,
  usePanelFailureStore,
  type PanelFailureSource,
  type PanelFailureTokens,
} from "@/store/panelFailureStore";

type PanelLocation = "grid" | "dock" | "dialog";

/**
 * In front of the user by the look that reads a run's hand-back: the focused
 * pane, while its view can be seen, its window has focus and Canopy is not
 * open over it. The project's Home covers the grid but not a dock popover or
 * a panel dialog.
 */
function isPaneInFront(panelId: string, location: PanelLocation): boolean {
  if (!canopyViewIsWatched() || useCanopyStore.getState().isOpen) return false;
  const { focusedId, activeDockTerminalId } = usePanelStore.getState();
  if (focusedId !== panelId) return false;
  if (location === "dock") return activeDockTerminalId === panelId;
  if (location === "grid") return !useProjectHomeStore.getState().presented;
  return true;
}

function parsePending(pending: string): PanelFailureTokens {
  const tokens: PanelFailureTokens = {};
  for (const entry of pending.split(",")) {
    const [source, token] = entry.split(":");
    if (token === undefined || token === "?") continue;
    tokens[source as PanelFailureSource] = Number(token);
  }
  return tokens;
}

/**
 * Whether the pane's red edge draws (#16140): a failure it shows that the user
 * hasn't yet had in front of them. Once the pane has been in front for the
 * hand-back dwell, the failures it showed are seen and the edge goes; a new
 * failure raises it again. The header glyph and the inline banners keep the
 * failure for as long as it lasts.
 *
 * A shown failure the store hasn't read yet has no token: it draws, and can't
 * be seen until it has one.
 */
export function usePanelFailureEdge(
  panelId: string,
  shown: Readonly<Record<PanelFailureSource, boolean>>,
  isFocused: boolean,
  location: PanelLocation
): boolean {
  const occurrences = usePanelFailureStore((state) => state.occurrences[panelId]);
  const seen = usePanelFailureStore((state) => state.seen[panelId]);

  let pending = "";
  for (const source of PANEL_FAILURE_SOURCES) {
    if (!shown[source]) continue;
    const token = occurrences?.[source]?.token;
    if (token !== undefined && seen?.[source] === token) continue;
    pending += `${pending === "" ? "" : ","}${source}:${token ?? "?"}`;
  }
  const armed = isFocused && pending !== "";

  useEffect(() => {
    if (!armed) return;
    const tokens = parsePending(pending);
    if (Object.keys(tokens).length === 0) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    // Every way the look can stop cancels the dwell; coming back starts it over.
    const sync = () => {
      if (!isPaneInFront(panelId, location)) {
        cancel();
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (isPaneInFront(panelId, location)) {
          usePanelFailureStore.getState().markSeen(panelId, tokens);
        }
      }, HAND_BACK_SEEN_DWELL_MS);
    };
    sync();

    const offPanels = usePanelStore.subscribe((state, prev) => {
      if (
        state.focusedId !== prev.focusedId ||
        state.activeDockTerminalId !== prev.activeDockTerminalId
      ) {
        sync();
      }
    });
    const offObservable = subscribeProjectViewObservability(sync);
    const offCanopy = useCanopyStore.subscribe((state, prev) => {
      if (state.isOpen !== prev.isOpen) sync();
    });
    const offHome = useProjectHomeStore.subscribe((state, prev) => {
      if (state.presented !== prev.presented) sync();
    });
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);

    return () => {
      offPanels();
      offObservable();
      offCanopy();
      offHome();
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      cancel();
    };
  }, [armed, pending, panelId, location]);

  return pending !== "";
}
