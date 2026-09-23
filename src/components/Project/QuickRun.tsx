import { useState, useEffect, useMemo, useRef } from "react";
import {
  CornerDownLeft,
  LayoutGrid,
  PanelBottom,
  ChevronUp,
  ChevronDown,
  GitBranch,
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
import { logError } from "@/utils/logger";
import { RunningTaskList } from "./RunningTaskList";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { KbdChord } from "@/components/ui/Kbd";
import { isMac } from "@/lib/platform";

interface QuickRunProps {
  projectId: string;
  /** Focus the input on mount — true only when the user just opened the panel. */
  focusOnMount?: boolean;
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
    }
  | {
      /** The literal text in the field, so what Enter runs is always a visible row. */
      label: string;
      value: string;
      type: "typed";
    };

type SuggestionSection = "saved" | "script" | "history";

/** Band labels, in the order the bands render. */
const SECTION_LABELS: Record<SuggestionSection, string> = {
  saved: "Pinned",
  script: "Scripts",
  history: "Recent",
};
const SECTION_ORDER: readonly SuggestionSection[] = ["saved", "script", "history"];

const PIN_KEY_LABEL = isMac() ? "⌥P" : "Alt+P";
const SUMMARY_ID = "quick-run-summary";

/**
 * Commands are read character by character — `--watch` is two hyphens, not an
 * em dash — so the mono face's programming ligatures stay off wherever one is
 * shown.
 */
const COMMAND_TEXT_CLASS = "font-mono [font-variant-ligatures:none]";

/** The keyboard routes for the lit row, for sighted users. */
function PinHint({
  saved,
  canComplete,
  className,
}: {
  saved: boolean;
  canComplete?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("shrink-0 items-center gap-1", className)}>
      {canComplete && (
        <>
          <KbdChord shortcut="Tab" density="compact" />
          <span className="mr-1">Edit</span>
        </>
      )}
      <KbdChord shortcut="Alt+P" density="compact" />
      {saved ? "Unpin" : "Pin"}
    </span>
  );
}

/** Case-insensitive substring ranges for `HighlightedText`. */
function matchRanges(text: string, search: string): Array<[number, number]> | undefined {
  if (!search) return undefined;
  const at = text.toLowerCase().indexOf(search);
  return at < 0 ? undefined : [[at, at + search.length - 1]];
}

const QUICK_RUN_PANEL_ID = "quick-run-panel";
const HISTORY_KEY_PREFIX = "daintree_cmd_history_";
const AUTO_RESTART_KEY_PREFIX = "daintree_quickrun_autorestart_";
const EXPANDED_KEY_PREFIX = "daintree_quickrun_expanded_";

/** Stable ids so `aria-activedescendant` has something to point at. */
const SUGGESTION_LIST_ID = "quick-run-suggestions";
const suggestionOptionId = (index: number) => `quick-run-suggestion-${index}`;
const MAX_HISTORY = 10;
const LEAD_INDEX = -2;

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

/**
 * Whether QuickRun's panel is open, remembered per project. Collapsed by default.
 *
 * This is a launcher for something most sessions never run, and it used to open
 * expanded every time and forget being closed, so it permanently spent roughly
 * 88px of a 320px column on the third-priority question the footer answers.
 *
 * Lives in a hook rather than inside `QuickRun` because the toggle no longer
 * sits on the panel: it rides the footer's status row, and the panel mounts
 * only while open.
 */
export function useQuickRunExpanded(projectId: string | null): [boolean, () => void] {
  const read = (id: string | null) => {
    if (id == null) return false;
    try {
      return localStorage.getItem(`${EXPANDED_KEY_PREFIX}${id}`) === "true";
    } catch {
      return false;
    }
  };
  const [state, setState] = useState(() => ({ projectId, expanded: read(projectId) }));
  // Re-read on a project switch during render rather than in an effect, so the
  // first frame of the new project never shows the old one's panel.
  const current = state.projectId === projectId ? state : { projectId, expanded: read(projectId) };
  if (current !== state) setState(current);

  const toggle = () => {
    const next = !current.expanded;
    setState({ projectId, expanded: next });
    if (projectId == null) return;
    try {
      localStorage.setItem(`${EXPANDED_KEY_PREFIX}${projectId}`, String(next));
    } catch {
      // a session that cannot persist still gets the toggle
    }
  };

  return [current.expanded, toggle];
}

