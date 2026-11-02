import { useEffect } from "react";
import type { WindowGlobalAssistantPanel } from "@shared/types/ipc/help";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { logWarn } from "@/utils/logger";

type HelpPanelSnapshot = ReturnType<typeof useHelpPanelStore.getState>;

function panelOf(state: HelpPanelSnapshot): WindowGlobalAssistantPanel {
  const showing = state.isOpen && state.globalSelected;
  return { showing, target: showing ? state.globalTarget : null };
}

function keyOf(panel: WindowGlobalAssistantPanel): string {
  const target = panel.target;
  return `${panel.showing}:${target ? `${target.hostId}:${target.terminalId}:${target.incarnation}` : ""}`;
}

function samePresentation(a: HelpPanelSnapshot, b: HelpPanelSnapshot): boolean {
  return (
    a.isOpen === b.isOpen &&
    a.globalSelected === b.globalSelected &&
    a.globalTarget === b.globalTarget &&
    a.activeSlot === b.activeSlot &&
    // Asking for the lane already on screen changes nothing above, and is still a choice.
    a.focusRequest === b.focusRequest
  );
}

/**
 * Keeps the global assistant on screen across this window's project switches
 * (#16099). Main holds one record per window of whether its panel showed
 * Global; the view on screen reports every change to it, and a view coming on
 * screen — opened cold, or reactivated from the cache — reads it first and
 * shows the same. Read by the incoming view rather than handed over by the
 * outgoing one, so every way a window switches project is covered.
 *
 * Mounted at bootstrap, not in the lazy panel: a cold view whose panel never
 * opened has no panel yet, and is exactly the one that must open it.
 */
export function useWindowGlobalAssistantPanel(): void {
  useEffect(() => {
    const help = window.electron?.help;
    if (!help?.getWindowGlobalAssistantPanel || !help.reportWindowGlobalAssistantPanel) return;
    // A window bound to another host doesn't show this machine's global assistant.
    if (getViewHostId() !== null) return;

    let disposed = false;
    let generation = 0;
    // Off until this view has read the window's record: its own state before
    // then is a default, or what it last showed before it was cached.
    let reporting = false;
    let reading = false;
    let lastReported: string | null = null;

    const report = (state: HelpPanelSnapshot) => {
      if (!reporting) return;
      const panel = panelOf(state);
      const key = keyOf(panel);
      if (key === lastReported) return;
      lastReported = key;
      help.reportWindowGlobalAssistantPanel(panel).catch((error: unknown) => {
        logWarn("[GlobalAssistant] couldn't report the window's panel", { error });
      });
    };

    const sync = () => {
      const mine = ++generation;
      reporting = false;
      reading = true;
      const before = useHelpPanelStore.getState();
      help.getWindowGlobalAssistantPanel().then(
        (panel) => {
          if (disposed || mine !== generation) return;
          reading = false;
          if (isProjectViewCached()) return;
          const store = useHelpPanelStore.getState();
          // Something chose what the panel shows while this was asked — an
          // "Open in Assistant" landing, a click — and that choice stands.
          if (samePresentation(before, store)) store.applyWindowGlobalPanel(panel);
          reporting = true;
          lastReported = null;
          report(useHelpPanelStore.getState());
        },
        (error: unknown) => {
          if (disposed || mine !== generation) return;
          reading = false;
          logWarn("[GlobalAssistant] couldn't read the window's panel", { error });
          // What this view shows now was never the window's; only a change is.
          reporting = true;
          lastReported = keyOf(panelOf(useHelpPanelStore.getState()));
        }
      );
    };

    const unsubscribe = useHelpPanelStore.subscribe(report);
    const offLifecycle = subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") {
        generation++;
        reporting = false;
        reading = false;
      } else if (phase === "active" || (!reporting && !reading)) {
        // `revealed` only stands in for an `active` this view never heard.
        sync();
      }
    });
    if (!isProjectViewCached()) sync();

    return () => {
      disposed = true;
      unsubscribe();
      offLifecycle();
    };
  }, []);
}
