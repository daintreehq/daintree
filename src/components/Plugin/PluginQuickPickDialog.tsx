import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { PaletteFooterHints } from "@/components/ui/AppPaletteDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import type { PluginQuickPickItem } from "@shared/types/plugin";

const EMPTY_ITEMS: PluginQuickPickItem[] = [];

/**
 * Singleton dialog for `host.showQuickPick` (#10522). Mounted once in `App.tsx`.
 * Renders the front prompt of `pluginPromptStore` when it is a `quickPick`,
 * wrapping the app's `SearchablePalette` so search, keyboard navigation, and
 * motion/theming match the built-in palettes.
 *
 * Single-select: Enter (or click) resolves the highlighted item. Multi-select
 * (`canSelectMany`): Enter / click toggles the highlighted item and ⌘/Ctrl+Enter
 * submits the checked set. Dismissing (Escape / click-away) resolves `undefined`.
 */
export function PluginQuickPickDialog() {
  const current = usePluginPromptStore((state) => state.current);
  const resolveCurrent = usePluginPromptStore((state) => state.resolveCurrent);

  // Capture the narrowed quickPick `params` into a fresh object: `PendingUiPrompt`
  // is a struct whose `.params` is the union, so narrowing the discriminant on
  // the access expression doesn't carry through a stored reference to the whole
  // item — the object literal pins the narrowed `items`/`options` types.
  const quickPick =
    current && current.params.kind === "quickPick"
      ? {
          promptId: current.promptId,
          pluginId: current.pluginId,
          items: current.params.items,
          options: current.params.options,
        }
      : null;
  const isQuickPick = quickPick !== null;
  const promptId = quickPick ? quickPick.promptId : null;
  const options = quickPick ? quickPick.options : null;
  const pluginId = quickPick ? quickPick.pluginId : "";
  const items = quickPick ? quickPick.items : EMPTY_ITEMS;
  const canSelectMany = options?.canSelectMany ?? false;

  const fuseOptions = useMemo(
    () => ({
      keys: options?.matchOnDescription ? ["label", "description", "detail"] : ["label"],
      threshold: 0.4,
      ignoreLocation: true,
    }),
    [options?.matchOnDescription]
  );

  const { query, results, selectedIndex, setQuery, selectPrevious, selectNext, setSelectedIndex } =
    useSearchablePalette<PluginQuickPickItem>({
      items,
      fuseOptions,
      getItemId: (item) => item.id,
    });

  // Checked ids for multi-select. Reset whenever a new prompt is promoted.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setCheckedIds(new Set());
    setQuery("");
  }, [promptId, setQuery]);

  // resolveCurrent advances synchronously; gate to resolve each prompt once.
  const handledPromptIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (id: string, value: PluginQuickPickItem | PluginQuickPickItem[] | undefined) => {
      if (handledPromptIdRef.current === id) return;
      handledPromptIdRef.current = id;
      resolveCurrent(value);
    },
    [resolveCurrent]
  );

  const submitMulti = useCallback(() => {
    if (!promptId) return;
    const selected = items.filter((item) => checkedIds.has(item.id));
    resolveOnce(promptId, selected);
  }, [promptId, items, checkedIds, resolveOnce]);

  const toggle = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (!promptId) return;
    const item = results[selectedIndex];
    if (canSelectMany) {
      if (item) toggle(item.id);
      return;
    }
    resolveOnce(promptId, item ?? undefined);
  }, [promptId, results, selectedIndex, canSelectMany, toggle, resolveOnce]);

  const handleClose = useCallback(() => {
    if (promptId) resolveOnce(promptId, undefined);
  }, [promptId, resolveOnce]);

  // ⌘/Ctrl+Enter submits the checked set in multi-select mode.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (canSelectMany && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitMulti();
      }
    },
    [canSelectMany, submitMulti]
  );

  const renderItem = useCallback(
    (
      item: PluginQuickPickItem,
      index: number,
      isSelected: boolean,
      onHoverIndex: (index: number) => void
    ) => {
      const isChecked = checkedIds.has(item.id);
      return (
        <button
          key={item.id}
          id={`plugin-quick-pick-${item.id}`}
          tabIndex={-1}
          role="option"
          aria-selected={isSelected}
          onPointerDown={(e) => e.preventDefault()}
          onPointerMove={() => onHoverIndex(index)}
          onClick={() => {
            setSelectedIndex(index);
            if (canSelectMany) toggle(item.id);
            else if (promptId) resolveOnce(promptId, item);
          }}
          className={cn(
            PALETTE_ROW_CLASS,
            "w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
            "text-daintree-text/70 hover:bg-overlay-subtle hover:text-daintree-text"
          )}
        >
          {canSelectMany && (
            <span
              className={cn(
                "shrink-0 size-4 rounded border flex items-center justify-center",
                isChecked
                  ? "bg-overlay-raised border-overlay text-daintree-text"
                  : "border-overlay text-transparent"
              )}
              aria-hidden="true"
            >
              {isChecked && <Check size={12} />}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-daintree-text truncate">{item.label}</div>
            {item.description && (
              <div className="text-xs text-daintree-text/50 truncate">{item.description}</div>
            )}
            {item.detail && (
              <div className="text-xs text-text-secondary truncate">{item.detail}</div>
            )}
          </div>
        </button>
      );
    },
    [checkedIds, canSelectMany, toggle, promptId, resolveOnce, setSelectedIndex]
  );

  const footer = canSelectMany ? (
    <PaletteFooterHints
      primaryHint={{ keys: ["⌘", "↵"], label: `confirm ${checkedIds.size} selected` }}
      // Enter earns its chip here and only here: in a multi-select list it
      // toggles the row instead of confirming, so the palette's usual primary
      // key does something else. Navigation and close stay unstated.
      hints={[{ keys: ["↵"], label: "toggle" }]}
    />
  ) : undefined;

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginQuickPickDialog"
      resetKeys={[promptId ?? "null"]}
    >
      <SearchablePalette<PluginQuickPickItem>
        tier="command"
        isOpen={isQuickPick}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={setQuery}
        onSelectPrevious={selectPrevious}
        onSelectNext={selectNext}
        onConfirm={handleConfirm}
        onClose={handleClose}
        onHoverIndex={setSelectedIndex}
        onKeyDown={handleKeyDown}
        getItemId={(item) => item.id}
        renderItem={renderItem}
        label={options?.title || "Select an option"}
        ariaLabel={options?.title || "Plugin quick pick"}
        searchPlaceholder={options?.placeholder || "Search"}
        itemIdPrefix="plugin-quick-pick"
        emptyMessage={`No options provided by the '${pluginId}' plugin`}
        footer={footer}
      />
    </ErrorBoundary>
  );
}
