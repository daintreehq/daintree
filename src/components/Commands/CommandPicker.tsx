import { useState, useMemo, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { Loader2 } from "lucide-react";
import type { CommandManifestEntry, CommandCategory } from "@shared/types/commands";

interface CommandPickerProps {
  isOpen: boolean;
  commands: CommandManifestEntry[];
  isLoading?: boolean;
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
  isLoading = false,
  onSelect,
  onDismiss,
  filter,
}: CommandPickerProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

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

  // Build a set of command IDs that start a new category group
  const categoryStarts = useMemo(() => {
    const starts = new Map<string, CommandCategory>();
    for (const group of groupedCommands) {
      if (group.commands.length > 0) {
        starts.set(group.commands[0].id, group.category);
      }
    }
    return starts;
  }, [groupedCommands]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelectPrevious = useCallback(() => {
    setSelectedIndex((prev) => {
      if (flatCommands.length === 0) return 0;
      let next = (prev - 1 + flatCommands.length) % flatCommands.length;
      while (!flatCommands[next].enabled && next !== prev) {
        next = (next - 1 + flatCommands.length) % flatCommands.length;
      }
      return next;
    });
  }, [flatCommands]);

  const handleSelectNext = useCallback(() => {
    setSelectedIndex((prev) => {
      if (flatCommands.length === 0) return 0;
      let next = (prev + 1) % flatCommands.length;
      while (!flatCommands[next].enabled && next !== prev) {
        next = (next + 1) % flatCommands.length;
      }
      return next;
    });
  }, [flatCommands]);

  const handleConfirm = useCallback(() => {
    if (flatCommands[selectedIndex]?.enabled) {
      onSelect(flatCommands[selectedIndex]);
    }
  }, [flatCommands, selectedIndex, onSelect]);

  if (isLoading) {
    return (
      <SearchablePalette<CommandManifestEntry>
        isOpen={isOpen}
        query={query}
        results={[]}
        selectedIndex={0}
        onQueryChange={setQuery}
        onSelectPrevious={handleSelectPrevious}
        onSelectNext={handleSelectNext}
        onConfirm={handleConfirm}
        onClose={onDismiss}
        getItemId={(cmd) => cmd.id}
        renderItem={() => null}
        label="Commands"
        keyHint="⌘K"
        ariaLabel="Command picker"
        searchPlaceholder="Search commands..."
        searchAriaLabel="Search commands"
        listId="command-list"
        itemIdPrefix="command"
        renderBody={() => (
          <div className="flex flex-col items-center justify-center py-8 space-y-2">
            <Loader2 className="h-6 w-6 animate-spin text-canopy-text/40" />
            <p className="text-sm text-canopy-text/50">Loading commands...</p>
          </div>
        )}
      />
    );
  }

  return (
    <SearchablePalette<CommandManifestEntry>
      isOpen={isOpen}
      query={query}
      results={flatCommands}
      selectedIndex={selectedIndex}
      onQueryChange={setQuery}
      onSelectPrevious={handleSelectPrevious}
      onSelectNext={handleSelectNext}
      onConfirm={handleConfirm}
      onClose={onDismiss}
      getItemId={(cmd) => cmd.id}
      renderItem={(cmd, index, isSelected) => {
        const category = categoryStarts.get(cmd.id);
        return (
          <div key={cmd.id}>
            {category && (
              <div
                className={cn(
                  "px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-canopy-text/40",
                  index > 0 && "mt-2"
                )}
              >
                {CATEGORY_LABELS[category]}
              </div>
            )}
            <button
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
              <div className="text-xs text-canopy-text/50 line-clamp-1">{cmd.description}</div>
              {!cmd.enabled && cmd.disabledReason && (
                <div className="text-[10px] text-canopy-text/40 italic">{cmd.disabledReason}</div>
              )}
            </button>
          </div>
        );
      }}
      label="Commands"
      keyHint="⌘K"
      ariaLabel="Command picker"
      searchPlaceholder="Search commands..."
      searchAriaLabel="Search commands"
      listId="command-list"
      itemIdPrefix="command"
      emptyMessage="No commands available"
      noMatchMessage={`No commands match "${query}"`}
    />
  );
}
