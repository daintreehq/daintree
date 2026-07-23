import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Search, X, RotateCcw, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { keybindingService, type RegisteredKeybindingConfig } from "@/services/KeybindingService";
import { formatShortcutForTooltip } from "@/lib/platform";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeybindingProfileActions } from "./KeybindingProfileActions";
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
  error: RowError | null;
  onEdit: () => void;
  onSave: (combo: string) => void;
  onCancel: () => void;
  onReset: () => void;
  onRetry: () => void;
  onDismissError: () => void;
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
      className="mt-2 rounded-[var(--radius-md)]"
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
  error,
  onEdit,
  onSave,
  onCancel,
  onReset,
  onRetry,
  onDismissError,
}: ShortcutRowProps) {
  const handleCapture = (combo: string) => {
    onSave(combo);
  };

  if (isEditing) {
    return (
      <div data-testid="shortcut-row" className="py-2 border-b border-daintree-border/50">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-daintree-text">
            {binding.description || binding.actionId}
          </span>
        </div>
        <SettingsShortcutCapture
          onCapture={handleCapture}
          onCancel={onCancel}
          excludeActionId={binding.actionId}
          scope={binding.scope}
        />
        {error && (
          <ShortcutRowError error={error} onRetry={onRetry} onDismissError={onDismissError} />
        )}
      </div>
    );
  }

  return (
    <div data-testid="shortcut-row" className="py-2 border-b border-daintree-border/50">
      <div className="flex items-center justify-between group/row">
        <span className="text-sm text-daintree-text">
          {binding.description || binding.actionId}
        </span>
        <div className="flex items-center gap-2">
          {binding.effectiveCombo ? (
            <span
              className={cn(
                "px-2 py-0.5 text-xs font-mono rounded",
                binding.isOverridden
                  ? "bg-status-info/15 text-status-info"
                  : "bg-daintree-border text-daintree-text"
              )}
            >
              {keybindingService.formatComboForDisplay(binding.effectiveCombo)}
            </span>
          ) : (
            <span className="text-xs text-daintree-text/60 italic">unbound</span>
          )}
          <button
            onClick={onEdit}
            className="px-2 py-0.5 text-xs text-daintree-text/60 hover:text-daintree-text opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 transition-opacity"
          >
            Edit
          </button>
          {binding.isOverridden && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReset}
                  className="p-0.5 text-daintree-text/60 hover:text-daintree-text opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 transition-opacity"
                  aria-label="Reset to default"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reset to default</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {error && (
        <ShortcutRowError error={error} onRetry={onRetry} onDismissError={onDismissError} />
      )}
    </div>
  );
}

