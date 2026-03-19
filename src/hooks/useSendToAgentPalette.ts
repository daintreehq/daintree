import { useCallback, useMemo } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { useSearchablePalette } from "./useSearchablePalette";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol";
import { usePaletteStore } from "@/store/paletteStore";
import { getAgentConfig } from "@/config/agents";

export interface SendToAgentItem {
  id: string;
  title: string;
  subtitle?: string;
  terminalType?: TerminalInstance["type"];
  terminalKind?: TerminalInstance["kind"];
  agentId?: TerminalInstance["agentId"];
  detectedProcessId?: TerminalInstance["detectedProcessId"];
  isInputLocked?: boolean;
}

// Module-level state for the opener function (object to avoid react-compiler reassignment warning)
const pendingState = { sourceId: null as string | null, selection: "" };

export function openSendToAgentPalette(sourceTerminalId: string): boolean {
  const selection = terminalInstanceService.getCachedSelection(sourceTerminalId);
  if (!selection) return false;

  const terminals = useTerminalStore.getState().terminals;
  const hasTargets = terminals.some(
    (t) =>
      t.id !== sourceTerminalId &&
      t.location !== "trash" &&
      t.location !== "background" &&
      (t.kind ? panelKindHasPty(t.kind) : true) &&
      t.hasPty !== false
  );
  if (!hasTargets) return false;

  pendingState.sourceId = sourceTerminalId;
  pendingState.selection = selection;
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

export function useSendToAgentPalette() {
  const terminals = useTerminalStore(useShallow((state) => state.terminals));
  const isOpen = usePaletteStore((state) => state.activePaletteId === "send-to-agent");

  const items = useMemo<SendToAgentItem[]>(() => {
    const sourceId = isOpen ? pendingState.sourceId : null;
    const result: SendToAgentItem[] = [];

    for (const t of terminals) {
      if (sourceId && t.id === sourceId) continue;
      if (t.location === "trash" || t.location === "background") continue;
      if (t.kind && !panelKindHasPty(t.kind)) continue;
      if (t.hasPty === false) continue;

      const agentConfig = t.agentId ? getAgentConfig(t.agentId) : null;
      const subtitle = agentConfig ? agentConfig.name : t.type !== "terminal" ? t.type : "Terminal";

      result.push({
        id: t.id,
        title: t.title,
        subtitle,
        terminalType: t.type,
        terminalKind: t.kind,
        agentId: t.agentId,
        detectedProcessId: t.detectedProcessId,
        isInputLocked: t.isInputLocked,
      });
    }

    return result;
  }, [terminals, isOpen]);

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
      selectItem(results[selectedIndex]);
    }
  }, [palette, selectItem]);

  return {
    ...palette,
    selectItem,
    confirmSelection,
  };
}
