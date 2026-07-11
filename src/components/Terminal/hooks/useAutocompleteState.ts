import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { AutocompleteItem } from "@/components/Terminal/AutocompleteMenu";
import type { ActiveCompletionContext } from "../hybridInputParsing";

interface UseAutocompleteStateParams {
  isAutocompleteOpen: boolean;
  activeCompletionContext: ActiveCompletionContext | null;
  autocompleteItems: AutocompleteItem[];
  rootRef: React.RefObject<HTMLDivElement | null>;
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  lastQueryRef: React.RefObject<string>;
  setActiveCompletionContext: Dispatch<SetStateAction<ActiveCompletionContext | null>>;
}

export function useAutocompleteState({
  isAutocompleteOpen,
  activeCompletionContext,
  autocompleteItems,
  rootRef,
  selectedIndex,
  setSelectedIndex,
  lastQueryRef,
  setActiveCompletionContext,
}: UseAutocompleteStateParams) {
  // A new query (user typed) resets selection to the top; items arriving async
  // for the SAME query preserve the selected item by key so a slow provider
  // merge doesn't jump the highlight. Tracking the items reference lets user
  // arrow-navigation (selectedIndex changes, items don't) pass through untouched.
  const prevRef = useRef<{
    queryKey: string;
    items: AutocompleteItem[];
    selectedKey: string | null;
  }>({ queryKey: "", items: [], selectedKey: null });

  const queryKey = activeCompletionContext
    ? `${activeCompletionContext.triggerChar}:${activeCompletionContext.start}:${activeCompletionContext.query}`
    : "";

  useEffect(() => {
    const prev = prevRef.current;

    if (queryKey !== prev.queryKey) {
      lastQueryRef.current = queryKey;
      if (selectedIndex !== 0) setSelectedIndex(0);
      prevRef.current = {
        queryKey,
        items: autocompleteItems,
        selectedKey: autocompleteItems[0]?.key ?? null,
      };
      return;
    }

    if (autocompleteItems !== prev.items) {
      // Items merged/refreshed for the same query: keep the selected key if it
      // survived, else clamp into range.
      const clamped = Math.min(selectedIndex, Math.max(0, autocompleteItems.length - 1));
      const survivingIndex = prev.selectedKey
        ? autocompleteItems.findIndex((item) => item.key === prev.selectedKey)
        : -1;
      const nextIndex = survivingIndex >= 0 ? survivingIndex : clamped;
      if (nextIndex !== selectedIndex) setSelectedIndex(nextIndex);
      prevRef.current = {
        queryKey,
        items: autocompleteItems,
        selectedKey: autocompleteItems[nextIndex]?.key ?? null,
      };
      return;
    }

    // Only selectedIndex changed (user arrow-nav): record the new selection.
    prevRef.current = {
      queryKey,
      items: autocompleteItems,
      selectedKey: autocompleteItems[selectedIndex]?.key ?? prev.selectedKey,
    };
  }, [queryKey, autocompleteItems, selectedIndex, setSelectedIndex, lastQueryRef]);

  useEffect(() => {
    if (!isAutocompleteOpen) return;
    const root = rootRef.current;
    if (!root) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (root.contains(target)) return;
      setActiveCompletionContext(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isAutocompleteOpen, rootRef, setActiveCompletionContext]);
}
