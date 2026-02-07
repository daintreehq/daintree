import { useCallback, useMemo, useRef } from "react";
import type { IFuseOptions } from "fuse.js";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import type { ActionManifestEntry } from "@shared/types/actions";
import { useSearchablePalette, type UseSearchablePaletteReturn } from "./useSearchablePalette";

export interface ActionPaletteItem {
  id: string;
  title: string;
  description: string;
  category: string;
  enabled: boolean;
  disabledReason?: string;
  keybinding?: string;
  kind: string;
}

export type UseActionPaletteReturn = UseSearchablePaletteReturn<ActionPaletteItem> & {
  executeAction: (item: ActionPaletteItem) => void;
};

const FUSE_OPTIONS: IFuseOptions<ActionPaletteItem> = {
  keys: [
    { name: "title", weight: 2 },
    { name: "category", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

function toActionPaletteItem(entry: ActionManifestEntry): ActionPaletteItem {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    category: entry.category,
    enabled: entry.enabled,
    disabledReason: entry.disabledReason,
    keybinding: keybindingService.getDisplayCombo(entry.id),
    kind: entry.kind,
  };
}

export function useActionPalette(): UseActionPaletteReturn {
  const closeFnRef = useRef<() => void>(() => {});

  const executeAction = useCallback((item: ActionPaletteItem) => {
    if (!item.enabled) return;
    closeFnRef.current();
    void actionService.dispatch(
      item.id as Parameters<typeof actionService.dispatch>[0],
      undefined,
      { source: "user" }
    );
  }, []);

  const allActions = useMemo<ActionPaletteItem[]>(() => {
    const entries = actionService.list();
    return entries
      .filter((e) => e.kind === "command")
      .map(toActionPaletteItem)
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
  }, []);

  const palette = useSearchablePalette<ActionPaletteItem>({
    items: allActions,
    fuseOptions: FUSE_OPTIONS,
    maxResults: 20,
    onSelect: executeAction,
  });

  closeFnRef.current = palette.close;

  return {
    ...palette,
    executeAction,
  };
}
