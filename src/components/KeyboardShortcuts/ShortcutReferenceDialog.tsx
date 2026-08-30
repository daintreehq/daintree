import { useState, useMemo, useEffect, useRef, useId } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { AppDialog } from "@/components/ui/AppDialog";
import { useOverlayState } from "@/hooks";
import { Kbd, KbdChord } from "@/components/ui/Kbd";
import { MODIFIER_SEARCH_MAP, isChordPrefix, normalizeQuery } from "@/lib/kbdShortcut";
import { keybindingService } from "../../services/KeybindingService";
import type { RegisteredKeybindingConfig } from "../../services/KeybindingService";

const CATEGORY_ORDER = [
  "Terminal",
  "Agents",
  "Worktrees",
  "Panels",
  "Navigation",
  "Help",
  "System",
  "Other",
] as const;

interface ShortcutReferenceDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutSearchItem extends RegisteredKeybindingConfig {
  effectiveCombo: string;
  displayCombo: string;
  normalizedCombo: string;
  keywords?: string[];
}

export function ShortcutReferenceDialog({ isOpen, onClose }: ShortcutReferenceDialogProps) {
  useOverlayState(isOpen);
  const [searchQuery, setSearchQuery] = useState("");
  const [bindingsVersion, setBindingsVersion] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const headingPrefix = useId();

  useEffect(() => {
    const unsubscribe = keybindingService.subscribe(() => {
      setBindingsVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const allBindings = useMemo(() => {
    void bindingsVersion;
    return keybindingService.getAllBindingsWithEffectiveCombos();
  }, [bindingsVersion]);

  const searchItems = useMemo<ShortcutSearchItem[]>(() => {
    return allBindings.map((binding) => {
      const displayCombo = keybindingService.getDisplayCombo(binding.actionId);
      let normalizedCombo = displayCombo.toLowerCase().replace(/[\s+]+/g, "");
      for (const [symbol, text] of Object.entries(MODIFIER_SEARCH_MAP)) {
        normalizedCombo = normalizedCombo.replace(new RegExp(symbol, "g"), text);
      }
      return {
        ...binding,
        effectiveCombo: binding.effectiveCombo,
        displayCombo,
        normalizedCombo,
        keywords: binding.effectiveCombo ? [] : ["unbound"],
      };
    });
  }, [allBindings]);

  const fuseOptions: IFuseOptions<ShortcutSearchItem> = useMemo(
    () => ({
      keys: [
        { name: "description", weight: 2.0 },
        { name: "keywords", weight: 1.5 },
        { name: "actionId", weight: 1.0 },
        { name: "category", weight: 0.5 },
        { name: "normalizedCombo", weight: 0.3 },
      ],
      threshold: 0.4,
      includeScore: true,
      ignoreLocation: true,
    }),
    []
  );

  const fuse = useMemo(() => new Fuse(searchItems, fuseOptions), [searchItems, fuseOptions]);

  const filteredBindings = useMemo(() => {
    if (!searchQuery.trim()) {
      return searchItems;
    }

    const normalizedQuery = normalizeQuery(searchQuery);

    if (isChordPrefix(searchQuery)) {
      const queryPrefix = normalizedQuery.replace(/\+/g, "");
      return searchItems.filter((item) => {
        return item.normalizedCombo.startsWith(queryPrefix);
      });
    }

    const results = fuse.search(normalizedQuery);
    return results.map((result) => result.item);
  }, [searchItems, fuse, searchQuery]);

  const groupedBindings = useMemo(() => {
    const groups: Record<string, ShortcutSearchItem[]> = {};

    filteredBindings.forEach((binding) => {
      const category = binding.category || "Other";
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(binding);
    });

    return groups;
  }, [filteredBindings]);

  const sortedCategories = useMemo(() => {
    const categories = Object.keys(groupedBindings);
    return categories.sort((a, b) => {
      const aIndex = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number]);
      const bIndex = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number]);
      if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });
  }, [groupedBindings]);

  useEffect(() => {
    if (isOpen) {
      searchInputRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg">
      <AppDialog.Header className="flex-col items-stretch gap-4">
        <div className="flex items-center justify-between">
          <AppDialog.Title>Keyboard shortcuts</AppDialog.Title>
          <AppDialog.CloseButton />
        </div>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search shortcuts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Search shortcuts"
          aria-controls={resultsId}
          className="w-full px-4 py-2 bg-surface-canvas border border-border-default rounded-[var(--radius-md)] text-text-primary placeholder:text-text-placeholder focus:outline-hidden focus:ring-2 focus:ring-daintree-accent/30"
        />
      </AppDialog.Header>

      <AppDialog.Body>
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {searchQuery.trim()
            ? `${filteredBindings.length} shortcut${filteredBindings.length !== 1 ? "s" : ""} found for "${searchQuery.trim()}"`
            : `${filteredBindings.length} shortcut${filteredBindings.length !== 1 ? "s" : ""}`}
        </div>

        {sortedCategories.length === 0 ? (
          <div
            id={resultsId}
            role="status"
            aria-live="polite"
            className="text-center text-text-secondary py-8"
          >
            No shortcuts found matching "{searchQuery}"
          </div>
        ) : (
          <div id={resultsId} className="space-y-8">
            {sortedCategories.map((category) => {
              const headingId = `${headingPrefix}-${category
                .replace(/[^a-zA-Z0-9]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "")}`;
              return (
                <div key={category}>
                  <h3
                    id={headingId}
                    className="text-lg font-semibold text-text-primary mb-3 pb-2 border-b border-border-default"
                  >
                    {category}
                  </h3>
                  <div role="list" aria-labelledby={headingId} className="space-y-2">
                    {groupedBindings[category]!.map((binding) => (
                      <div
                        key={binding.actionId}
                        role="listitem"
                        className="flex items-center justify-between py-2 px-3 rounded hover:bg-daintree-border/50"
                      >
                        <div className="flex-1">
                          <div className="text-text-primary font-medium">{binding.description}</div>
                          {binding.scope !== "global" && (
                            <div className="text-xs text-text-secondary mt-1">
                              Scope: {binding.scope}
                            </div>
                          )}
                        </div>
                        <div className="ml-4">
                          {binding.effectiveCombo ? (
                            <KbdChord
                              shortcut={binding.effectiveCombo}
                              aria-label={binding.displayCombo}
                            />
                          ) : (
                            <span className="text-xs text-text-secondary italic">unbound</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer className="justify-center">
        <div className="text-sm text-text-secondary">
          Press <Kbd>Esc</Kbd> to close
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
