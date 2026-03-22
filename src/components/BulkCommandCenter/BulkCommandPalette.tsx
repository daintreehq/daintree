import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { usePaletteStore } from "@/store/paletteStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useRecipeStore } from "@/store/recipeStore";
import { isAgentTerminal } from "@/utils/terminalType";
import { getDominantAgentState } from "@/components/Worktree/AgentStatusIndicator";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import {
  replaceRecipeVariables,
  detectUnresolvedVariables,
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

interface WorktreeRow {
  id: string;
  branch: string;
  path: string;
  issueNumber?: number;
  prNumber?: number;
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

interface StatePreset {
  label: string;
  match: (row: WorktreeRow) => boolean;
}

const STATE_PRESETS: StatePreset[] = [
  {
    label: "Active",
    match: (r) => r.dominantState === "working" || r.dominantState === "running",
  },
  { label: "Waiting", match: (r) => r.dominantState === "waiting" },
  { label: "Idle", match: (r) => r.dominantState === null && !r.disabled },
  { label: "Completed", match: (r) => r.dominantState === "completed" },
  { label: "Failed", match: (r) => r.dominantState === "failed" },
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
  const worktrees = useWorktreeDataStore((s) => s.worktrees);
  const terminals = useTerminalStore((s) => s.terminals);

  return useMemo(() => {
    const rows: WorktreeRow[] = [];
    for (const wt of worktrees.values()) {
      if (wt.isMainWorktree) continue;
      const eligible = getEligibleTerminals(terminals, wt.id);
      const dominantState = getDominantAgentState(eligible.map((t) => t.agentState));
      rows.push({
        id: wt.id,
        branch: wt.branch ?? wt.name,
        path: wt.path,
        issueNumber: wt.issueNumber,
        prNumber: wt.prNumber,
        agentTerminalCount: eligible.length,
        dominantState,
        disabled: eligible.length === 0,
      });
    }
    return rows;
  }, [worktrees, terminals]);
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<BulkMode>("keystroke");
  const [step, setStep] = useState<BulkStep>("select");
  const [keystrokePreset, setKeystrokePreset] = useState<KeystrokePreset>("escape");
  const [commandText, setCommandText] = useState("");
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const doubleEscapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<PQueue | null>(null);

  const projectRecipes = useRecipeStore((s) => s.recipes.filter((r) => r.worktreeId === undefined));

  useEffect(() => {
    return () => {
      if (doubleEscapeTimerRef.current) {
        clearTimeout(doubleEscapeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setStep("select");
  }, [mode]);

  const enabledRows = useMemo(() => rows.filter((r) => !r.disabled), [rows]);
  const allEnabledSelected =
    enabledRows.length > 0 && enabledRows.every((r) => selectedIds.has(r.id));

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds]
  );

  const toggleWorktree = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allEnabledSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(enabledRows.map((r) => r.id)));
    }
  }, [allEnabledSelected, enabledRows]);

  const applyPreset = useCallback(
    (preset: StatePreset) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const row of rows) {
          if (!row.disabled && preset.match(row)) {
            next.add(row.id);
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
    const terminals = useTerminalStore.getState().terminals;
    const ids: string[] = [];
    for (const worktreeId of selectedIds) {
      for (const t of getEligibleTerminals(terminals, worktreeId)) {
        ids.push(t.id);
      }
    }
    return ids;
  }, [selectedIds]);

  const handlePreview = useCallback(() => {
    if (mode === "keystroke") return;
    setStep("preview");
  }, [mode]);

  const handleConfirm = useCallback(async () => {
    setIsSending(true);

    if (mode === "text") {
      const terminals = useTerminalStore.getState().terminals;
      const promises: Promise<unknown>[] = [];
      for (const row of selectedRows) {
        const ctx = buildRecipeContext(row);
        const resolved = replaceRecipeVariables(commandText, ctx);
        if (!resolved.trim()) continue;
        const eligible = getEligibleTerminals(terminals, row.id);
        for (const t of eligible) {
          promises.push(terminalClient.submit(t.id, resolved));
        }
      }
      await Promise.allSettled(promises);
    } else if (mode === "recipe" && selectedRecipeId) {
      const queue = new PQueue({ concurrency: 2 });
      queueRef.current = queue;
      const tasks = selectedRows.map(
        (row) => () =>
          useRecipeStore
            .getState()
            .runRecipeWithResults(selectedRecipeId, row.path, row.id, buildRecipeContext(row))
            .catch((err) => console.error(`Recipe broadcast failed for ${row.branch}:`, err))
      );
      await queue.addAll(tasks);
      queueRef.current = null;
    }

    setIsSending(false);
    closePalette();
  }, [mode, selectedRows, commandText, selectedRecipeId, closePalette]);

  const handleSend = useCallback(async () => {
    if (mode === "keystroke") {
      const targetIds = resolveTargetIds();
      if (targetIds.length === 0) return;
      setIsSending(true);

      if (keystrokePreset === "double-escape") {
        targetIds.forEach((id) => terminalClient.sendKey(id, "escape"));
        doubleEscapeTimerRef.current = setTimeout(() => {
          doubleEscapeTimerRef.current = null;
          const freshTargetIds = resolveTargetIds();
          freshTargetIds.forEach((id) => terminalClient.sendKey(id, "escape"));
          setIsSending(false);
          closePalette();
        }, 1000);
      } else {
        const key = KEYSTROKE_KEYS[keystrokePreset];
        targetIds.forEach((id) => terminalClient.sendKey(id, key));
        setIsSending(false);
        closePalette();
      }
    } else {
      handlePreview();
    }
  }, [mode, keystrokePreset, resolveTargetIds, closePalette, handlePreview]);

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
    <AppPaletteDialog isOpen onClose={closePalette} ariaLabel="Bulk Command Center">
      <AppPaletteDialog.Header label="Bulk Command Center">
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
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
            No non-main worktrees available
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
              {STATE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => applyPreset(preset)}
                  className="px-1.5 py-0.5 text-[10px] rounded-[var(--radius-sm)] border border-canopy-border text-canopy-text/50 hover:text-canopy-text hover:border-canopy-text/30 transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {rows.map((row) => {
              const StateIcon = row.dominantState ? STATE_ICONS[row.dominantState] : null;
              const stateColor = row.dominantState ? STATE_COLORS[row.dominantState] : "";
              return (
                <button
                  key={row.id}
                  onClick={() => !row.disabled && toggleWorktree(row.id)}
                  disabled={row.disabled}
                  className={`w-full text-left px-3 py-2 rounded-[var(--radius-lg)] border transition-colors flex items-center gap-2 ${
                    row.disabled
                      ? "opacity-40 cursor-not-allowed border-transparent"
                      : selectedIds.has(row.id)
                        ? "border-canopy-accent/40 bg-canopy-accent/10"
                        : "border-transparent hover:bg-tint/[0.06]"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    disabled={row.disabled}
                    onChange={() => {}}
                    className="pointer-events-none shrink-0"
                    tabIndex={-1}
                  />
                  <span className="flex-1 text-sm text-canopy-text truncate">{row.branch}</span>
                  {StateIcon && <StateIcon className={`w-3.5 h-3.5 shrink-0 ${stateColor}`} />}
                  <span className="text-xs text-canopy-text/40 shrink-0">
                    {row.agentTerminalCount} {row.agentTerminalCount === 1 ? "agent" : "agents"}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </AppPaletteDialog.Body>

      <div className="px-3 py-2 border-t border-canopy-border">
        {mode === "keystroke" ? (
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
        ) : mode === "text" ? (
          <div>
            <input
              type="text"
              value={commandText}
              onChange={(e) => setCommandText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSend) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Enter command to send... (supports {{issue_number}}, {{branch_name}}, etc.)"
              className="w-full px-3 py-2 text-sm bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] text-canopy-text placeholder:text-text-muted focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/20"
            />
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

      <AppPaletteDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <span className="text-xs text-canopy-text/50">
            {selectedIds.size} worktree{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            onClick={step === "preview" ? handleConfirm : handleSend}
            disabled={!canSend}
            className="px-3 py-1 text-xs rounded-[var(--radius-md)] bg-canopy-accent text-text-inverse hover:bg-canopy-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSending ? "Sending..." : actionLabel}
          </button>
        </div>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
