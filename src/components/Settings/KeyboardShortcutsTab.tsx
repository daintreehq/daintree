import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, X, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { keybindingService, KeybindingConfig } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeybindingProfileActions } from "./KeybindingProfileActions";
import { SettingsShortcutCapture } from "@/components/KeyboardShortcuts";

interface ShortcutBinding extends KeybindingConfig {
  effectiveCombo: string;
  isOverridden: boolean;
}

interface ShortcutRowProps {
  binding: ShortcutBinding;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (combo: string) => void;
  onCancel: () => void;
  onReset: () => void;
}

function ShortcutRow({ binding, isEditing, onEdit, onSave, onCancel, onReset }: ShortcutRowProps) {
  const handleCapture = (combo: string) => {
    onSave(combo);
  };

  if (isEditing) {
    return (
      <div className="py-2 border-b border-daintree-border/50">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-daintree-text">
            {binding.description || binding.actionId}
          </span>
        </div>
        <SettingsShortcutCapture
          onCapture={handleCapture}
          onCancel={onCancel}
          excludeActionId={binding.actionId}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-daintree-border/50 group">
      <span className="text-sm text-daintree-text">{binding.description || binding.actionId}</span>
      <div className="flex items-center gap-2">
        {binding.effectiveCombo ? (
          <span
            className={cn(
              "px-2 py-0.5 text-xs font-mono rounded",
              binding.isOverridden
                ? "bg-daintree-accent/20 text-daintree-accent"
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
          className="px-2 py-0.5 text-xs text-daintree-text/60 hover:text-daintree-text opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Edit
        </button>
        {binding.isOverridden && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onReset}
                className="p-0.5 text-daintree-text/60 hover:text-daintree-text opacity-0 group-hover:opacity-100 transition-opacity"
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
  );
}

export function KeyboardShortcutsTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [bindings, setBindings] = useState<ShortcutBinding[]>([]);
  const [, setUpdateKey] = useState(0);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const loadBindings = useCallback(() => {
    const allBindings = keybindingService.getAllBindingsWithEffectiveCombos();
    setBindings(
      allBindings.map((b) => ({
        ...b,
        isOverridden: keybindingService.hasOverride(b.actionId),
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

  const handleSaveShortcut = async (actionId: string, combo: string) => {
    const result = await actionService.dispatch(
      "keybinding.setOverride",
      { actionId, combo: combo === "" ? [] : [combo] },
      { source: "user" }
    );
    if (!result.ok) {
      console.error("Failed to save keybinding override:", result.error);
    }
    setEditingActionId(null);
    loadBindings();
  };

  const handleResetShortcut = async (actionId: string) => {
    const result = await actionService.dispatch(
      "keybinding.removeOverride",
      { actionId },
      { source: "user" }
    );
    if (!result.ok) {
      console.error("Failed to reset keybinding override:", result.error);
    }
    loadBindings();
  };

  const handleOpenResetDialog = () => {
    setEditingActionId(null);
    setIsResetDialogOpen(true);
  };

  const handleConfirmReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    try {
      const result = await actionService.dispatch("keybinding.resetAll", undefined, {
        source: "user",
        confirmed: true,
      });
      if (!result.ok) {
        console.error("Failed to reset all keybinding overrides:", result.error);
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
    setIsResetDialogOpen(false);
  };

  const hasOverrides = bindings.some((b) => b.isOverridden);

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (searchQuery !== "") {
          e.stopPropagation();
          setSearchQuery("");
        } else {
          searchInputRef.current?.blur();
        }
      }
    },
    [searchQuery]
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    searchInputRef.current?.focus();
  }, []);

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
            className="flex-1 min-w-0 text-xs bg-transparent text-daintree-text placeholder:text-text-muted focus:outline-none"
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
        <KeybindingProfileActions onImportComplete={loadBindings} />
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
          Reset All
        </button>
      </div>

      <div className="space-y-4">
        {Array.from(groupedBindings.entries()).map(([category, categoryBindings]) => (
          <div key={category}>
            <h4 className="text-xs font-semibold text-daintree-text/60 uppercase tracking-wider mb-2">
              {category}
            </h4>
            <div className="space-y-0">
              {categoryBindings.map((binding) => (
                <ShortcutRow
                  key={binding.actionId}
                  binding={binding}
                  isEditing={editingActionId === binding.actionId}
                  onEdit={() => setEditingActionId(binding.actionId)}
                  onSave={(combo) => handleSaveShortcut(binding.actionId, combo)}
                  onCancel={() => setEditingActionId(null)}
                  onReset={() => handleResetShortcut(binding.actionId)}
                />
              ))}
            </div>
          </div>
        ))}

        {filteredBindings.length === 0 && (
          <div className="text-center py-8 text-daintree-text/60">
            No shortcuts found matching "{searchQuery}"
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={isResetDialogOpen}
        onClose={isResetting ? undefined : handleCancelReset}
        title="Reset Keyboard Shortcuts?"
        description={
          hasOverrides
            ? "All keyboard shortcuts will be reset to their default values. Any customized shortcuts will be removed."
            : "There are no customized shortcuts to reset. All shortcuts are already at their default values."
        }
        confirmLabel="Reset to Defaults"
        cancelLabel="Cancel"
        onConfirm={handleConfirmReset}
        isConfirmLoading={isResetting}
        variant="destructive"
      />
    </div>
  );
}
