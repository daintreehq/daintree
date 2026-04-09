import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { usePaletteStore } from "@/store/paletteStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useShallow } from "zustand/react/shallow";
import { useEscapeStack } from "@/hooks";
import { isAgentTerminal } from "@/utils/terminalType";
import { ChevronRight } from "lucide-react";
import { getDominantAgentState } from "@/components/Worktree/AgentStatusIndicator";
import { STATE_ICONS, STATE_COLORS, STATE_LABELS } from "@/components/Worktree/terminalStateConfig";
import {
  replaceRecipeVariables,
  detectUnresolvedVariables,
  getAvailableVariables,
  type RecipeContext,
} from "@/utils/recipeVariables";
import { terminalClient } from "@/clients";
import PQueue from "p-queue";
import type { AgentState } from "@/types";
import type { TerminalInstance } from "@shared/types";

const PALETTE_ID = "bulk-command" as const;

export function openBulkCommandPalette(): void {
  usePaletteStore.getState().openPalette(PALETTE_ID);
}

type BulkMode = "keystroke" | "text" | "recipe";
type BulkStep = "select" | "preview";
type KeystrokePreset = "escape" | "enter" | "ctrl+c" | "double-escape";

interface WorktreeTerminalRow {
  id: string;
  label: string;
  agentState: AgentState | null;
}

interface WorktreeRow {
  id: string;
  branch: string;
  path: string;
  issueNumber?: number;
  prNumber?: number;
  terminals: WorktreeTerminalRow[];
  agentTerminalCount: number;
  dominantState: AgentState | null;
  disabled: boolean;
}

const KEYSTROKE_LABELS: Record<KeystrokePreset, string> = {
  escape: "Escape",
  enter: "Enter",
  "ctrl+c": "Ctrl+C",
  "double-escape": "Double Escape",
};

const KEYSTROKE_KEYS: Record<Exclude<KeystrokePreset, "double-escape">, string> = {
  escape: "escape",
  enter: "enter",
  "ctrl+c": "ctrl+c",
};

const DESTRUCTIVE_KEYSTROKES = new Set<KeystrokePreset>(["ctrl+c", "double-escape"]);

const BULK_HISTORY_KEY = "bulk-commands";

interface StatePreset {
  label: string;
  match: (terminal: WorktreeTerminalRow) => boolean;
}

const STATE_PRESETS: StatePreset[] = [
  {
    label: "Active",
    match: (t) => t.agentState === "working" || t.agentState === "running",
  },
  { label: "Waiting", match: (t) => t.agentState === "waiting" },
  { label: "Idle", match: (t) => t.agentState === null || t.agentState === "idle" },
  { label: "Completed", match: (t) => t.agentState === "completed" },
  { label: "Exited", match: (t) => t.agentState === "exited" },
];

function getEligibleTerminals(
  terminals: TerminalInstance[],
  worktreeId: string
): TerminalInstance[] {
  return terminals.filter(
    (t) =>
      t.worktreeId === worktreeId &&
      isAgentTerminal(t.kind ?? t.type, t.agentId) &&
      t.location !== "trash" &&
      t.location !== "background" &&
      t.hasPty !== false
  );
}

function useWorktreeRows(): WorktreeRow[] {
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const panelsById = usePanelStore((s) => s.panelsById);
  const panelIds = usePanelStore((s) => s.panelIds);

  return useMemo(() => {
    const rows: WorktreeRow[] = [];
    const terminals = panelIds.map((id) => panelsById[id]).filter(Boolean);
    for (const wt of worktrees.values()) {
      const eligible = getEligibleTerminals(terminals, wt.id);
      const dominantState = getDominantAgentState(eligible.map((t) => t.agentState));
      const terminalRows: WorktreeTerminalRow[] = eligible.map((t) => ({
        id: t.id,
        label: t.title?.trim() || t.agentId || t.id,
        agentState: (t.agentState as AgentState | undefined) ?? null,
      }));
      rows.push({
        id: wt.id,
        branch: wt.branch ?? wt.name,
        path: wt.path,
        issueNumber: wt.issueNumber,
        prNumber: wt.prNumber,
        terminals: terminalRows,
        agentTerminalCount: terminalRows.length,
        dominantState,
        disabled: terminalRows.length === 0,
      });
    }
    return rows;
  }, [worktrees, panelsById, panelIds]);
}

