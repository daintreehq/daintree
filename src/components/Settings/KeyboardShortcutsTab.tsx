import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { keybindingService, type RegisteredKeybindingConfig } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { KbdChord } from "@/components/ui/Kbd";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { KeybindingProfileActions } from "./KeybindingProfileActions";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSearchField } from "./SettingsSearchField";
import { SettingsSection } from "./SettingsSection";
import { SettingsShortcutCapture } from "@/components/KeyboardShortcuts";

interface ShortcutBinding extends RegisteredKeybindingConfig {
  effectiveCombo: string;
  isOverridden: boolean;
  /**
   * One action can be registered more than once under different scopes (e.g.
   * `fleet.armFocused` is bound both globally and in the worktree grid), so the
   * action ID alone does not identify a row. Keying editor and error state by
   * action ID would open both editors at once and render the same alert twice.
   */
  rowId: string;
}

// KeybindingService writes to disk before it touches its in-memory maps, so a
// failed dispatch leaves no optimistic state to undo — the binding on screen is
// still the durable one. What a failure must do is refuse to *look* like a
// success: hold the editor open and offer the retry, rather than closing and
// reloading as if the edit had landed.
type ShortcutError =
  | { kind: "save"; rowId: string; actionId: string; combo: string }
  | { kind: "reset"; rowId: string; actionId: string }
  | { kind: "reset-all" };

type RowError = Extract<ShortcutError, { rowId: string }>;

interface ShortcutRowProps {
  binding: ShortcutBinding;
  isEditing: boolean;
  /** Put focus back on this row's binding once its editor closes. */
  restoreFocus: boolean;
  error: RowError | null;
  onEdit: () => void;
  onSave: (combo: string) => void;
  onCancel: () => void;
  onReset: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  onFocusRestored: () => void;
}

function ShortcutRowError({
  error,
  onRetry,
  onDismissError,
}: {
  error: RowError;
  onRetry: () => void;
  onDismissError: () => void;
}) {
  const isSave = error.kind === "save";
  return (
    <InlineStatusBanner
      className="rounded-[var(--radius-md)]"
      severity="error"
      icon={AlertCircle}
      title={isSave ? "Couldn't save shortcut" : "Couldn't reset shortcut"}
      description={
        isSave
          ? "The shortcut still has its previous binding. Retry to save the one you captured."
          : "The shortcut keeps its custom binding for now."
      }
      action={{ id: "retry", label: "Retry", onClick: onRetry }}
      onClose={onDismissError}
      closeAriaLabel="Dismiss shortcut error"
    />
  );
}

