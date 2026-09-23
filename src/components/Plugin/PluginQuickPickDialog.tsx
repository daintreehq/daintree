import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { KBD_CLASS } from "@/components/ui/Kbd";
import { Button } from "@/components/ui/button";
import { checkboxVariants } from "@/components/ui/checkbox";
import { isMac } from "@/lib/platform";
import { PluginProvenance } from "./PluginProvenance";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { usePluginPromptStore } from "@/store/pluginPromptStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import type { PluginQuickPickItem } from "@shared/types/plugin";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";

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

  // The prompt carries the host's plugin *instance* key, which for a
  // project-owned plugin is `project__{projectId}__{manifestId}` — never copy a
  // person reads. Resolved through the runtime store like every other surface
  // that names a plugin; the fallback is the manifest id, never the raw key.
  const pluginName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
  );

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
    // Nothing under the cursor (empty list, or a query that matched nothing):
    // Enter is a no-op, not a silent cancel — the user is mid-search, and
    // dismissing stays one Escape away.
    if (item) resolveOnce(promptId, item);
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
          // Multi-select splits the two meanings a single-select row folds
          // together: `aria-checked` carries membership, and the cursor rides
          // `data-selected`, which draws the same rail and fill. Putting both on
          // `aria-selected` would light every checked row as if Enter acted on it.
          aria-selected={canSelectMany ? undefined : isSelected}
          aria-checked={canSelectMany ? isChecked : undefined}
          data-selected={canSelectMany && isSelected ? "true" : undefined}
          onPointerDown={(e) => e.preventDefault()}
          onPointerMove={() => onHoverIndex(index)}
          onClick={() => {
            setSelectedIndex(index);
            if (canSelectMany) toggle(item.id);
            else if (promptId) resolveOnce(promptId, item);
          }}
          className={cn(
            PALETTE_ROW_CLASS,
            "w-full flex items-start gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
            "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary"
          )}
        >
          {canSelectMany && (
            // Presentational: the option already owns the checked state, and a
            // real checkbox (a <button>) cannot nest inside it. Same classes as
            // the shared control so the two cannot drift apart.
            <span
              aria-hidden="true"
              data-state={isChecked ? "checked" : "unchecked"}
              className={cn(checkboxVariants({ size: "md" }), "mt-0.5 text-text-inverse")}
            >
              {isChecked && <Check />}
            </span>
          )}
          {/* Everything here is the plugin's, and a plugin label is often the
              only thing telling two rows apart (two pipeline files sharing a
              long prefix), so it wraps rather than truncating. */}
          <div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-text-primary">{item.label}</span>
              {item.description && (
                <span className="text-xs text-text-secondary">{item.description}</span>
              )}
            </div>
            {item.detail && <div className="mt-0.5 text-xs text-text-secondary">{item.detail}</div>}
          </div>
        </button>
      );
    },
    [checkedIds, canSelectMany, toggle, promptId, resolveOnce, setSelectedIndex]
  );

  // Always present: the footer band is host chrome, and the attribution is the
  // one line on this palette the plugin did not write.
  const footer = (
    <div className="flex w-full items-center justify-between gap-3">
      <PluginProvenance pluginName={pluginName} className="flex-1" />
      {canSelectMany && (
        <div className="flex shrink-0 items-center gap-3">
          {/* Enter earns its chip here and only here: in a multi-select list
              it toggles the row instead of confirming. */}
          <span className="inline-flex items-baseline">
            <kbd className={KBD_CLASS}>↵</kbd>
            <span className="ml-1.5">toggle</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            {/* The palette's own ↵ glyph, not `KbdChord`'s ⏎, so the two chips
                beside each other spell Enter the same way. */}
            <span className="inline-flex items-center gap-1" aria-hidden="true">
              <kbd className={KBD_CLASS}>{isMac() ? "⌘" : "Ctrl"}</kbd>
              <kbd className={KBD_CLASS}>↵</kbd>
            </span>
            <Button
              size="xs"
              variant="contrast"
              // Kept off the tab order: Tab walks the list from the search
              // field, and the chord beside it is the keyboard path.
              tabIndex={-1}
              aria-keyshortcuts={isMac() ? "Meta+Enter" : "Control+Enter"}
              onPointerDown={(e) => e.preventDefault()}
              onClick={submitMulti}
            >
              Confirm {checkedIds.size} selected
            </Button>
          </span>
        </div>
      )}
    </div>
  );

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
        // The visible attribution sits in the footer, which a screen reader
        // never reaches before answering; the dialog's name carries it instead.
        ariaLabel={`${options?.title || "Plugin quick pick"}, requested by the '${pluginName}' plugin`}
        searchPlaceholder={options?.placeholder || "Search"}
        itemIdPrefix="plugin-quick-pick"
        emptyMessage={`No options provided by the '${pluginName}' plugin`}
        footer={footer}
        multiselectable={canSelectMany}
      />
    </ErrorBoundary>
  );
}