function buildRecipeContext(row: WorktreeRow): RecipeContext {
  return {
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    worktreePath: row.path,
    branchName: row.branch,
  };
}

interface PreviewEntry {
  row: WorktreeRow;
  resolvedText: string;
  unresolvedVars: string[];
}

export function BulkCommandPalette() {
  const isOpen = usePaletteStore((s) => s.activePaletteId === PALETTE_ID);
  if (!isOpen) return null;
  return <BulkCommandPaletteInner />;
}

function BulkCommandPaletteInner() {
  const closePalette = useCallback(() => usePaletteStore.getState().closePalette(PALETTE_ID), []);

  const rows = useWorktreeRows();
  // selectedIds now holds terminal IDs (was worktree IDs).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<BulkMode>("keystroke");
  const [step, setStep] = useState<BulkStep>("select");
  const [keystrokePreset, setKeystrokePreset] = useState<KeystrokePreset>("escape");
  const [commandText, setCommandText] = useState("");
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [pendingDestructive, setPendingDestructive] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const doubleEscapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<PQueue | null>(null);

  const availableVars = useMemo(() => getAvailableVariables(), []);
  const historyEntries = useCommandHistoryStore(
    useShallow((s) => s.getProjectHistory(BULK_HISTORY_KEY))
  );

  const projectRecipes = useRecipeStore(
    useShallow((s) => s.recipes.filter((r) => r.worktreeId === undefined))
  );

  useEffect(() => {
    return () => {
      if (doubleEscapeTimerRef.current) {
        clearTimeout(doubleEscapeTimerRef.current);
      }
      queueRef.current?.clear();
    };
  }, []);

  useEscapeStack(step === "preview", () => setStep("select"));
  useEscapeStack(pendingDestructive, () => setPendingDestructive(false));

  useEffect(() => {
    setStep("select");
    setPendingDestructive(false);
  }, [mode]);

  useEffect(() => {
    setPendingDestructive(false);
  }, [keystrokePreset]);

  const enabledRows = useMemo(() => rows.filter((r) => !r.disabled), [rows]);

  // Prune stale selection/expansion ids when the rows collection changes (e.g.,
  // a terminal exits or a worktree is removed while the palette is open).
  useEffect(() => {
    const validTerminalIds = new Set<string>();
    const validWorktreeIds = new Set<string>();
    for (const row of rows) {
      validWorktreeIds.add(row.id);
      for (const t of row.terminals) validTerminalIds.add(t.id);
    }
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validTerminalIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validWorktreeIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const rowAllSelected = useCallback(
    (row: WorktreeRow) =>
      row.terminals.length > 0 && row.terminals.every((t) => selectedIds.has(t.id)),
    [selectedIds]
  );
  const rowSomeSelected = useCallback(
    (row: WorktreeRow) => row.terminals.some((t) => selectedIds.has(t.id)),
    [selectedIds]
  );

  const allEnabledSelected = useMemo(
    () => enabledRows.length > 0 && enabledRows.every(rowAllSelected),
    [enabledRows, rowAllSelected]
  );

  // Worktrees with at least one selected terminal — feeds preview UI,
  // recipe broadcast, and the footer worktree count.
  const selectedRows = useMemo(
    () => rows.filter((r) => r.terminals.some((t) => selectedIds.has(t.id))),
    [rows, selectedIds]
  );

  const presetCounts = useMemo(
    () =>
      Object.fromEntries(
        STATE_PRESETS.map((p) => [
          p.label,
          rows
            .filter((r) => !r.disabled)
            .flatMap((r) => r.terminals)
            .filter((t) => p.match(t)).length,
        ])
      ),
    [rows]
  );

  const selectedTerminalCount = selectedIds.size;
  const selectedWorktreeCount = selectedRows.length;

  const toggleTerminal = useCallback((terminalId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(terminalId)) next.delete(terminalId);
      else next.add(terminalId);
      return next;
    });
  }, []);

  const toggleWorktree = useCallback(
    (row: WorktreeRow) => {
      if (row.terminals.length === 0) return;
      const allSelected = row.terminals.every((t) => selectedIds.has(t.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (allSelected) {
          for (const t of row.terminals) next.delete(t.id);
        } else {
          for (const t of row.terminals) next.add(t.id);
        }
        return next;
      });
    },
    [selectedIds]
  );

  const toggleExpand = useCallback((worktreeId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(worktreeId)) next.delete(worktreeId);
      else next.add(worktreeId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allEnabledSelected) {
      setSelectedIds(new Set());
    } else {
      const all = new Set<string>();
      for (const row of enabledRows) {
        for (const t of row.terminals) all.add(t.id);
      }
      setSelectedIds(all);
    }
  }, [allEnabledSelected, enabledRows]);

  const applyPreset = useCallback(
    (preset: StatePreset) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const row of rows) {
          if (row.disabled) continue;
          for (const t of row.terminals) {
            if (preset.match(t)) next.add(t.id);
          }
        }
        return next;
      });
    },
    [rows]
  );

  const previewEntries = useMemo((): PreviewEntry[] => {
    if (step !== "preview" || mode !== "text") return [];
    return selectedRows.map((row) => {
      const ctx = buildRecipeContext(row);
      return {
        row,
        resolvedText: replaceRecipeVariables(commandText, ctx),
        unresolvedVars: detectUnresolvedVariables(commandText, ctx),
      };
    });
  }, [step, mode, selectedRows, commandText]);

  const resolveTargetIds = useCallback((): string[] => {
    // selectedIds are terminal IDs. Filter against the current panel store
    // so we drop anything that has exited or been trashed since selection.
    const { panelsById: tById, panelIds: tIds } = usePanelStore.getState();
    const liveEligible = new Set<string>();
    const allTerminals = tIds.map((id) => tById[id]).filter(Boolean);
    for (const t of allTerminals) {
      if (!t.worktreeId) continue;
      if (
        isAgentTerminal(t.kind ?? t.type, t.agentId) &&
        t.location !== "trash" &&
        t.location !== "background" &&
        t.hasPty !== false
      ) {
        liveEligible.add(t.id);
      }
    }
    return [...selectedIds].filter((id) => liveEligible.has(id));
  }, [selectedIds]);

  const handleInsertVariable = useCallback(
    (varName: string) => {
      const input = inputRef.current;
      const cursor = input?.selectionStart ?? commandText.length;
      const chipText = `{{${varName}}}`;
      const newValue = commandText.slice(0, cursor) + chipText + commandText.slice(cursor);
      const newCursor = cursor + chipText.length;
      flushSync(() => setCommandText(newValue));
      input?.focus();
      input?.setSelectionRange(newCursor, newCursor);
    },
    [commandText]
  );

  const handlePreview = useCallback(() => {
    if (mode === "keystroke") return;
    setStep("preview");
  }, [mode]);

  const handleConfirm = useCallback(async () => {
    setIsSending(true);
    let totalTargets = 0;
    let failures = 0;

    if (mode === "text") {
      // Build a terminal-id → parent worktree lookup so recipe variables
      // resolve from the correct worktree context.
      const terminalToRow = new Map<string, WorktreeRow>();
      for (const row of rows) {
        for (const t of row.terminals) terminalToRow.set(t.id, row);
      }
      const targetIds = resolveTargetIds();
      const promises: Promise<unknown>[] = [];
      for (const terminalId of targetIds) {
        const row = terminalToRow.get(terminalId);
        if (!row) continue;
        const resolved = replaceRecipeVariables(commandText, buildRecipeContext(row));
        if (!resolved.trim()) continue;
        promises.push(terminalClient.submit(terminalId, resolved));
      }
      totalTargets = promises.length;
      const results = await Promise.allSettled(promises);
      failures = results.filter((r) => r.status === "rejected").length;
      if (totalTargets > 0) {
        useCommandHistoryStore.getState().recordPrompt(BULK_HISTORY_KEY, commandText);
      }
    } else if (mode === "recipe" && selectedRecipeId) {
      const queue = new PQueue({ concurrency: 2 });
      queueRef.current = queue;
      const tasks = selectedRows.map(
        (row) => () =>
          useRecipeStore
            .getState()
            .runRecipeWithResults(selectedRecipeId, row.path, row.id, buildRecipeContext(row))
            .catch((err) => {
              console.error(`Recipe broadcast failed for ${row.branch}:`, err);
              throw err;
            })
      );
      totalTargets = tasks.length;
      const results = await Promise.allSettled(tasks.map((t) => queue.add(t)));
      failures = results.filter((r) => r.status === "rejected").length;
      queueRef.current = null;
    }

    if (totalTargets > 0) {
      const toastType = failures > 0 ? "warning" : "success";
      const failSuffix = failures > 0 ? ` (${failures} failed)` : "";
      useNotificationStore.getState().addNotification({
        type: toastType,
        priority: "low",
        message: `Sent to ${selectedRows.length} worktree${selectedRows.length !== 1 ? "s" : ""}, ${totalTargets} target${totalTargets !== 1 ? "s" : ""}${failSuffix}`,
      });
    }

    setIsSending(false);
    closePalette();
  }, [mode, rows, selectedRows, commandText, selectedRecipeId, resolveTargetIds, closePalette]);

  const handleSend = useCallback(async () => {
    if (mode === "keystroke") {
      if (DESTRUCTIVE_KEYSTROKES.has(keystrokePreset) && !pendingDestructive) {
        setPendingDestructive(true);
        return;
      }

      const targetIds = resolveTargetIds();
      if (targetIds.length === 0) return;
      setIsSending(true);

      const sentCount = targetIds.length;
      if (keystrokePreset === "double-escape") {
        targetIds.forEach((id) => terminalClient.sendKey(id, "escape"));
        doubleEscapeTimerRef.current = setTimeout(() => {
          doubleEscapeTimerRef.current = null;
          const freshTargetIds = resolveTargetIds();
          freshTargetIds.forEach((id) => terminalClient.sendKey(id, "escape"));
          setIsSending(false);
          useNotificationStore.getState().addNotification({
            type: "success",
            priority: "low",
            message: `Sent ${KEYSTROKE_LABELS[keystrokePreset]} to ${sentCount} agent${sentCount !== 1 ? "s" : ""}`,
          });
          closePalette();
        }, 1000);
      } else {
        const key = KEYSTROKE_KEYS[keystrokePreset];
        targetIds.forEach((id) => terminalClient.sendKey(id, key));
        setIsSending(false);
        useNotificationStore.getState().addNotification({
          type: "success",
          priority: "low",
          message: `Sent ${KEYSTROKE_LABELS[keystrokePreset]} to ${sentCount} agent${sentCount !== 1 ? "s" : ""}`,
        });
        closePalette();
      }
    } else {
      handlePreview();
    }
  }, [mode, keystrokePreset, pendingDestructive, resolveTargetIds, closePalette, handlePreview]);

  const canSend = useMemo(() => {
    if (selectedIds.size === 0 || isSending) return false;
    if (mode === "keystroke") return true;
    if (mode === "text") return commandText.trim().length > 0;
    if (mode === "recipe") return selectedRecipeId !== null;
    return false;
  }, [selectedIds.size, isSending, mode, commandText, selectedRecipeId]);

  const selectedRecipe = useMemo(
    () => (selectedRecipeId ? projectRecipes.find((r) => r.id === selectedRecipeId) : null),
    [selectedRecipeId, projectRecipes]
  );

  const actionLabel = step === "preview" ? "Confirm" : mode === "keystroke" ? "Send" : "Preview";

  return (
    <AppPaletteDialog isOpen onClose={closePalette} ariaLabel="Bulk Operations">
      <AppPaletteDialog.Header label="Bulk Operations">
        <div className="flex gap-1 mb-1">
          {(["keystroke", "text", "recipe"] as const).map((m) => (
            <button
              key={m}
              className={`px-3 py-1 text-xs rounded-[var(--radius-md)] transition-colors ${
                mode === m
                  ? "bg-canopy-accent text-text-inverse"
                  : "bg-canopy-sidebar text-canopy-text/60 hover:text-canopy-text"
              }`}
              onClick={() => setMode(m)}
            >
              {m === "keystroke" ? "Keystroke" : m === "text" ? "Text Command" : "Recipe"}
            </button>
          ))}
        </div>
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        {step === "preview" ? (
          <div className="px-3 py-2 space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setStep("select")}
                className="text-xs text-canopy-accent hover:text-canopy-accent/80 transition-colors"
              >
                &larr; Back
              </button>
              <span className="text-xs text-canopy-text/50">
                Preview &mdash; {selectedRows.length} worktree
                {selectedRows.length !== 1 ? "s" : ""}
              </span>
            </div>
            {mode === "text" &&
              previewEntries.map((entry) => (
                <div
                  key={entry.row.id}
                  className="rounded-[var(--radius-md)] border border-canopy-border p-2 text-xs"
                >
                  <div className="font-medium text-canopy-text mb-1">{entry.row.branch}</div>
                  <div className="font-mono text-canopy-text/70 break-all">
                    {entry.resolvedText}
                  </div>
                  {entry.unresolvedVars.length > 0 && (
                    <div className="mt-1 text-amber-400">
                      Missing: {entry.unresolvedVars.map((v) => `{{${v}}}`).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            {mode === "recipe" && selectedRecipe && (
              <>
                <div className="text-xs text-canopy-text/60 mb-1">
                  Recipe: <span className="text-canopy-text">{selectedRecipe.name}</span> &mdash;{" "}
                  {selectedRecipe.terminals.length} terminal
                  {selectedRecipe.terminals.length !== 1 ? "s" : ""}
                </div>
                {selectedRows.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-[var(--radius-md)] border border-canopy-border p-2 text-xs"
                  >
                    <div className="font-medium text-canopy-text">{row.branch}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            {/* Action config — above worktree list */}
            <div className="px-3 py-2 border-b border-canopy-border">
              {mode === "keystroke" ? (
                pendingDestructive ? (
                  <div className="flex items-center gap-2 py-1">
                    <span className="text-xs text-amber-400 flex-1">
                      Send {KEYSTROKE_LABELS[keystrokePreset]} to {selectedTerminalCount} agent
                      {selectedTerminalCount !== 1 ? "s" : ""}?
                    </span>
                    <button
                      onClick={() => {
                        setPendingDestructive(false);
                        handleSend();
                      }}
                      className="px-2 py-0.5 text-xs rounded-[var(--radius-md)] bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setPendingDestructive(false)}
                      className="px-2 py-0.5 text-xs rounded-[var(--radius-md)] text-canopy-text/50 hover:text-canopy-text transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(KEYSTROKE_LABELS) as KeystrokePreset[]).map((preset) => (
                      <button
                        key={preset}
                        onClick={() => setKeystrokePreset(preset)}
                        className={`px-2.5 py-1 text-xs rounded-[var(--radius-md)] border transition-colors ${
                          keystrokePreset === preset
                            ? "border-canopy-accent bg-canopy-accent/10 text-canopy-accent"
                            : "border-canopy-border text-canopy-text/60 hover:text-canopy-text hover:border-canopy-text/30"
                        }`}
                      >
                        {KEYSTROKE_LABELS[preset]}
                      </button>
                    ))}
                  </div>
                )
              ) : mode === "text" ? (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      ref={inputRef}
                      type="text"
                      value={commandText}
                      onChange={(e) => {
                        setCommandText(e.target.value);
                        setHistoryIndex(-1);
                        setShowHistory(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
                          e.preventDefault();
                          handleConfirm();
                        } else if (e.key === "Enter" && canSend) {
                          e.preventDefault();
                          handleSend();
                        } else if (e.key === "ArrowUp" && historyEntries.length > 0) {
                          e.preventDefault();
                          const next = Math.min(historyIndex + 1, historyEntries.length - 1);
                          setHistoryIndex(next);
                          setCommandText(historyEntries[next].prompt);
                          setShowHistory(false);
                        } else if (e.key === "ArrowDown" && historyIndex >= 0) {
                          e.preventDefault();
                          const next = historyIndex - 1;
                          setHistoryIndex(next);
                          setCommandText(next >= 0 ? historyEntries[next].prompt : "");
                          setShowHistory(false);
                        }
                      }}
                      onFocus={() => {
                        if (commandText === "" && historyEntries.length > 0) setShowHistory(true);
                      }}
                      onBlur={() => setShowHistory(false)}
                      placeholder="Type a command..."
                      className="w-full px-3 py-2 text-sm bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] text-canopy-text placeholder:italic placeholder:text-canopy-text/30 focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/20"
                    />
                    {showHistory && commandText === "" && (
                      <div className="absolute left-0 right-0 top-full mt-1 bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] shadow-lg z-10 max-h-40 overflow-y-auto">
                        {historyEntries.slice(0, 8).map((entry) => (
                          <button
                            key={entry.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setCommandText(entry.prompt);
                              setShowHistory(false);
                            }}
                            className="w-full text-left px-3 py-1.5 text-xs text-canopy-text/70 hover:bg-tint/[0.06] truncate"
                          >
                            {entry.prompt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="flex flex-wrap gap-1">
                      {availableVars.map((v) => (
                        <button
                          key={v.name}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handleInsertVariable(v.name);
                          }}
                          className="px-1.5 py-0.5 text-[10px] rounded-[var(--radius-sm)] border border-canopy-border text-canopy-text/50 hover:text-canopy-accent hover:border-canopy-accent/40 transition-colors font-mono"
                        >
                          {`{{${v.name}}}`}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-canopy-text/30 mt-1">
                      Click to insert &middot; Variables resolve per worktree
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {projectRecipes.length === 0 ? (
                    <div className="text-xs text-canopy-text/40 py-1">No project-wide recipes</div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {projectRecipes.map((recipe) => (
                        <button
                          key={recipe.id}
                          onClick={() => setSelectedRecipeId(recipe.id)}
                          className={`px-2.5 py-1 text-xs rounded-[var(--radius-md)] border transition-colors ${
                            selectedRecipeId === recipe.id
                              ? "border-canopy-accent bg-canopy-accent/10 text-canopy-accent"
                              : "border-canopy-border text-canopy-text/60 hover:text-canopy-text hover:border-canopy-text/30"
                          }`}
                        >
                          {recipe.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Worktree list */}
            {rows.length === 0 ? (
              <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
                No worktrees available
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1 px-3 py-1.5">
                  <button
                    onClick={toggleAll}
                    className="text-xs text-canopy-text/50 hover:text-canopy-text transition-colors"
                  >
                    {allEnabledSelected ? "Deselect All" : "Select All"}
                  </button>
                  <span className="text-canopy-text/20 mx-1">|</span>
                  {STATE_PRESETS.map((preset) => {
                    const count = presetCounts[preset.label];
                    return (
                      <button
                        key={preset.label}
                        onClick={() => applyPreset(preset)}
                        disabled={count === 0}
                        className={`px-1.5 py-0.5 text-[10px] rounded-[var(--radius-sm)] border border-canopy-border transition-colors ${
                          count === 0
                            ? "opacity-40 cursor-not-allowed text-canopy-text/50"
                            : "text-canopy-text/50 hover:text-canopy-text hover:border-canopy-text/30"
                        }`}
                      >
                        {preset.label} ({count})
                      </button>
                    );
                  })}
                </div>
                <div
                  role="treegrid"
                  aria-multiselectable="true"
                  aria-label="Worktrees and agent terminals"
                >
                  {rows.map((row, rowIndex) => {
                    const StateIcon = row.dominantState ? STATE_ICONS[row.dominantState] : null;
                    const stateColor = row.dominantState ? STATE_COLORS[row.dominantState] : "";
                    const allSelected = rowAllSelected(row);
                    const someSelected = rowSomeSelected(row);
                    const isPartial = someSelected && !allSelected;
                    const isExpanded = expandedIds.has(row.id);
                    const canExpand = !row.disabled && row.terminals.length > 0;
                    return (
                      <div
                        key={row.id}
                        role="row"
                        aria-level={1}
                        aria-posinset={rowIndex + 1}
                        aria-setsize={rows.length}
                        aria-expanded={canExpand ? isExpanded : undefined}
                        data-testid={`bulk-worktree-row-${row.id}`}
                        className={`rounded-[var(--radius-lg)] border ${
                          row.disabled
                            ? "opacity-40 cursor-not-allowed border-transparent"
                            : allSelected
                              ? "border-canopy-accent/40 bg-canopy-accent/10"
                              : someSelected
                                ? "border-canopy-accent/20 bg-canopy-accent/5"
                                : "border-transparent hover:bg-tint/[0.06]"
                        }`}
                      >
                        <div role="gridcell" className="flex items-center gap-2 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => canExpand && toggleExpand(row.id)}
                            disabled={!canExpand}
                            aria-label={isExpanded ? "Collapse terminals" : "Expand terminals"}
                            data-testid={`bulk-worktree-expand-${row.id}`}
                            className={`shrink-0 w-4 h-4 flex items-center justify-center text-canopy-text/50 hover:text-canopy-text transition-colors ${
                              canExpand ? "" : "invisible"
                            }`}
                          >
                            <ChevronRight
                              className={`w-3.5 h-3.5 transition-transform ${
                                isExpanded ? "rotate-90" : ""
                              }`}
                            />
                          </button>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            disabled={row.disabled}
                            onChange={() => toggleWorktree(row)}
                            ref={(el) => {
                              if (el) el.indeterminate = isPartial;
                            }}
                            aria-checked={isPartial ? "mixed" : allSelected}
                            aria-label={`Select all agents in ${row.branch}`}
                            data-testid={`bulk-worktree-checkbox-${row.id}`}
                            className="shrink-0"
                          />
                          <button
                            type="button"
                            onClick={() => !row.disabled && toggleWorktree(row)}
                            disabled={row.disabled}
                            className="flex-1 min-w-0 text-left text-sm text-canopy-text truncate"
                          >
                            {row.branch}
                          </button>
                          {StateIcon && (
                            <StateIcon className={`w-3.5 h-3.5 shrink-0 ${stateColor}`} />
                          )}
                          <span className="text-xs text-canopy-text/40 shrink-0">
                            {row.agentTerminalCount}{" "}
                            {row.agentTerminalCount === 1 ? "agent" : "agents"}
                          </span>
                        </div>
                        {canExpand && (
                          <div
                            className={`grid transition-[grid-template-rows] duration-200 ${
                              isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                            }`}
                          >
                            <div className="overflow-hidden">
                              <div className="pb-1.5 pl-7 pr-3 space-y-0.5">
                                {row.terminals.map((terminal, tIndex) => {
                                  const TStateIcon = terminal.agentState
                                    ? STATE_ICONS[terminal.agentState]
                                    : null;
                                  const tStateColor = terminal.agentState
                                    ? STATE_COLORS[terminal.agentState]
                                    : "";
                                  const tStateLabel = terminal.agentState
                                    ? STATE_LABELS[terminal.agentState]
                                    : "idle";
                                  const isSelected = selectedIds.has(terminal.id);
                                  return (
                                    <div
                                      key={terminal.id}
                                      role="row"
                                      aria-level={2}
                                      aria-posinset={tIndex + 1}
                                      aria-setsize={row.terminals.length}
                                      data-testid={`bulk-terminal-row-${terminal.id}`}
                                      className={`px-2 py-1 rounded-[var(--radius-md)] flex items-center gap-2 ${
                                        isSelected ? "bg-canopy-accent/10" : "hover:bg-tint/[0.04]"
                                      }`}
                                    >
                                      <div
                                        role="gridcell"
                                        className="flex items-center gap-2 flex-1 min-w-0"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={isSelected}
                                          onChange={() => toggleTerminal(terminal.id)}
                                          aria-label={`Select agent ${terminal.label}`}
                                          data-testid={`bulk-terminal-checkbox-${terminal.id}`}
                                          className="shrink-0"
                                          tabIndex={isExpanded ? 0 : -1}
                                        />
                                        <button
                                          type="button"
                                          onClick={() => toggleTerminal(terminal.id)}
                                          tabIndex={isExpanded ? 0 : -1}
                                          className="flex-1 min-w-0 text-left text-xs text-canopy-text/80 truncate"
                                        >
                                          {terminal.label}
                                        </button>
                                        {TStateIcon && (
                                          <TStateIcon
                                            className={`w-3 h-3 shrink-0 ${tStateColor}`}
                                          />
                                        )}
                                        <span className="text-[10px] text-canopy-text/40 shrink-0">
                                          {tStateLabel}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <span className="text-[10px] text-canopy-text/30 hidden sm:inline">
            ↑↓ Navigate &middot; Space Select &middot; ⌘↵ Send &middot; Esc Back
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-canopy-text/50">
              {selectedWorktreeCount} worktree{selectedWorktreeCount !== 1 ? "s" : ""},{" "}
              {selectedTerminalCount} agent{selectedTerminalCount !== 1 ? "s" : ""}
            </span>
            <button
              onClick={step === "preview" ? handleConfirm : handleSend}
              disabled={!canSend}
              className="px-3 py-1 text-xs rounded-[var(--radius-md)] bg-canopy-accent text-text-inverse hover:bg-canopy-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSending ? "Sending..." : actionLabel}
            </button>
          </div>
        </div>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