interface QuickRunToggleProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * The disclosure for QuickRun's panel, pinned to the right of the footer's
 * status row so the footer is one row rather than two stacked strips that each
 * led with a glyph and a label. Ambient state on the left, the contextual
 * control on the right: the status-bar polarity VS Code and macOS both use.
 *
 * The label stays "Run command" whether open or closed — toggle labels never
 * change with state; the chevron and `aria-expanded` carry that. Below 280px it
 * shortens to "Run" so the status on the left keeps its words.
 */
export function QuickRunToggle({ expanded, onToggle }: QuickRunToggleProps) {
  return (
    <button
      type="button"
      data-quick-run-toggle=""
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={QUICK_RUN_PANEL_ID}
      aria-label="Run command"
      className={cn(
        "flex shrink-0 items-center gap-1 self-stretch px-3 text-2xs font-medium transition-colors",
        expanded
          ? "bg-overlay-soft text-text-primary"
          : "text-text-secondary hover:bg-overlay-soft hover:text-text-primary",
        "focus-visible:outline-hidden focus-visible:bg-overlay-medium focus-visible:text-text-primary"
      )}
    >
      <span>
        Run<span className="@max-[280px]/footer:hidden"> command</span>
      </span>
      {expanded ? (
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * QuickRun's panel: the destination, running tasks and the command input. It
 * renders only while open — `useQuickRunExpanded` and `QuickRunToggle` own the
 * disclosure — and takes focus on mount, since the only reason to open it is
 * to type a command.
 */
export function QuickRun({ projectId, focusOnMount = false }: QuickRunProps) {
  const { allDetectedRunners, settings, promoteToSaved, removeFromSaved } =
    useProjectSettings(projectId);
  const addPanel = usePanelStore((state) => state.addPanel);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const { worktreeMap } = useWorktrees();

  const [input, setInput] = useState("");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchOverride, setLaunchOverride] = useState<{
    value: string;
    dock?: boolean;
    restart?: boolean;
  } | null>(null);
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
  // `LEAD_INDEX` means "whichever row is exactly what was typed", resolved
  // against the list each render, since the list re-sorts under every keystroke.
  const [focusedSuggestionIndex, setFocusedSuggestionIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const isRunningRef = useRef(false);

  // The panel mounts when the footer's toggle opens it, and a panel that hides
  // a single text field has nothing else to offer — so opening it lands in the
  // field. `preventScroll` because the footer is pinned and never needs it.
  // A panel restored open from a previous session also mounts here; taking
  // focus then would steal it from wherever the app put it, so only a panel
  // opened in this session asks for it.
  const focusOnMountRef = useRef(focusOnMount);
  // Set across the programmatic focus so it can skip the menu. Opening the
  // panel should land the caret, not throw a suggestion list over the branch
  // caption and the running tasks the panel opened to show; a click or a key
  // in the field still brings the list up.
  const quietFocusRef = useRef(false);

  useEffect(() => {
    if (!focusOnMountRef.current) return;
    quietFocusRef.current = true;
    inputRef.current?.focus({ preventScroll: true });
    quietFocusRef.current = false;
  }, []);

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
        logError("Failed to parse command history", e);
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

  // Pinning moves a row into another band, so its index changes under the
  // highlight. Remember which command was acted on and put the highlight back
  // on it once the list has re-sorted.
  const [refocus, setRefocus] = useState<{ value: string; wasSaved: boolean } | null>(null);

  const togglePin = (item: SuggestionItem) => {
    setRefocus({ value: item.value, wasSaved: item.type === "saved" });
    if (item.type === "saved") void handleUnpin(item);
    else void handlePin(item);
  };

  const handlePin = async (item: SuggestionItem) => {
    const commandToSave: RunCommand = {
      id: `cmd-${crypto.randomUUID()}`,
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
      setRefocus(null);
      logError("Failed to pin command", err);
    }
  };

  const handleUnpin = async (item: SuggestionItem) => {
    try {
      await removeFromSaved(item.value);
    } catch (err) {
      setRefocus(null);
      logError("Failed to unpin command", err);
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

    const matches = uniqueOptions.filter(
      (opt) => opt.value.toLowerCase().includes(search) || opt.label.toLowerCase().includes(search)
    );

    // Enter runs whatever row is lit, and typing lights the row that is exactly
    // the typed command — so what Enter runs is always a visible row. An exact
    // match is lit where it sits, under its own band; anything else gets the
    // typed text itself as a leading row rather than left implied by an unlit
    // list.
    const typed = input.trim();
    const normalizedTyped = normalizeCommand(typed);
    if (matches.some((opt) => normalizeCommand(opt.value) === normalizedTyped)) return matches;
    return [{ label: typed, value: typed, type: "typed" as const }, ...matches];
  }, [input, allDetectedRunners, history, settings]);

  if (refocus) {
    const normalized = normalizeCommand(refocus.value);
    const at = suggestions.findIndex((s) => normalizeCommand(s.value) === normalized);
    const moved = at >= 0 && (suggestions[at]!.type === "saved") !== refocus.wasSaved;
    if (moved) {
      setRefocus(null);
      if (at !== focusedSuggestionIndex) setFocusedSuggestionIndex(at);
    }
  }

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

  // A pinned command carries its own output and restart choice, and a toggle
  // pressed while that command is lit overrides it for this launch only.
  // Resolved before anything runs, so the summary, the toggles and the launch
  // all state the same thing.
  const resolveRunOptions = (item: SuggestionItem) => {
    const override = launchOverride?.value === item.value ? launchOverride : undefined;
    return {
      dock:
        override?.dock ??
        (item.type === "saved" && item.preferredLocation !== undefined
          ? item.preferredLocation === "dock"
          : runAsDocked),
      restart:
        override?.restart ??
        (item.type === "saved" && item.preferredAutoRestart !== undefined
          ? item.preferredAutoRestart
          : autoRestart),
    };
  };

  const handleRunItem = async (item: SuggestionItem) => {
    const cmd = item.value;
    if (!cmd.trim()) return;

    const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
    const cwd = activeWorktree?.path;

    if (!cwd) return;

    if (isRunningRef.current) return;
    isRunningRef.current = true;

    const { dock, restart } = resolveRunOptions(item);
    setShowSuggestions(false);
    setInput("");
    setFocusedSuggestionIndex(-1);
    setLaunchError(null);
    setLaunchOverride(null);

    try {
      await addPanel({
        kind: "terminal",
        title: cmd,
        cwd: cwd,
        command: cmd,
        location: dock ? "dock" : "grid",
        worktreeId: activeWorktreeId || undefined,
        exitBehavior: restart ? "restart" : undefined,
        spawnedBy: "quickrun",
      });
      saveHistory(cmd);
    } catch (error) {
      logError("Failed to spawn terminal", error);
      // Give the command back rather than leaving an empty field and no task —
      // unless something new has been typed since.
      setInput((current) => (current === "" ? cmd : current));
      setLaunchError(cmd);
    } finally {
      isRunningRef.current = false;
    }
  };

  const listOpen = showSuggestions && suggestions.length > 0;
  const searching = input.trim().length > 0;
  const normalizedInput = normalizeCommand(input);
  const activeIndex =
    focusedSuggestionIndex === LEAD_INDEX
      ? searching
        ? Math.max(
            0,
            suggestions.findIndex((s) => normalizeCommand(s.value) === normalizedInput)
          )
        : -1
      : focusedSuggestionIndex;
  const highlighted = listOpen ? suggestions[activeIndex] : undefined;

  // Keep the arrow-key selection on screen. `aria-activedescendant` names the
  // row for assistive technology but scrolls nothing, so in a list longer than
  // its cap Enter could run a command the user could not see.
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(suggestionOptionId(activeIndex))
      ?.scrollIntoView?.({ block: "nearest" });
    // `listOpen` too: reopening mounts a fresh scroller at the top while the
    // lit row may be one the user had scrolled down to.
  }, [activeIndex, listOpen]);

  // The one thing Run means, for Enter and the arrow alike: the lit row, or
  // with the list shut, the text in the field.
  const runTarget: SuggestionItem | undefined =
    highlighted ??
    (searching ? { label: input.trim(), value: input.trim(), type: "typed" } : undefined);

  const effective = runTarget
    ? resolveRunOptions(runTarget)
    : { dock: runAsDocked, restart: autoRestart };

  // A toggle changes the default — unless the lit command brings its own value
  // for it, in which case the press overrides that value for this launch and
  // leaves the saved command alone.
  const toggleOption = (key: "dock" | "restart") => {
    const ownsKey =
      runTarget?.type === "saved" &&
      (key === "dock"
        ? runTarget.preferredLocation !== undefined
        : runTarget.preferredAutoRestart !== undefined);
    if (runTarget && ownsKey) {
      const base = launchOverride?.value === runTarget.value ? launchOverride : null;
      setLaunchOverride({ ...base, value: runTarget.value, [key]: !effective[key] });
      return;
    }
    if (key === "dock") setRunAsDocked(!runAsDocked);
    else handleToggleAutoRestart();
  };

  // Tab completes: the lit command goes into the field to be read in full or
  // edited, without running. Only while it differs from what is there, so a
  // second Tab moves focus on as usual rather than trapping it.
  const canComplete =
    highlighted != null && normalizeCommand(highlighted.value) !== normalizedInput;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (runTarget) void handleRunItem(runTarget);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setShowSuggestions(true);
      setFocusedSuggestionIndex(Math.min(activeIndex + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedSuggestionIndex(Math.max(activeIndex - 1, -1));
    } else if (e.key === "Escape") {
      // Dismiss the menu, keep the field. Blurring threw the keyboard user out
      // of the one control they came here for.
      setShowSuggestions(false);
      setFocusedSuggestionIndex(-1);
    } else if (e.key === "Tab" && !e.shiftKey && canComplete && highlighted) {
      e.preventDefault();
      setInput(highlighted.value);
      setFocusedSuggestionIndex(LEAD_INDEX);
    } else if (e.altKey && e.code === "KeyP" && listOpen && highlighted) {
      // `code`, not `key`: Option+P types "π" on a Mac layout.
      e.preventDefault();
      togglePin(highlighted);
    }
  };

  const search = input.toLowerCase().trim();

  // One line per command: what you'd call it first, then what it is. Two-line
  // rows seated five commands in the menu and cut most of them at the 200px
  // floor; the band labels now say which kind a row is, so the leading
  // pin/clock/terminal glyphs went with the second line.
  const renderOption = (item: SuggestionItem, index: number) => {
    const selected = index === activeIndex;
    const primary = item.type === "saved" || item.type === "script" ? item.label : item.value;
    const secondary =
      item.type === "saved"
        ? item.label !== item.value
          ? item.value
          : undefined
        : item.type === "script"
          ? item.description || (item.label !== item.value ? item.value : undefined)
          : undefined;
    return (
      <div
        key={`${item.type}-${item.value}`}
        id={suggestionOptionId(index)}
        role="option"
        aria-selected={selected}
        aria-describedby={selected ? SUMMARY_ID : undefined}
        title={item.value}
        // Hover moves the highlight rather than painting a second, lookalike
        // state beside it — so there is only ever one lit row, and it is the
        // one Enter runs.
        onMouseMove={() => {
          if (!selected) setFocusedSuggestionIndex(index);
        }}
        onClick={() => {
          setInput(item.value);
          void handleRunItem(item);
        }}
        className={cn(
          PALETTE_ROW_CLASS,
          "flex min-h-7 cursor-pointer items-center gap-2 px-3 text-xs text-text-secondary"
        )}
      >
        {item.type === "typed" ? (
          <>
            <span className="shrink-0">Run</span>
            <span className={cn("min-w-0 truncate text-text-primary", COMMAND_TEXT_CLASS)}>
              {item.value}
            </span>
          </>
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 truncate text-text-primary",
                item.type === "saved" ? "font-medium" : COMMAND_TEXT_CLASS
              )}
            >
              <HighlightedText text={primary} indices={matchRanges(primary, search)} />
            </span>
            {secondary && (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-2xs",
                  secondary === item.value && COMMAND_TEXT_CLASS
                )}
              >
                <HighlightedText text={secondary} indices={matchRanges(secondary, search)} />
              </span>
            )}
          </>
        )}
        {selected && (
          // A pointer affordance only — never a tab stop and never inside the
          // option's accessible name, since an option's children are
          // presentational. The keyboard route is Alt+P, named in the footer.
          <span
            aria-hidden="true"
            title={`${item.type === "saved" ? "Unpin" : "Pin"} (${PIN_KEY_LABEL})`}
            onClick={(e) => {
              e.stopPropagation();
              togglePin(item);
            }}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-overlay-medium hover:text-text-primary"
          >
            {item.type === "saved" ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
          </span>
        )}
      </div>
    );
  };

  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  // The branch, beside a branch glyph — the worktree's folder name is often
  // something else entirely (worktree "main" on branch "develop").
  const destinationLabel = activeWorktree?.branch || activeWorktree?.name || "";
  const runSummary = `${effective.dock ? "Dock" : "Grid"}${effective.restart ? " · Restarts" : ""}`;
  const isWorktreeValid = activeWorktree != null && activeWorktree.path != null;

  return (
    <div id={QUICK_RUN_PANEL_ID} className="flex min-h-0 shrink-0 flex-col px-4 pb-2 pt-2 text-xs">
      {/* The destination. "Run on {branch}" once captioned a permanent header
          and restated the selection above; it survives here, where a command is
          actually about to be typed, and nowhere else. */}
      {isWorktreeValid && (
        <div className="mb-1.5 flex min-w-0 items-center gap-1 text-2xs text-text-secondary">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate" title={destinationLabel}>
            {destinationLabel}
          </span>
        </div>
      )}
      <div>
        {!isWorktreeValid ? (
          <div className="text-2xs text-text-secondary py-1">
            Select a worktree above to run a command
          </div>
        ) : (
          <>
            {activeWorktreeId && <RunningTaskList worktreeId={activeWorktreeId} />}
            <div
              // The list closes when focus leaves the field and its own
              // controls, not the field alone: tabbing to a toggle keeps the lit
              // command — and with it a pinned command's own settings, which the
              // toggles show and a press overrides — rather than dropping back
              // to the defaults mid-choice.
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setShowSuggestions(false);
              }}
              onKeyDown={(e) => {
                // The field handles its own keys; from a toggle, Escape still
                // dismisses the list it kept open.
                if (e.key === "Escape" && e.target !== inputRef.current) setShowSuggestions(false);
              }}
              className={cn(
                // Fallback keeps themes without --dock-input-bg byte-identical.
                "relative flex flex-wrap items-center rounded-[var(--radius-md)] border border-selection-outline bg-[var(--dock-input-bg,var(--color-overlay-soft))]",
                // The focus anchor, and the single accent this region spends.
                "transition-colors focus-within:border-accent-primary"
              )}
            >
              {/* Prompt Symbol. Tight on both sides: at the 200px floor every
                    pixel here comes straight out of the field. */}
              <div
                aria-hidden="true"
                className="select-none pl-2.5 pr-1.5 font-mono font-bold text-text-secondary"
              >
                $
              </div>

              {/* Input */}
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setLaunchError(null);
                  setShowSuggestions(true);
                  // Typing lights the first row, which is always what Enter runs.
                  setFocusedSuggestionIndex(e.target.value.trim() ? LEAD_INDEX : -1);
                }}
                onFocus={() => {
                  if (!quietFocusRef.current) setShowSuggestions(true);
                }}
                onClick={() => setShowSuggestions(true)}
                onKeyDown={handleKeyDown}
                placeholder="Run a command"
                aria-label="Command input"
                // The suggestion list already carries listbox/option roles, but
                // DOM focus never leaves the input, so without the combobox
                // half nothing tells a screen reader which row Enter will run.
                role="combobox"
                aria-autocomplete="list"
                aria-keyshortcuts="Alt+P"
                aria-expanded={listOpen}
                aria-controls={SUGGESTION_LIST_ID}
                aria-activedescendant={highlighted ? suggestionOptionId(activeIndex) : undefined}
                className={cn(
                  // `pr-2` is load-bearing at the narrow end: without it the
                  // field's text runs flush into the button cluster and the
                  // last glyph touches the first icon.
                  "flex-1 bg-transparent py-2 pr-2 text-xs text-text-primary placeholder:text-text-secondary",
                  COMMAND_TEXT_CLASS,
                  // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- the wrapper paints the indicator for this field via focus-within:border-accent-primary; a ring on the bare input would sit inside that border and double it
                  "focus:outline-hidden min-w-0"
                )}
                autoComplete="off"
              />

              {/* The two run options. Below 280px they drop to their own line
                  inside the field's border, because beside the input they left
                  a 200px column showing "$ Run a" — the command gave way to its
                  own secondary settings. Run stays on the input's line. */}
              <div
                className={cn(
                  "flex items-center gap-1 pr-1",
                  "@max-[280px]/footer:order-last @max-[280px]/footer:basis-full @max-[280px]/footer:justify-end @max-[280px]/footer:border-t @max-[280px]/footer:border-border-subtle @max-[280px]/footer:py-0.5 @max-[280px]/footer:pr-1.5"
                )}
              >
                {/* The toggles show what the next run will actually do,
                    including a lit pinned command's own choice. Mousedown is
                    held so the field — and its lit row — keep focus. */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleOption("restart")}
                      className={cn(
                        "rounded-[var(--radius-sm)] border p-1 transition-colors",
                        // The fill alone cleared about 1.1:1; the outline is the
                        // same neutral token the selected row's rail spends.
                        effective.restart
                          ? "border-selection-outline bg-overlay-medium text-text-primary"
                          : "border-transparent text-text-secondary hover:bg-overlay-soft hover:text-text-primary"
                      )}
                      // The label names the control, not its state — the state
                      // is `aria-pressed`'s job, and a label that flips reads
                      // as a different control each time it is pressed.
                      aria-label="Auto-restart"
                      aria-pressed={effective.restart}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {effective.restart ? "Auto-restart: on" : "Auto-restart: off"}
                  </TooltipContent>
                </Tooltip>

                {/* Location Toggle */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleOption("dock")}
                      className={cn(
                        "rounded-[var(--radius-sm)] border p-1 transition-colors",
                        // The fill alone cleared about 1.1:1; the outline is the
                        // same neutral token the selected row's rail spends.
                        effective.dock
                          ? "border-selection-outline bg-overlay-medium text-text-primary"
                          : "border-transparent text-text-secondary hover:bg-overlay-soft hover:text-text-primary"
                      )}
                      // Same rule as auto-restart: one stable name, with the
                      // state on `aria-pressed`. Pressed means docked, which
                      // is the non-default half of the pair.
                      aria-label="Run in the dock as a background task"
                      aria-pressed={effective.dock}
                    >
                      {effective.dock ? (
                        <PanelBottom className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {effective.dock
                      ? "Output: dock (background task)"
                      : "Output: grid (interactive terminal)"}
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* Enter Button */}
              <div className="flex items-center pr-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <button
                        type="button"
                        // Keep the field focused so a lit row survives the
                        // press and the arrow runs the same thing Enter would.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          if (runTarget) void handleRunItem(runTarget);
                        }}
                        disabled={!runTarget}
                        className={cn(
                          "p-1.5 rounded-[var(--radius-sm)] transition-colors",
                          // Neutral, not accent: the focus ring on the field
                          // is this region's one accent, and a lit Run arrow
                          // beside it made two marks compete for the same job.
                          // A high-contrast neutral reads as the primary
                          // action and stays theme-aware by construction.
                          runTarget
                            ? "text-text-primary hover:bg-overlay-medium"
                            : "cursor-not-allowed text-text-muted"
                        )}
                        // Not "Run command": that is the footer toggle's name,
                        // and two controls sharing it read as one to a
                        // screen reader's control list.
                        aria-label="Run"
                      >
                        <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Run (Enter)</TooltipContent>
                </Tooltip>
              </div>

              {listOpen && (
                <div
                  onMouseDown={(e) => e.preventDefault()}
                  className="absolute bottom-full left-0 right-0 z-50 mb-1 flex max-h-72 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated shadow-[var(--theme-shadow-floating)]"
                >
                  <div
                    role="listbox"
                    id={SUGGESTION_LIST_ID}
                    aria-label="Commands"
                    className="min-h-0 flex-1 overflow-y-auto py-1"
                  >
                    {suggestions[0]?.type === "typed" && renderOption(suggestions[0], 0)}
                    {SECTION_ORDER.map((section) => {
                      const rows = suggestions
                        .map((item, index) => ({ item, index }))
                        .filter(({ item }) => item.type === section);
                      if (rows.length === 0) return null;
                      const labelId = `${SUGGESTION_LIST_ID}-${section}`;
                      return (
                        <div key={section} role="group" aria-labelledby={labelId}>
                          <div
                            id={labelId}
                            role="presentation"
                            className={cn("px-3 pb-1 pt-2", PALETTE_SECTION_LABEL_CLASS)}
                          >
                            {SECTION_LABELS[section]}
                          </div>
                          {rows.map(({ item, index }) => renderOption(item, index))}
                        </div>
                      );
                    })}
                  </div>
                  {/* What Run will do, stated before it happens: the full
                      command the lit row stands for, where it runs, and how —
                      including a pinned command's own output and restart
                      choice, which override the toggles below. The branch
                      caption above the field is under this menu while it is
                      open, so the destination is restated here. The lit option
                      is described by it, so a screen reader hears the same. */}
                  <div
                    id={SUMMARY_ID}
                    className="shrink-0 space-y-0.5 border-t border-border-subtle bg-surface-input px-3 py-1.5 text-2xs text-text-secondary"
                  >
                    {highlighted && (
                      <div className="flex items-start gap-2">
                        <span
                          className={cn(
                            "line-clamp-3 min-w-0 flex-1 text-text-primary [overflow-wrap:anywhere]",
                            COMMAND_TEXT_CLASS
                          )}
                        >
                          {highlighted.value}
                        </span>
                        <PinHint
                          saved={highlighted.type === "saved"}
                          canComplete={canComplete}
                          className="flex @max-[280px]/footer:hidden"
                        />
                      </div>
                    )}
                    {/* Below 280px the settings take their own line so the
                        branch keeps its width, and the key hint rides with them
                        instead of taking the command's. */}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-1">
                      <span className="flex min-w-0 items-center gap-1 @max-[280px]/footer:basis-full">
                        <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Runs on </span>
                        <span className="min-w-0 truncate">{destinationLabel}</span>
                      </span>
                      <span className="shrink-0">
                        <span aria-hidden="true" className="@max-[280px]/footer:hidden">
                          {"· "}
                        </span>
                        {runSummary}
                      </span>
                      {highlighted && (
                        <PinHint
                          saved={highlighted.type === "saved"}
                          className="ml-auto hidden @max-[280px]/footer:flex"
                        />
                      )}
                    </div>
                    {highlighted && (
                      <span className="sr-only">
                        {`${canComplete ? "Tab to edit, " : ""}${PIN_KEY_LABEL} to ${highlighted.type === "saved" ? "unpin" : "pin"}`}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
            {launchError && (
              <div
                role="alert"
                className="mt-1 truncate text-2xs text-text-primary"
                title={launchError}
              >
                Couldn't start {launchError}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
