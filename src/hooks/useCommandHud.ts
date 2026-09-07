import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { actionService } from "@/services/ActionService";
import { combosFieldsEqual, keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { COMMAND_HUD_PREFIX, usePendingChord } from "./useGlobalKeybindings";
import { isStagedConfirmation } from "@/services/actions/confirmationStaged";

/** A single entry in the curated Cmd+K power-command layer. */
export interface CommandHudItem {
  actionId: string;
  /** Cmd+‹letter› glyphs for the shortcut chip (e.g. "⌘+R"). */
  displayKey: string;
  /** Human label shown as the row's primary text. */
  description: string;
  category: string;
}

export interface CommandHudGroup {
  category: string;
  items: CommandHudItem[];
}

export interface UseCommandHudReturn {
  isOpen: boolean;
  query: string;
  setQuery: (query: string) => void;
  /** Flat, selection-ordered list. Concatenation of every group's items. */
  results: CommandHudItem[];
  /** Category-grouped view for rendering; flattening yields `results`. */
  groups: CommandHudGroup[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  selectNext: () => void;
  selectPrevious: () => void;
  run: (item: CommandHudItem) => void;
  runSelected: () => void;
  close: () => void;
}

function buildLayerItems(): CommandHudItem[] {
  // The HUD shows only the curated Cmd+K chord layer — every completion of the
  // `Cmd+K` prefix. Synthetic sub-prefix rows (`actionId === ""`, deeper 3-part
  // chords) are filtered out; the flat map has none, but guard anyway.
  return keybindingService
    .getChordCompletions(COMMAND_HUD_PREFIX)
    .filter((entry) => entry.actionId !== "")
    .map((entry) => ({
      actionId: entry.actionId,
      displayKey: entry.displayKey,
      description: entry.description,
      category: entry.category,
    }));
}

export function useCommandHud(): UseCommandHudReturn {
  const pendingChord = usePendingChord();
  const isOpen = pendingChord !== null && combosFieldsEqual(pendingChord, COMMAND_HUD_PREFIX);

  const [query, setQueryState] = useState("");
  const [selectedIndex, setSelectedIndexState] = useState(0);

  // Build the layer only while open — closed, the HUD holds no rows.
  const layer = useMemo<CommandHudItem[]>(() => {
    if (!isOpen) return [];
    return buildLayerItems();
  }, [isOpen]);

  const { results, groups } = useMemo<{
    results: CommandHudItem[];
    groups: CommandHudGroup[];
  }>(() => {
    if (layer.length === 0) return { results: [], groups: [] };

    const trimmed = query.trim().toLowerCase();
    const filtered = trimmed
      ? layer.filter(
          (item) =>
            item.description.toLowerCase().includes(trimmed) ||
            item.displayKey.toLowerCase().includes(trimmed)
        )
      : layer;

    // Group preserving `filtered` sequence: category order follows first
    // appearance, so rows stay category-contiguous. Flattening reproduces the
    // selection order.
    const map = new Map<string, CommandHudItem[]>();
    for (const item of filtered) {
      const arr = map.get(item.category);
      if (arr) arr.push(item);
      else map.set(item.category, [item]);
    }
    const grouped: CommandHudGroup[] = Array.from(map, ([category, items]) => ({
      category,
      items,
    }));
    const flat = grouped.flatMap((group) => group.items);
    return { results: flat, groups: grouped };
  }, [layer, query]);

  // Reset query + selection on each open so the HUD never reopens mid-search.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setQueryState("");
      setSelectedIndexState(0);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setSelectedIndexState(0);
  }, []);

  const setSelectedIndex = useCallback((index: number) => {
    setSelectedIndexState(index);
  }, []);

  const selectNext = useCallback(() => {
    setSelectedIndexState((prev) => {
      if (results.length === 0) return 0;
      return prev >= results.length - 1 ? 0 : prev + 1;
    });
  }, [results.length]);

  const selectPrevious = useCallback(() => {
    setSelectedIndexState((prev) => {
      if (results.length === 0) return 0;
      return prev <= 0 ? results.length - 1 : prev - 1;
    });
  }, [results.length]);

  const close = useCallback(() => {
    keybindingService.clearPendingChord();
  }, []);

  const run = useCallback((item: CommandHudItem) => {
    // Close first so the HUD never lingers behind an action that opens a modal
    // or moves focus. The layer is a fixed curated set — no MRU recording.
    keybindingService.clearPendingChord();

    // Respect a palette redirect: a headless action can point at an interactive
    // sibling (e.g. git.commit → Review Hub, which must never auto-derive a
    // message). Dispatch the redirect target, not the raw id — mirrors the
    // command palette.
    const entry = actionService.get(item.actionId as Parameters<typeof actionService.get>[0]);
    const dispatchId = (entry?.paletteRedirectTo ?? item.actionId) as Parameters<
      typeof actionService.dispatch
    >[0];

    void actionService
      .dispatch(
        dispatchId,
        {},
        {
          source: "user",
        }
      )
      .then((result) => {
        if (result.ok) return;
        // DISABLED is already visible on the originating surface.
        if (result.error.code === "DISABLED") return;
        // So is a parked confirmation: the action reports CONFIRMATION_REQUIRED
        // rather than a silent no-op (#12120), but the dialog it just opened is
        // what the user should be answering — not an error toast over it.
        if (isStagedConfirmation(result.error)) return;
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: `Couldn't run '${item.description}'`,
          message: formatErrorMessage(result.error, "Action failed."),
        });
      })
      .catch(() => {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: `Couldn't run '${item.description}'`,
          message: "An unexpected error occurred.",
        });
      });
  }, []);

  const runSelected = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= results.length) return;
    run(results[selectedIndex]!);
  }, [run, results, selectedIndex]);

  return {
    isOpen,
    query,
    setQuery,
    results,
    groups,
    selectedIndex,
    setSelectedIndex,
    selectNext,
    selectPrevious,
    run,
    runSelected,
    close,
  };
}
