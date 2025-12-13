import { useState, useEffect, useMemo, useRef } from "react";
import {
  CornerDownLeft,
  LayoutGrid,
  PanelBottom,
  Terminal,
  Clock,
  ChevronRight,
  ChevronDown,
  Pin,
  PinOff,
} from "lucide-react";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import { cn } from "@/lib/utils";
import { detectTerminalTypeFromCommand } from "@/utils/terminalType";
import type { RunCommand } from "@/types";

interface QuickRunProps {
  projectId: string;
}

interface HistoryItem {
  command: string;
  timestamp: number;
}

type SuggestionItem =
  | {
      label: string;
      value: string;
      type: "saved";
      icon?: string;
      description?: string;
    }
  | {
      label: string;
      value: string;
      type: "script";
      icon?: string;
      description?: string;
    }
  | {
      label: string;
      value: string;
      type: "history";
    };

const HISTORY_KEY_PREFIX = "canopy_cmd_history_";
const MAX_HISTORY = 10;

/**
 * Normalize a command string for comparison.
 * Removes quotes around tokens that don't contain spaces.
 * e.g., `npm run "test"` -> `npm run test`
 * but keeps `npm run "test with spaces"` as is.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .trim()
    .replace(/\s+/g, " ")
    .replace(/"([^"\s]+)"/g, "$1")
    .replace(/'([^'\s]+)'/g, "$1");
}

export function QuickRun({ projectId }: QuickRunProps) {
  const { allDetectedRunners, settings, promoteToSaved, removeFromSaved } =
    useProjectSettings(projectId);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const { worktreeMap } = useWorktrees();

  const [isExpanded, setIsExpanded] = useState(true);
  const [input, setInput] = useState("");
  const [runAsDocked, setRunAsDocked] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [focusedSuggestionIndex, setFocusedSuggestionIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(`${HISTORY_KEY_PREFIX}${projectId}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (
          Array.isArray(parsed) &&
          parsed.every(
            (item) => typeof item === "object" && "command" in item && "timestamp" in item
          )
        ) {
          setHistory(parsed);
        } else {
          console.warn("Invalid history format, resetting");
          localStorage.removeItem(`${HISTORY_KEY_PREFIX}${projectId}`);
        }
      } catch (e) {
        console.error("Failed to parse command history", e);
        localStorage.removeItem(`${HISTORY_KEY_PREFIX}${projectId}`);
      }
    }
  }, [projectId]);

  const saveHistory = (cmd: string) => {
    setHistory((prev) => {
      const newItem = { command: cmd, timestamp: Date.now() };
      const normalizedNew = normalizeCommand(cmd);
      // Use normalized comparison to avoid duplicates with quote variations
      // but keep the original command value
      const newHistory = [
        newItem,
        ...prev.filter((h) => normalizeCommand(h.command) !== normalizedNew),
      ].slice(0, MAX_HISTORY);
      localStorage.setItem(`${HISTORY_KEY_PREFIX}${projectId}`, JSON.stringify(newHistory));
      return newHistory;
    });
  };

  const handlePin = async (e: React.MouseEvent, item: SuggestionItem) => {
    e.stopPropagation();
    e.preventDefault();

    const commandToSave: RunCommand = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: item.label,
      command: item.value,
      icon: "icon" in item ? item.icon || "terminal" : "terminal",
      description:
        "description" in item && item.description
          ? item.description
          : item.type === "script"
            ? "Pinned script"
            : "Pinned from history",
    };

    try {
      await promoteToSaved(commandToSave);
    } catch (err) {
      console.error("Failed to pin command:", err);
    }
  };

  const handleUnpin = async (e: React.MouseEvent, item: SuggestionItem) => {
    e.stopPropagation();
    e.preventDefault();

    try {
      await removeFromSaved(item.value);
    } catch (err) {
      console.error("Failed to unpin command:", err);
    }
  };

  const suggestions = useMemo((): SuggestionItem[] => {
    const search = input.toLowerCase().trim();
    const savedCommands = settings?.runCommands || [];

    // Use normalized commands for comparison to handle quote variations
    const savedNormalized = new Set(savedCommands.map((c) => normalizeCommand(c.command)));
    const detectedNormalized = new Set(allDetectedRunners.map((r) => normalizeCommand(r.command)));

    // Pinned commands that came from package.json - preserve package.json order
    const savedDetected: SuggestionItem[] = allDetectedRunners
      .filter((r) => savedNormalized.has(normalizeCommand(r.command)))
      .map((r) => {
        const saved = savedCommands.find(
          (s) => normalizeCommand(s.command) === normalizeCommand(r.command)
        );
        return {
          label: saved?.name || r.name,
          value: r.command, // Use detected command (clean, no quotes)
          type: "saved" as const,
          icon: saved?.icon || r.icon,
          description: saved?.description || r.description,
        };
      });

    // Custom pinned commands (user-typed, not from package.json) - appear after script pins
    const savedCustom: SuggestionItem[] = savedCommands
      .filter((cmd) => !detectedNormalized.has(normalizeCommand(cmd.command)))
      .map((cmd) => ({
        label: cmd.name,
        value: cmd.command, // Keep original command
        type: "saved" as const,
        icon: cmd.icon,
        description: cmd.description,
      }));

    const savedOptions = [...savedDetected, ...savedCustom];

    // Remaining detected scripts (not pinned) - filter from allDetectedRunners to preserve package.json order
    // This ensures unpinned commands return to their original position
    const scriptOptions: SuggestionItem[] = allDetectedRunners
      .filter((r) => !savedNormalized.has(normalizeCommand(r.command)))
      .map((r) => ({
        label: r.name,
        value: r.command,
        type: "script" as const,
        icon: r.icon,
        description: r.description,
      }));

    // History - most recent first, excluding saved and detected commands
    const seenNormalized = new Set([
      ...savedNormalized,
      ...allDetectedRunners.map((r) => normalizeCommand(r.command)),
    ]);
    const historyOptions: SuggestionItem[] = history
      .filter((h) => !seenNormalized.has(normalizeCommand(h.command)))
      .map((h) => ({
        label: h.command,
        value: h.command, // Keep original command
        type: "history" as const,
      }));

    const allOptions = [...savedOptions, ...scriptOptions, ...historyOptions];

    // Remove duplicates using normalized comparison (keep first occurrence)
    const seen = new Set<string>();
    const uniqueOptions = allOptions.filter((opt) => {
      const normalized = normalizeCommand(opt.value);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

    if (!search) return uniqueOptions;

    return uniqueOptions.filter(
      (opt) => opt.value.toLowerCase().includes(search) || opt.label.toLowerCase().includes(search)
    );
  }, [input, allDetectedRunners, history, settings]);

  const handleRun = async (cmd: string) => {
    if (!cmd.trim()) return;

    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
    const cwd = activeWorktree?.path;

    if (!cwd) return;

    saveHistory(cmd);
    setShowSuggestions(false);
    setInput("");
    setFocusedSuggestionIndex(-1);

    try {
      const terminalType = detectTerminalTypeFromCommand(cmd);
      await addTerminal({
        type: terminalType,
        title: cmd,
        cwd: cwd,
        command: cmd,
        location: runAsDocked ? "dock" : "grid",
        worktreeId: activeWorktreeId || undefined,
      });
    } catch (error) {
      console.error("Failed to spawn terminal:", error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (focusedSuggestionIndex >= 0 && suggestions[focusedSuggestionIndex]) {
        handleRun(suggestions[focusedSuggestionIndex].value);
      } else {
        handleRun(input);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedSuggestionIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedSuggestionIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setFocusedSuggestionIndex(-1);
      inputRef.current?.blur();
    }
  };

  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  const activeWorktreeName = activeWorktree?.name || "No active worktree";
  const isWorktreeValid = activeWorktree != null && activeWorktree.path != null;

  return (
    <div className="border-t border-canopy-border bg-canopy-sidebar shrink-0 flex flex-col min-h-0 text-xs">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-1.5",
          "text-canopy-text/40 hover:text-canopy-text hover:bg-white/5 transition-colors focus:outline-none font-sans"
        )}
        aria-expanded={isExpanded}
        aria-controls="quick-run-panel"
      >
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="opacity-50 font-medium shrink-0">Run on</span>
            <span
              className={cn(
                "truncate",
                isWorktreeValid ? "text-canopy-text" : "text-canopy-text/50"
              )}
            >
              {activeWorktreeName}
            </span>
          </span>
        </div>
      </button>

      {isExpanded && (
        <div id="quick-run-panel" className="px-3 pb-3 pt-1">
          {!isWorktreeValid ? (
            <div className="text-xs text-gray-500 text-center py-2">
              Select a worktree above to enable Quick Run
            </div>
          ) : (
            <div
              className={cn(
                "relative flex items-center bg-surface border border-canopy-border rounded-[var(--radius-md)]",
                "focus-within:border-canopy-accent/50 focus-within:ring-1 focus-within:ring-canopy-accent/20 transition-all"
              )}
            >
              {/* Prompt Symbol */}
              <div className="pl-3 pr-2 select-none text-green-500 font-mono font-bold">$</div>

              {/* Input */}
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setShowSuggestions(true);
                  setFocusedSuggestionIndex(-1);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setShowSuggestions(false)}
                onKeyDown={handleKeyDown}
                placeholder="Execute command..."
                aria-label="Command input"
                className={cn(
                  "flex-1 bg-transparent py-2.5 text-xs text-canopy-text font-mono placeholder:text-white/20",
                  "focus:outline-none min-w-0"
                )}
                autoComplete="off"
              />

              {/* Right Side Controls */}
              <div className="flex items-center pr-1.5 gap-1">
                {/* Location Toggle */}
                <button
                  onClick={() => setRunAsDocked(!runAsDocked)}
                  className={cn(
                    "p-1.5 rounded-[var(--radius-sm)] transition-all",
                    runAsDocked
                      ? "bg-canopy-accent/20 text-canopy-accent"
                      : "text-white/30 hover:text-white/60 hover:bg-white/10"
                  )}
                  title={
                    runAsDocked
                      ? "Output: Dock (Background Task)"
                      : "Output: Grid (Interactive Terminal)"
                  }
                  aria-label={
                    runAsDocked
                      ? "Send output to Dock (background task)"
                      : "Send output to Grid (interactive terminal)"
                  }
                >
                  {runAsDocked ? (
                    <PanelBottom className="h-3.5 w-3.5" />
                  ) : (
                    <LayoutGrid className="h-3.5 w-3.5" />
                  )}
                </button>

                {/* Enter Button */}
                <button
                  onClick={() => handleRun(input)}
                  disabled={!input.trim()}
                  className={cn(
                    "p-1.5 rounded-[var(--radius-sm)] transition-all",
                    input.trim()
                      ? "text-white hover:bg-white/10"
                      : "text-white/10 cursor-not-allowed"
                  )}
                  title="Run Command (Enter)"
                  aria-label="Run command"
                >
                  <CornerDownLeft className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Autocomplete Menu */}
              {showSuggestions && suggestions.length > 0 && (
                <div
                  role="listbox"
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute bottom-full left-0 right-0 mb-1 bg-surface border border-canopy-border rounded-[var(--radius-md)] shadow-2xl overflow-hidden z-50 max-h-64 flex flex-col"
                >
                  <div className="text-[11px] font-sans tracking-wider text-white/30 px-3 py-1 bg-black/20 border-b border-white/5 shrink-0">
                    COMMANDS
                  </div>
                  <div className="overflow-y-auto flex-1">
                    {suggestions.map((item, index) => (
                      <button
                        key={`${item.value}-${index}`}
                        role="option"
                        aria-selected={index === focusedSuggestionIndex}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2 text-left text-xs font-mono transition-colors group",
                          index === focusedSuggestionIndex
                            ? "bg-canopy-accent/20 text-canopy-text"
                            : "text-canopy-text/70 hover:bg-white/5"
                        )}
                        onClick={() => {
                          setInput(item.value);
                          handleRun(item.value);
                        }}
                      >
                        {item.type === "saved" ? (
                          <Pin className="h-3 w-3 text-canopy-accent shrink-0 fill-canopy-accent" />
                        ) : item.type === "history" ? (
                          <Clock className="h-3 w-3 opacity-40 shrink-0" />
                        ) : (
                          <Terminal className="h-3 w-3 opacity-40 shrink-0" />
                        )}
                        <div className="flex-1 truncate flex items-center justify-between min-w-0">
                          <div className="truncate">
                            <span
                              className={cn(
                                "group-hover:text-canopy-text",
                                index === focusedSuggestionIndex ? "text-canopy-accent" : "",
                                item.type === "saved" ? "font-semibold text-canopy-text" : ""
                              )}
                            >
                              {item.type === "saved" ? item.label : item.value}
                            </span>
                            {item.type === "script" && item.label !== item.value && (
                              <span className="ml-2 text-[11px] opacity-40 font-sans">
                                ({item.label})
                              </span>
                            )}
                            {item.type === "saved" && item.label !== item.value && (
                              <span className="ml-2 text-[11px] opacity-40 font-sans">
                                {item.value}
                              </span>
                            )}
                          </div>
                          {item.type === "saved" ? (
                            <button
                              type="button"
                              onClick={(e) => handleUnpin(e, item)}
                              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-opacity ml-2 shrink-0"
                              aria-label="Unpin this command"
                            >
                              <PinOff className="h-3 w-3 text-canopy-text/40 hover:text-red-400" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => handlePin(e, item)}
                              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-opacity ml-2 shrink-0"
                              aria-label="Pin this command"
                            >
                              <Pin className="h-3 w-3 text-canopy-text/40 hover:text-canopy-accent" />
                            </button>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