function ShortcutRow({
  binding,
  isEditing,
  restoreFocus,
  error,
  onEdit,
  onSave,
  onCancel,
  onReset,
  onRetry,
  onDismissError,
  onFocusRestored,
}: ShortcutRowProps) {
  const name = binding.description || binding.actionId;
  const editRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!restoreFocus || isEditing) return;
    editRef.current?.focus();
    onFocusRestored();
  }, [restoreFocus, isEditing, onFocusRestored]);

  if (isEditing) {
    return (
      <div data-testid="shortcut-row">
        <SettingsRow
          label={name}
          layout="stacked"
          isModified={binding.isOverridden}
          control={
            <div className="grid gap-3">
              <SettingsShortcutCapture
                onCapture={onSave}
                onCancel={onCancel}
                excludeActionId={binding.actionId}
                scope={binding.scope}
                currentCombo={binding.effectiveCombo}
                autoStart
              />
              {error && (
                <ShortcutRowError error={error} onRetry={onRetry} onDismissError={onDismissError} />
              )}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div data-testid="shortcut-row">
      <SettingsRow
        className="py-2"
        label={name}
        isModified={binding.isOverridden}
        onReset={onReset}
        onRowClick={onEdit}
        control={
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={editRef}
                type="button"
                onClick={onEdit}
                className={cn(
                  "inline-flex items-center h-6 px-2 rounded-[var(--radius-sm)]",
                  "ring-1 ring-border-default text-text-secondary",
                  "hover:ring-border-strong hover:bg-overlay-soft hover:text-text-primary",
                  "transition-colors duration-150 ease-out"
                )}
              >
                {binding.effectiveCombo ? (
                  <>
                    <span className="sr-only">Edit shortcut for {name}: </span>
                    <KbdChord
                      shortcut={binding.effectiveCombo}
                      density="bare"
                      className="text-text-primary"
                    />
                  </>
                ) : (
                  <span className="text-xs">
                    Add shortcut<span className="sr-only"> for {name}</span>
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {binding.effectiveCombo ? "Change shortcut" : "Add shortcut"}
            </TooltipContent>
          </Tooltip>
        }
      />
      {error && (
        <div className="px-4 pb-3">
          <ShortcutRowError error={error} onRetry={onRetry} onDismissError={onDismissError} />
        </div>
      )}
    </div>
  );
}

interface FixedShortcut {
  label: string;
  /** Alternative keys, each a combo string `KbdChord` can render. */
  keys: string[];
  description: string;
}

// Worktree-list navigation and drag-handle reordering live outside the keybinding
// engine (useWorktreeSidebarKeyboard's roving focus, dnd-kit's keyboard sensor), so
// they are documented as fixed rather than offered as rows that could never fire.
const FIXED_SHORTCUTS: FixedShortcut[] = [
  {
    label: "Move through the worktree list",
    keys: ["Up", "Down", "J", "K"],
    description: "PageUp, PageDown, Home and End jump further",
  },
  {
    label: "Open worktree",
    keys: ["Space"],
    description: "Enter or Right moves into the row's actions",
  },
  {
    label: "Reorder worktree",
    keys: ["Alt+Up", "Alt+Down"],
    description: "With the worktree focused in the sidebar",
  },
  {
    label: "Reorder panel",
    keys: ["Space"],
    description:
      "Focus the panel header, press Space to pick it up, move with the arrow keys, Space to drop, Esc to cancel",
  },
  {
    label: "Reorder tab",
    keys: ["Space"],
    description:
      "Focus the active tab, press Space to pick it up, move with the arrow keys, Space to drop",
  },
];

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  return fields.some((field) => field?.toLowerCase().includes(query) ?? false);
}

type FilterMode = "all" | "modified";

const FILTER_MODES: { value: FilterMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "modified", label: "Modified" },
];

export function KeyboardShortcutsTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<ShortcutBinding[]>([]);
  const [, setUpdateKey] = useState(0);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  // One error at a time across the whole tab, so a stale banner can never sit
  // under a row the user has since moved on from.
  const [shortcutError, setShortcutError] = useState<ShortcutError | null>(null);

  const loadBindings = useCallback(() => {
    const allBindings = keybindingService.getAllBindingsWithEffectiveCombos();
    setBindings(
      allBindings.map((b, index) => ({
        ...b,
        isOverridden: keybindingService.hasOverride(b.actionId),
        // `combo` is the DEFAULT binding, so this stays stable when an override
        // changes `effectiveCombo`. The index disambiguates the registry's few
        // legal exact duplicates (a plugin may register the same action, scope
        // and combo as a built-in); registration order is what produces the list,
        // so it does not shift as overrides come and go.
        rowId: `${b.actionId}::${b.scope}::${b.combo}::${index}`,
      }))
    );
  }, []);

  useEffect(() => {
    keybindingService.loadOverrides().then(loadBindings);

    const unsubscribe = keybindingService.subscribe(() => {
      loadBindings();
      setUpdateKey((k) => k + 1);
    });

    return unsubscribe;
  }, [loadBindings]);

  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const query = searchQuery.trim().toLowerCase();

  const filteredBindings = useMemo(() => {
    return bindings.filter(
      (b) =>
        (filterMode === "all" || b.isOverridden) &&
        (!query || matchesQuery(query, b.description, b.actionId, b.effectiveCombo, b.category))
    );
  }, [bindings, query, filterMode]);

  // Fixed keys have no default to depart from, so the Modified filter hides them.
  const filteredFixed = useMemo(() => {
    if (filterMode === "modified") return [];
    if (!query) return FIXED_SHORTCUTS;
    return FIXED_SHORTCUTS.filter((f) =>
      matchesQuery(query, f.label, f.description, f.keys.join(" "))
    );
  }, [query, filterMode]);

  const groupedBindings = useMemo(() => {
    const groups = new Map<string, ShortcutBinding[]>();
    filteredBindings.forEach((binding) => {
      const category = binding.category || "Other";
      if (!groups.has(category)) {
        groups.set(category, []);
      }
      groups.get(category)!.push(binding);
    });
    return groups;
  }, [filteredBindings]);

  // An imported profile replaces every binding, which invalidates any edit that
  // was in flight when it landed: a save resolving afterwards would either raise
  // a banner about a binding that no longer exists, or let its Retry overwrite
  // the freshly imported profile with a stale captured combo. Bump the epoch on
  // import; operations started before it no longer touch the UI.
  const bindingsEpochRef = useRef(0);

  const closeEditor = (rowId: string) => {
    setEditingRowId(null);
    setFocusRowId(rowId);
  };

  const handleSaveShortcut = async (rowId: string, actionId: string, combo: string) => {
    const epoch = bindingsEpochRef.current;
    const result = await actionService.dispatch(
      "keybinding.setOverride",
      { actionId, combo: combo === "" ? [] : [combo] },
      { source: "user" }
    );
    if (epoch !== bindingsEpochRef.current) return;

    if (!result.ok) {
      logError("Failed to save keybinding override", undefined, { error: result.error });
      // Hold the editor open on the failing row. Closing here would show the old
      // binding with no hint that the capture was thrown away.
      setShortcutError({ kind: "save", rowId, actionId, combo });
      return;
    }
    setShortcutError(null);
    closeEditor(rowId);
    loadBindings();
  };

  const handleResetShortcut = async (rowId: string, actionId: string) => {
    const epoch = bindingsEpochRef.current;
    const result = await actionService.dispatch(
      "keybinding.removeOverride",
      { actionId },
      { source: "user" }
    );
    if (epoch !== bindingsEpochRef.current) return;

    if (!result.ok) {
      logError("Failed to reset keybinding override", undefined, { error: result.error });
      setShortcutError({ kind: "reset", rowId, actionId });
      return;
    }
    setShortcutError(null);
    // The reset button goes away with the override; keep focus on the row.
    setFocusRowId(rowId);
    loadBindings();
  };

  const handleImportComplete = () => {
    bindingsEpochRef.current++;
    setShortcutError(null);
    setEditingRowId(null);
    loadBindings();
  };

  const handleOpenResetDialog = () => {
    setEditingRowId(null);
    setShortcutError(null);
    setIsResetDialogOpen(true);
  };

  const handleConfirmReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    // Clear first so a second failure remounts the banner and is announced again.
    setShortcutError(null);
    try {
      const result = await actionService.dispatch("keybinding.resetAll", undefined, {
        source: "user",
        confirmed: true,
      });
      if (!result.ok) {
        logError("Failed to reset all keybinding overrides", undefined, { error: result.error });
        // Stay open: the dialog's own "Reset shortcuts" button is the retry.
        setShortcutError({ kind: "reset-all" });
        return;
      }
      await keybindingService.loadOverrides();
      loadBindings();
      setIsResetDialogOpen(false);
    } finally {
      setIsResetting(false);
    }
  };

  const handleCancelReset = () => {
    if (isResetting) return;
    setShortcutError(null);
    setIsResetDialogOpen(false);
  };

  const handleRetryRow = (error: RowError) => {
    if (error.kind === "save") {
      void handleSaveShortcut(error.rowId, error.actionId, error.combo);
      return;
    }
    void handleResetShortcut(error.rowId, error.actionId);
  };

  const overrideCount = bindings.filter((b) => b.isOverridden).length;
  const hasOverrides = overrideCount > 0;
  const resultCount = filteredBindings.length + filteredFixed.length;
  const isFiltered = query !== "" || filterMode !== "all";

  const handleFocusRestored = useCallback(() => setFocusRowId(null), []);

  return (
    <div className="space-y-8">
      <div className="grid gap-6">
        <div className="flex items-center gap-3">
          <SettingsSearchField
            ref={searchRef}
            value={searchQuery}
            onChange={setSearchQuery}
            label="Search shortcuts"
            placeholder="Search by action, key or category"
          />
          <SegmentedRadioGroup
            aria-label="Filter shortcuts"
            options={FILTER_MODES}
            value={filterMode}
            onChange={setFilterMode}
          />
        </div>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {`${resultCount} ${resultCount === 1 ? "shortcut" : "shortcuts"}${isFiltered ? "" : " in total"}`}
        </p>

        {Array.from(groupedBindings.entries()).map(([category, categoryBindings]) => (
          <SettingsGroup key={category} label={category}>
            {categoryBindings.map((binding) => {
              const rowError =
                shortcutError !== null &&
                shortcutError.kind !== "reset-all" &&
                shortcutError.rowId === binding.rowId
                  ? shortcutError
                  : null;
              return (
                <ShortcutRow
                  key={binding.rowId}
                  binding={binding}
                  isEditing={editingRowId === binding.rowId}
                  restoreFocus={focusRowId === binding.rowId}
                  error={rowError}
                  onEdit={() => {
                    setShortcutError(null);
                    setEditingRowId(binding.rowId);
                  }}
                  onSave={(combo) => handleSaveShortcut(binding.rowId, binding.actionId, combo)}
                  onCancel={() => {
                    setShortcutError(null);
                    closeEditor(binding.rowId);
                  }}
                  onReset={() => handleResetShortcut(binding.rowId, binding.actionId)}
                  onRetry={() => rowError && handleRetryRow(rowError)}
                  onDismissError={() => setShortcutError(null)}
                  onFocusRestored={handleFocusRestored}
                />
              );
            })}
          </SettingsGroup>
        ))}

        {resultCount === 0 && (
          <SettingsGroup>
            <SettingsEmptyRow
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearchQuery("");
                    setFilterMode("all");
                    searchRef.current?.focus();
                  }}
                >
                  {query ? "Clear search" : "Show all"}
                </Button>
              }
            >
              {query
                ? `No shortcuts match \u201c${searchQuery.trim()}\u201d${filterMode === "modified" ? " among modified ones" : ""}`
                : "No shortcuts are customized yet. Edit one to change its keys"}
            </SettingsEmptyRow>
          </SettingsGroup>
        )}
      </div>

      {filteredFixed.length > 0 && (
        <SettingsSection
          title="Fixed shortcuts"
          description="Built into the worktree list and drag handles, so they can't be rebound"
        >
          <SettingsGroup>
            {filteredFixed.map((fixed) => (
              <SettingsRow
                key={fixed.label}
                className="py-2"
                label={fixed.label}
                description={fixed.description}
                control={
                  <span className="inline-flex items-center gap-2 px-2">
                    {fixed.keys.map((key, index) => (
                      <span key={key} className="inline-flex items-center gap-2">
                        {index > 0 && (
                          <span className="text-3xs text-text-secondary" aria-hidden="true">
                            /
                          </span>
                        )}
                        <KbdChord shortcut={key} density="bare" className="text-text-primary" />
                      </span>
                    ))}
                  </span>
                }
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection title="Backup and reset">
        <SettingsGroup>
          <SettingsRow
            label="Shortcut profile"
            description="Save your customized shortcuts to a file, or load one exported on another machine. Importing replaces every customization."
            control={<KeybindingProfileActions onImportComplete={handleImportComplete} />}
          />
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow
            label="Reset all shortcuts"
            description={
              hasOverrides
                ? `Puts ${overrideCount} customized ${overrideCount === 1 ? "shortcut" : "shortcuts"} back to ${overrideCount === 1 ? "its default" : "their defaults"}`
                : "Every shortcut is on its default"
            }
            control={
              <Button
                type="button"
                variant="ghost-danger"
                size="sm"
                onClick={handleOpenResetDialog}
                disabled={isResetting || !hasOverrides}
              >
                Reset all
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <ConfirmDialog
        isOpen={isResetDialogOpen}
        onClose={isResetting ? undefined : handleCancelReset}
        title="Reset keyboard shortcuts?"
        description={`${overrideCount} customized ${overrideCount === 1 ? "shortcut goes" : "shortcuts go"} back to ${overrideCount === 1 ? "its default" : "their defaults"}. This can't be undone, but you can export a profile first.`}
        confirmLabel="Reset shortcuts"
        cancelLabel="Cancel"
        onConfirm={handleConfirmReset}
        isConfirmLoading={isResetting}
        variant="destructive"
      >
        {shortcutError?.kind === "reset-all" && (
          <InlineStatusBanner
            className="rounded-[var(--radius-md)]"
            severity="error"
            icon={AlertCircle}
            title="Couldn't reset shortcuts"
            description="Your customized shortcuts are still in place. Reset shortcuts to try again."
          />
        )}
      </ConfirmDialog>
    </div>
  );
}
