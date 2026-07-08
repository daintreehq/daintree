import { useCallback, useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { usePanelStore, usePreferencesStore } from "@/store";
import { isPtyPanel, type PanelKind } from "@shared/types/panel";
import { useSearchablePalette } from "./useSearchablePalette";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol";
import { usePaletteStore } from "@/store/paletteStore";
import { deriveTerminalChrome, type TerminalChromeDescriptor } from "@/utils/terminalChrome";

export interface SendToAgentItem {
  id: string;
  title: string;
  subtitle?: string;
  terminalKind?: PanelKind;
  chrome: TerminalChromeDescriptor;
  isInputLocked?: boolean;
}

// Module-level state for the opener function (object to avoid react-compiler reassignment warning)
const pendingState = { sourceId: null as string | null, selection: "" };

function hasSendTargets(sourceTerminalId: string | null): boolean {
  const { panelsById, panelIds } = usePanelStore.getState();
  return panelIds.some((id) => {
    const t = panelsById[id];
    return (
      t &&
      t.id !== sourceTerminalId &&
      t.location !== "trash" &&
      t.location !== "background" &&
      t.location !== "overlay" &&
      isPtyPanel(t) &&
      t.hasPty !== false
    );
  });
}

export function openSendToAgentPalette(sourceTerminalId: string): boolean {
  const selection = terminalInstanceService.getCachedSelection(sourceTerminalId);
  if (!selection) return false;
  if (!hasSendTargets(sourceTerminalId)) return false;

  pendingState.sourceId = sourceTerminalId;
  pendingState.selection = selection;
  usePaletteStore.getState().openPalette("send-to-agent");
  return true;
}

/**
 * Opens the send-to-agent palette pre-populated with arbitrary text instead of
 * a cached terminal selection. Used by handoff surfaces (e.g. the agent
 * completion banner) that already have the text to relay. `sourceTerminalId`,
 * when provided, is excluded from the target list so an agent doesn't send its
 * own output back to itself.
 */
export function openSendToAgentPaletteWithText(text: string, sourceTerminalId?: string): boolean {
  if (!text.trim()) return false;
  const sourceId = sourceTerminalId ?? null;
  if (!hasSendTargets(sourceId)) return false;

  pendingState.sourceId = sourceId;
  pendingState.selection = text;
  usePaletteStore.getState().openPalette("send-to-agent");
  return true;
}

const FUSE_OPTIONS: IFuseOptions<SendToAgentItem> = {
  keys: [
    { name: "title", weight: 2 },
    { name: "subtitle", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

function sendSelectionToTarget(targetId: string): void {
  const text = pendingState.selection;
  if (!text) return;
  if (targetId === pendingState.sourceId) return;

  const managed = terminalInstanceService.get(targetId);
  if (managed) {
    if (managed.terminal.modes.bracketedPasteMode) {
      terminalClient.write(targetId, formatWithBracketedPaste(text));
    } else {
      terminalClient.write(targetId, text.replace(/\r?\n/g, "\r"));
    }
    terminalInstanceService.notifyUserInput(targetId);
  } else {
    terminalClient.write(targetId, formatWithBracketedPaste(text));
  }

  pendingState.sourceId = null;
  pendingState.selection = "";
}

const MAX_RESULTS = 20;

const EMPTY_PANEL_IDS: string[] = [];
const EMPTY_PANELS_BY_ID: ReturnType<typeof usePanelStore.getState>["panelsById"] = {};

export function useSendToAgentPalette() {
  // Always mounted in App: subscribe to the panel map only while open — a
  // live selector here re-rendered the whole App on every agent-state flip
  // and status flush. The open() helpers above already read via getState().
  const isOpen = usePaletteStore((state) => state.activePaletteId === "send-to-agent");
  const panelIds = usePanelStore((state) => (isOpen ? state.panelIds : EMPTY_PANEL_IDS));
  const panelsById = usePanelStore((state) => (isOpen ? state.panelsById : EMPTY_PANELS_BY_ID));
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);

  const items = useMemo<SendToAgentItem[]>(() => {
    const sourceId = isOpen ? pendingState.sourceId : null;
    const result: SendToAgentItem[] = [];

    for (const id of panelIds) {
      const t = panelsById[id];
      if (!t) continue;
      if (sourceId && t.id === sourceId) continue;
      if (t.location === "trash" || t.location === "background" || t.location === "overlay")
        continue;
      if (!isPtyPanel(t)) continue;
      if (t.hasPty === false) continue;

      const chrome = deriveTerminalChrome(t);
      const subtitle = chrome.label;

      result.push({
        id: t.id,
        // Full composed display title so rows read (and fuzzy-match) the same
        // as the live tab: "Claude: fix auth tests".
        title: getTerminalDisplayTitle(t, "full", { showTask: showAgentTaskTitles }),
        subtitle,
        terminalKind: t.kind,
        chrome,
        isInputLocked: t.isInputLocked,
      });
    }

    return result;
  }, [panelIds, panelsById, isOpen, showAgentTaskTitles]);

  const fuse = useMemo(() => new Fuse(items, FUSE_OPTIONS), [items]);

  const filterFn = useCallback(
    (allItems: SendToAgentItem[], query: string): SendToAgentItem[] => {
      if (!query.trim()) return allItems;
      return fuse.search(query).map((r) => r.item);
    },
    [fuse]
  );

  const canNavigate = useCallback((item: SendToAgentItem) => !item.isInputLocked, []);

  const palette = useSearchablePalette<SendToAgentItem>({
    items,
    filterFn,
    maxResults: MAX_RESULTS,
    canNavigate,
    paletteId: "send-to-agent",
  });

  const selectItem = useCallback(
    (item: SendToAgentItem) => {
      sendSelectionToTarget(item.id);
      palette.close();
    },
    [palette]
  );

  const confirmSelection = useCallback(() => {
    const { results, selectedIndex } = palette;
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectItem(results[selectedIndex]!);
    }
  }, [palette, selectItem]);

  return {
    ...palette,
    selectItem,
    confirmSelection,
  };
}