export function KeyboardShortcutsTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
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

  const filteredBindings = useMemo(() => {
    if (!searchQuery.trim()) return bindings;

    const query = searchQuery.toLowerCase();
    return bindings.filter(
      (b) =>
        (b.description?.toLowerCase().includes(query) ?? false) ||
        b.actionId.toLowerCase().includes(query) ||
        b.effectiveCombo.toLowerCase().includes(query) ||
        (b.category?.toLowerCase().includes(query) ?? false)
    );
  }, [bindings, searchQuery]);

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
    setEditingRowId(null);
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

  const handleCancelEdit = () => {
    setShortcutError(null);
    setEditingRowId(null);
  };

  const handleRetryRow = (error: RowError) => {
    if (error.kind === "save") {
      void handleSaveShortcut(error.rowId, error.actionId, error.combo);
      return;
    }
    void handleResetShortcut(error.rowId, error.actionId);
  };

  const hasOverrides = bindings.some((b) => b.isOverridden);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (searchQuery !== "") {
        e.stopPropagation();
        setSearchQuery("");
      } else {
        searchInputRef.current?.blur();
      }
    }
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex items-center gap-1.5 px-2 py-1.5 flex-1 min-w-0 rounded-[var(--radius-md)]",
            "bg-daintree-bg border border-border-strong",
            "focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20"
          )}
        >
          <Search
            className="w-3.5 h-3.5 shrink-0 text-daintree-text/40 pointer-events-none"
            aria-hidden="true"
          />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search shortcuts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-label="Search shortcuts"
            className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-placeholder focus:outline-hidden"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={handleClearSearch}
              aria-label="Clear search"
              className="flex items-center justify-center w-5 h-5 rounded shrink-0 text-daintree-text/40 hover:text-daintree-text"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <KeybindingProfileActions onImportComplete={handleImportComplete} />
        <button
          onClick={handleOpenResetDialog}
          disabled={isResetting}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 text-sm border border-daintree-border rounded transition-colors",
            isResetting
              ? "opacity-50 cursor-not-allowed text-daintree-text/40"
              : hasOverrides
                ? "text-daintree-text/60 hover:text-daintree-text hover:border-daintree-accent"
                : "text-daintree-text/40 hover:text-daintree-text/60 hover:border-daintree-border"
          )}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset all
        </button>
      </div>

      <div className="space-y-4">
        {Array.from(groupedBindings.entries()).map(([category, categoryBindings]) => (
          <div key={category}>
            <h4 className="text-xs font-semibold text-daintree-text/60 uppercase tracking-wider mb-2">
              {category}
            </h4>
            <div className="space-y-0">
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
                    error={rowError}
                    onEdit={() => {
                      setShortcutError(null);
                      setEditingRowId(binding.rowId);
                    }}
                    onSave={(combo) => handleSaveShortcut(binding.rowId, binding.actionId, combo)}
                    onCancel={handleCancelEdit}
                    onReset={() => handleResetShortcut(binding.rowId, binding.actionId)}
                    onRetry={() => rowError && handleRetryRow(rowError)}
                    onDismissError={() => setShortcutError(null)}
                  />
                );
              })}
            </div>
          </div>
        ))}

        {filteredBindings.length === 0 && (
          <div className="text-center py-8 text-daintree-text/60">
            No shortcuts found matching "{searchQuery}"
          </div>
        )}

        {/* Worktree-list navigation lives in useWorktreeSidebarKeyboard's
            roving-focus model, not the keybinding engine — document the keys
            honestly as fixed instead of advertising rebindable rows that
            never fire. */}
        <div data-testid="worktree-list-keys-help">
          <h4 className="text-xs font-semibold text-daintree-text/60 uppercase tracking-wider mb-2">
            Worktree list
          </h4>
          <div className="space-y-0">
            <div className="flex items-center justify-between gap-4 py-2 border-b border-daintree-border/50">
              <span className="text-sm text-daintree-text shrink-0">Move selection</span>
              <span className="text-xs text-daintree-text/60 text-right">
                Arrow keys or j / k; PageUp / PageDown and Home / End jump further
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-daintree-border/50">
              <span className="text-sm text-daintree-text shrink-0">Open worktree</span>
              <span className="text-xs text-daintree-text/60 text-right">
                Space or Enter; Enter or ArrowRight moves into the row's actions
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-daintree-border/50">
              <span className="text-sm text-daintree-text shrink-0">Reorder worktree</span>
              <span className="text-xs text-daintree-text/60 text-right">Alt+Up / Alt+Down</span>
            </div>
          </div>
          <p className="text-xs text-daintree-text/40 mt-2">
            These shortcuts are fixed and can't be rebound
          </p>
        </div>

        {/* Keyboard drag-and-drop is otherwise only discoverable through
            screen-reader ARIA hints; surface it for sighted keyboard users.
            Static — dnd-kit sensor interactions, not rebindable actions. */}
        <div data-testid="list-reordering-help">
          <h4 className="text-xs font-semibold text-daintree-text/60 uppercase tracking-wider mb-2">
            List reordering
          </h4>
          <div className="space-y-0">
            <div className="flex items-center justify-between gap-4 py-2 border-b border-daintree-border/50">
              <span className="text-sm text-daintree-text shrink-0">Reorder panel</span>
              <span className="text-xs text-daintree-text/60 text-right">
                Focus the panel header, then Space to pick up, arrows to move, Space to drop, Esc to
                cancel
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-daintree-border/50">
              <span className="text-sm text-daintree-text shrink-0">Reorder tab</span>
              <span className="text-xs text-daintree-text/60 text-right">
                Focus the active tab, then Space to pick up, arrows to move, Space to drop
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-daintree-border/50">
              <span className="text-sm text-daintree-text shrink-0">Reorder worktree</span>
              <span className="text-xs text-daintree-text/60 text-right">
                {formatShortcutForTooltip("Alt+Up")} / {formatShortcutForTooltip("Alt+Down")} in the
                sidebar
              </span>
            </div>
          </div>
          <p className="text-xs text-daintree-text/40 mt-2">
            These shortcuts are fixed and can't be rebound
          </p>
        </div>
      </div>

      <ConfirmDialog
        isOpen={isResetDialogOpen}
        onClose={isResetting ? undefined : handleCancelReset}
        title="Reset keyboard shortcuts?"
        description={
          hasOverrides
            ? "All keyboard shortcuts will be reset to their default values. Any customized shortcuts will be removed."
            : "There are no customized shortcuts to reset. All shortcuts are already at their default values."
        }
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
