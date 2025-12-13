import { useState, useMemo, useEffect, useRef } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { useOverlayState } from "@/hooks";
import { keybindingService } from "../../services/KeybindingService";
import type { KeybindingConfig } from "../../services/KeybindingService";

interface ShortcutReferenceDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutReferenceDialog({ isOpen, onClose }: ShortcutReferenceDialogProps) {
  useOverlayState(isOpen);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const allBindings = useMemo(() => keybindingService.getAllBindings(), []);

  const groupedBindings = useMemo(() => {
    const groups: Record<string, KeybindingConfig[]> = {};

    allBindings.forEach((binding) => {
      const category = binding.category || "Other";
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(binding);
    });

    return groups;
  }, [allBindings]);

  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedBindings;

    const query = searchQuery.toLowerCase();
    const filtered: Record<string, KeybindingConfig[]> = {};

    Object.entries(groupedBindings).forEach(([category, bindings]) => {
      const matchingBindings = bindings.filter((binding) => {
        const displayCombo = keybindingService.getDisplayCombo(binding.actionId).toLowerCase();
        return (
          binding.description?.toLowerCase().includes(query) ||
          binding.actionId.toLowerCase().includes(query) ||
          binding.combo.toLowerCase().includes(query) ||
          displayCombo.includes(query)
        );
      });

      if (matchingBindings.length > 0) {
        filtered[category] = matchingBindings;
      }
    });

    return filtered;
  }, [groupedBindings, searchQuery]);

  const categoryOrder = [
    "Terminal",
    "Agents",
    "Worktrees",
    "Panels",
    "Navigation",
    "Help",
    "System",
    "Other",
  ];

  const sortedCategories = useMemo(() => {
    const categories = Object.keys(filteredGroups);
    return categories.sort((a, b) => {
      const aIndex = categoryOrder.indexOf(a);
      const bIndex = categoryOrder.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
  }, [filteredGroups]);

  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg">
      <AppDialog.Header className="flex-col items-stretch gap-4">
        <div className="flex items-center justify-between">
          <AppDialog.Title className="text-2xl">Keyboard Shortcuts</AppDialog.Title>
          <AppDialog.CloseButton />
        </div>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text placeholder-canopy-text/40 focus:outline-none focus:ring-2 focus:ring-canopy-accent"
        />
      </AppDialog.Header>

      <AppDialog.Body>
        {sortedCategories.length === 0 ? (
          <div className="text-center text-canopy-text/60 py-8">
            No shortcuts found matching "{searchQuery}"
          </div>
        ) : (
          <div className="space-y-8">
            {sortedCategories.map((category) => (
              <div key={category}>
                <h3 className="text-lg font-semibold text-canopy-text mb-3 pb-2 border-b border-canopy-border">
                  {category}
                </h3>
                <div className="space-y-2">
                  {filteredGroups[category].map((binding) => (
                    <div
                      key={binding.actionId}
                      className="flex items-center justify-between py-2 px-3 rounded hover:bg-canopy-border/50"
                    >
                      <div className="flex-1">
                        <div className="text-canopy-text font-medium">{binding.description}</div>
                        {binding.scope !== "global" && (
                          <div className="text-xs text-canopy-text/60 mt-1">
                            Scope: {binding.scope}
                          </div>
                        )}
                      </div>
                      <div className="ml-4">
                        <kbd className="px-3 py-1.5 bg-canopy-bg border border-canopy-border rounded text-sm font-mono text-canopy-text shadow-sm">
                          {keybindingService.getDisplayCombo(binding.actionId)}
                        </kbd>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer className="justify-center bg-canopy-bg/50">
        <div className="text-sm text-canopy-text/60">
          Press <kbd className="px-2 py-1 bg-canopy-border rounded text-xs">Esc</kbd> to close
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
