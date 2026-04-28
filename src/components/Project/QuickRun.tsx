import { useState, useEffect, useMemo, useRef } from "react";
import {
  CornerDownLeft,
  LayoutGrid,
  PanelBottom,
  SquareTerminal,
  Clock,
  ChevronRight,
  ChevronDown,
  Pin,
  PinOff,
  RefreshCw,
} from "lucide-react";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktrees } from "@/hooks/useWorktrees";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RunCommand } from "@/types";
import { RunningTaskList } from "./RunningTaskList";

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
      preferredLocation?: "dock" | "grid";
      preferredAutoRestart?: boolean;
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

const HISTORY_KEY_PREFIX = "daintree_cmd_history_";
const AUTO_RESTART_KEY_PREFIX = "daintree_quickrun_autorestart_";
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
  const addPanel = usePanelStore((state) => state.addPanel);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const { worktreeMap } = useWorktrees();

  const [isExpanded, setIsExpanded] = useState(true);
  const [input, setInput] = useState("");
  const [runAsDocked, setRunAsDocked] = useState(false);
  const [autoRestart, setAutoRestart] = useState(() => {
    try {
      return localStorage.getItem(`${AUTO_RESTART_KEY_PREFIX}${projectId}`) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      setAutoRestart(localStorage.getItem(`${AUTO_RESTART_KEY_PREFIX}${projectId}`) === "true");
    } catch {
      setAutoRestart(false);
    }
  }, [projectId]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [focusedSuggestionIndex, setFocusedSuggestionIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const isRunningRef = useRef(false);

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
      preferredLocation: runAsDocked ? "dock" : "grid",
      preferredAutoRestart: autoRestart,
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
          preferredLocation: saved?.preferredLocation,
          preferredAutoRestart: saved?.preferredAutoRestart,
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
        preferredLocation: cmd.preferredLocation,
        preferredAutoRestart: cmd.preferredAutoRestart,
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

  const handleToggleAutoRestart = () => {
    setAutoRestart((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`${AUTO_RESTART_KEY_PREFIX}${projectId}`, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleRunItem = async (item: SuggestionItem) => {
    const cmd = item.value;
    if (!cmd.trim()) return;

    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
    const cwd = activeWorktree?.path;

    if (!cwd) return;

    if (isRunningRef.current) return;
    isRunningRef.current = true;

    try {
      // Apply stored preferences for saved items, fall back to global state
      const useDock =
        item.type === "saved" && item.preferredLocation !== undefined
          ? item.preferredLocation === "dock"
          : runAsDocked;
      const useAutoRestart =
        item.type === "saved" && item.preferredAutoRestart !== undefined
          ? item.preferredAutoRestart
          : autoRestart;

      // Update visible toggles to reflect the preferences being used
      if (item.type === "saved") {
        if (item.preferredLocation !== undefined) setRunAsDocked(useDock);
        if (item.preferredAutoRestart !== undefined) setAutoRestart(useAutoRestart);
      }

      saveHistory(cmd);
      setShowSuggestions(false);
      setInput("");
      setFocusedSuggestionIndex(-1);

      await addPanel({
        kind: "terminal",
        title: cmd,
        cwd: cwd,
        command: cmd,
        location: useDock ? "dock" : "grid",
        worktreeId: activeWorktreeId || undefined,
        exitBehavior: useAutoRestart ? "restart" : undefined,
        spawnedBy: "quickrun",
      });
    } catch (error) {
      console.error("Failed to spawn terminal:", error);
    } finally {
      isRunningRef.current = false;
    }
  };

  const handleRun = async (cmd: string) => {
    await handleRunItem({ label: cmd, value: cmd, type: "history" });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (focusedSuggestionIndex >= 0 && suggestions[focusedSuggestionIndex]) {
        handleRunItem(suggestions[focusedSuggestionIndex]);
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
    <div className="flex min-h-0 shrink-0 flex-col border-t border-border-divider bg-surface-sidebar/95 text-xs">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "flex w-full items-center justify-between px-4 py-2 font-sans",
          "text-text-muted transition-colors hover:bg-overlay-soft hover:text-text-secondary focus:outline-none"
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
                isWorktreeValid ? "text-daintree-text" : "text-daintree-text/50"
              )}
            >
              {activeWorktreeName}
            </span>
          </span>
        </div>
      </button>

      {isExpanded && (
        <div id="quick-run-panel" className="px-4 pb-3 pt-1">
          {!isWorktreeValid ? (
            <div className="text-xs text-text-muted text-center py-2">
              Select a worktree above to enable Quick Run
            </div>
          ) : (
            <>
              {activeWorktreeId && <RunningTaskList worktreeId={activeWorktreeId} />}
              <div
                className={cn(
                  "relative flex items-center rounded-[var(--radius-md)] border border-border-subtle/50 bg-overlay-soft",
                  "transition focus-within:border-daintree-accent/35 focus-within:ring-1 focus-within:ring-daintree-accent/12"
                )}
              >
                {/* Prompt Symbol */}
                <div className="select-none pl-3 pr-2 font-mono font-bold text-text-muted">$</div>

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
                    "flex-1 bg-transparent py-2.5 text-xs font-mono text-daintree-text placeholder:text-text-muted",
                    "focus:outline-none min-w-0"
                  )}
                  autoComplete="off"
                />

                {/* Right Side Controls */}
                <div className="flex items-center pr-1.5 gap-1">
                  {/* Auto-Restart Toggle */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleToggleAutoRestart}
                        className={cn(
                          "p-1.5 rounded-[var(--radius-sm)] transition",
                          autoRestart
                            ? "bg-overlay-medium text-daintree-text"
                            : "text-text-muted hover:bg-overlay-soft hover:text-text-secondary"
                        )}
                        aria-label={autoRestart ? "Disable auto-restart" : "Enable auto-restart"}
                        aria-pressed={autoRestart}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {autoRestart ? "Auto-restart: On" : "Auto-restart: Off"}
                    </TooltipContent>
                  </Tooltip>

                  {/* Location Toggle */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setRunAsDocked(!runAsDocked)}
                        className={cn(
                          "p-1.5 rounded-[var(--radius-sm)] transition",
                          runAsDocked
                            ? "bg-overlay-medium text-daintree-text"
                            : "text-text-muted hover:bg-overlay-soft hover:text-text-secondary"
                        )}
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
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {runAsDocked
                        ? "Output: Dock (Background Task)"
                        : "Output: Grid (Interactive Terminal)"}
                    </TooltipContent>
                  </Tooltip>

                  {/* Enter Button */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <button
                          type="button"
                          onClick={() => handleRun(input)}
                          disabled={!input.trim()}
                          className={cn(
                            "p-1.5 rounded-[var(--radius-sm)] transition",
                            input.trim()
                              ? "text-accent-primary hover:bg-accent-soft"
                              : "cursor-not-allowed text-text-muted/50"
                          )}
                          aria-label="Run command"
                        >
                          <CornerDownLeft className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Run Command (Enter)</TooltipContent>
                  </Tooltip>
                </div>

                {/* Autocomplete Menu */}
                {showSuggestions && suggestions.length > 0 && (
                  <div
                    role="listbox"
                    onMouseDown={(e) => e.preventDefault()}
                    className="absolute bottom-full left-0 right-0 z-50 mb-1 flex max-h-64 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated shadow-[var(--theme-shadow-floating)]"
                  >
                    <div className="shrink-0 border-b border-border-subtle bg-surface-input px-3 py-1 text-[11px] font-sans tracking-wider text-text-muted">
                      COMMANDS
                    </div>
                    <div className="overflow-y-auto flex-1">
                      {suggestions.map((item, index) => (
                        <button
                          type="button"
                          key={`${item.value}-${index}`}
                          role="option"
                          aria-selected={index === focusedSuggestionIndex}
                          className={cn(
                            "group flex w-full items-center gap-3 px-3 py-2 text-left text-xs font-mono transition-colors",
                            index === focusedSuggestionIndex
                              ? "bg-accent-soft text-daintree-text"
                              : "text-text-secondary hover:bg-overlay-soft"
                          )}
                          onClick={() => {
                            setInput(item.value);
                            handleRunItem(item);
                          }}
                        >
                          {item.type === "saved" ? (
                            <Pin className="h-3 w-3 text-text-secondary shrink-0" />
                          ) : item.type === "history" ? (
                            <Clock className="h-3 w-3 opacity-40 shrink-0" />
                          ) : (
                            <SquareTerminal className="h-3 w-3 opacity-40 shrink-0" />
                          )}
                          <div className="flex-1 truncate flex items-start justify-between min-w-0">
                            <div className="truncate">
                              <span
                                className={cn(
                                  "group-hover:text-daintree-text",
                                  item.type === "saved" ? "font-semibold text-daintree-text" : ""
                                )}
                              >
                                {item.type === "saved" ? item.label : item.value}
                              </span>
                              {item.type === "script" && item.label !== item.value && (
                                <span className="ml-2 text-[11px] font-sans text-text-muted">
                                  ({item.label})
                                </span>
                              )}
                              {item.type === "saved" && item.label !== item.value && (
                                <span className="ml-2 text-[11px] font-sans text-text-muted">
                                  {item.value}
                                </span>
                              )}
                              {(item.type === "script" || item.type === "saved") &&
                                "description" in item &&
                                item.description && (
                                  <span className="mt-0.5 block truncate text-[11px] font-sans text-text-muted">
                                    {item.description}
                                  </span>
                                )}
                            </div>
                            {item.type === "saved" ? (
                              <button
                                type="button"
                                onClick={(e) => handleUnpin(e, item)}
                                className="ml-2 shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-overlay-soft"
                                aria-label="Unpin this command"
                              >
                                <PinOff className="h-3 w-3 text-text-muted hover:text-status-error" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => handlePin(e, item)}
                                className="ml-2 shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-overlay-soft"
                                aria-label="Pin this command"
                              >
                                <Pin className="h-3 w-3 text-text-muted hover:text-daintree-accent" />
                              </button>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
