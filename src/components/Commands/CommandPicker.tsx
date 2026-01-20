import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import type { CommandManifestEntry, CommandCategory } from "@shared/types/commands";
import { Search } from "lucide-react";

interface CommandPickerProps {
  isOpen: boolean;
  commands: CommandManifestEntry[];
  onSelect: (command: CommandManifestEntry) => void;
  onDismiss: () => void;
  filter?: CommandCategory[];
}

const CATEGORY_ORDER: CommandCategory[] = ["github", "git", "workflow", "project", "system"];

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  github: "GitHub",
  git: "Git",
  workflow: "Workflow",
  project: "Project",
  system: "System",
};

function fuzzyMatch(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerText.includes(lowerQuery)) return true;

  let queryIndex = 0;
  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      queryIndex++;
    }
  }
  return queryIndex === lowerQuery.length;
}

export function CommandPicker({
  isOpen,
  commands,
  onSelect,
  onDismiss,
  filter,
}: CommandPickerProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredCommands = useMemo(() => {
    let result = commands;

    if (filter && filter.length > 0) {
      result = result.filter((cmd) => filter.includes(cmd.category));
    }

    if (query.trim()) {
      result = result.filter((cmd) => {
        const searchText = `${cmd.id} ${cmd.label} ${cmd.description} ${cmd.keywords?.join(" ") ?? ""}`;
        return fuzzyMatch(searchText, query.trim());
      });
    }

    return result;
  }, [commands, filter, query]);

  const groupedCommands = useMemo(() => {
    const groups = new Map<CommandCategory, CommandManifestEntry[]>();

    for (const cmd of filteredCommands) {
      const existing = groups.get(cmd.category) ?? [];
      existing.push(cmd);
      groups.set(cmd.category, existing);
    }

    const orderedGroups: Array<{ category: CommandCategory; commands: CommandManifestEntry[] }> =
      [];
    for (const category of CATEGORY_ORDER) {
      const cmds = groups.get(category);
      if (cmds && cmds.length > 0) {
        orderedGroups.push({ category, commands: cmds });
      }
    }

    return orderedGroups;
  }, [filteredCommands]);

  const flatCommands = useMemo(() => {
    return groupedCommands.flatMap((g) => g.commands);
  }, [groupedCommands]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && selectedIndex < flatCommands.length) {
      const selectedId = flatCommands[selectedIndex].id;
      const element = listRef.current.querySelector(`[data-command-id="${selectedId}"]`);
      element?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, flatCommands]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => {
            if (flatCommands.length === 0) return 0;
            let next = (prev - 1 + flatCommands.length) % flatCommands.length;
            while (!flatCommands[next].enabled && next !== prev) {
              next = (next - 1 + flatCommands.length) % flatCommands.length;
            }
            return next;
          });
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => {
            if (flatCommands.length === 0) return 0;
            let next = (prev + 1) % flatCommands.length;
            while (!flatCommands[next].enabled && next !== prev) {
              next = (next + 1) % flatCommands.length;
            }
            return next;
          });
          break;
        case "Enter":
          e.preventDefault();
          if (flatCommands[selectedIndex]?.enabled) {
            onSelect(flatCommands[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onDismiss();
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey) {
            setSelectedIndex((prev) => {
              if (flatCommands.length === 0) return 0;
              return (prev - 1 + flatCommands.length) % flatCommands.length;
            });
          } else {
            setSelectedIndex((prev) => {
              if (flatCommands.length === 0) return 0;
              return (prev + 1) % flatCommands.length;
            });
          }
          break;
      }
    },
    [flatCommands, selectedIndex, onSelect, onDismiss]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onDismiss} ariaLabel="Command picker">
      <AppPaletteDialog.Header label="Commands" keyHint="⌘K">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-canopy-text/40" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              "w-full pl-9 pr-3 py-2 text-sm",
              "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)]",
              "text-canopy-text placeholder:text-canopy-text/40",
              "focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent"
            )}
            placeholder="Search commands..."
            aria-label="Search commands"
            aria-controls="command-list"
            aria-activedescendant={
              flatCommands[selectedIndex] ? `command-${flatCommands[selectedIndex].id}` : undefined
            }
          />
        </div>
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div ref={listRef} id="command-list" role="listbox" aria-label="Commands">
          {groupedCommands.length === 0 ? (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No commands available"
              noMatchMessage={`No commands match "${query}"`}
            />
          ) : (
            groupedCommands.map(({ category, commands: cmds }) => (
              <div key={category} className="mb-2">
                <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-canopy-text/40">
                  {CATEGORY_LABELS[category]}
                </div>
                {cmds.map((cmd) => {
                  const globalIndex = flatCommands.indexOf(cmd);
                  const isSelected = globalIndex === selectedIndex;

                  return (
                    <button
                      key={cmd.id}
                      id={`command-${cmd.id}`}
                      data-command-id={cmd.id}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={!cmd.enabled}
                      disabled={!cmd.enabled}
                      className={cn(
                        "relative w-full flex flex-col gap-0.5 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
                        isSelected
                          ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
                          : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text",
                        !cmd.enabled && "opacity-50 cursor-not-allowed"
                      )}
                      onClick={() => cmd.enabled && onSelect(cmd)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm text-canopy-text/90">/{cmd.id}</span>
                        {cmd.hasBuilder && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-canopy-accent/20 text-canopy-accent">
                            Builder
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-canopy-text/50 line-clamp-1">
                        {cmd.description}
                      </div>
                      {!cmd.enabled && cmd.disabledReason && (
                        <div className="text-[10px] text-canopy-text/40 italic">
                          {cmd.disabledReason}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer />
    </AppPaletteDialog>
  );
}
