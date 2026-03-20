import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { usePaletteStore } from "@/store/paletteStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { isAgentTerminal } from "@/utils/terminalType";
import { getDominantAgentState } from "@/components/Worktree/AgentStatusIndicator";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { terminalClient } from "@/clients";
import type { AgentState } from "@/types";
import type { TerminalInstance } from "@shared/types";

const PALETTE_ID = "bulk-command" as const;

export function openBulkCommandPalette(): void {
  usePaletteStore.getState().openPalette(PALETTE_ID);
}

type KeystrokePreset = "escape" | "enter" | "ctrl+c" | "double-escape";

interface WorktreeRow {
  id: string;
  branch: string;
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
        agentTerminalCount: eligible.length,
        dominantState,
        disabled: eligible.length === 0,
      });
    }
    return rows;
  }, [worktrees, terminals]);
}

export function BulkCommandPalette() {
  const isOpen = usePaletteStore((s) => s.activePaletteId === PALETTE_ID);
  const closePalette = useCallback(() => usePaletteStore.getState().closePalette(PALETTE_ID), []);

  const rows = useWorktreeRows();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"keystroke" | "text">("keystroke");
  const [keystrokePreset, setKeystrokePreset] = useState<KeystrokePreset>("escape");
  const [commandText, setCommandText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const doubleEscapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSelectedIds(new Set());
      setMode("keystroke");
      setKeystrokePreset("escape");
      setCommandText("");
      setIsSending(false);
      if (doubleEscapeTimerRef.current) {
        clearTimeout(doubleEscapeTimerRef.current);
        doubleEscapeTimerRef.current = null;
      }
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (doubleEscapeTimerRef.current) {
        clearTimeout(doubleEscapeTimerRef.current);
      }
    };
  }, []);

  const enabledRows = useMemo(() => rows.filter((r) => !r.disabled), [rows]);
  const allEnabledSelected =
    enabledRows.length > 0 && enabledRows.every((r) => selectedIds.has(r.id));

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

  const handleSend = useCallback(async () => {
    const targetIds = resolveTargetIds();
    if (targetIds.length === 0) return;

    setIsSending(true);

    if (mode === "keystroke") {
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
      const text = commandText.trim();
      if (!text) {
        setIsSending(false);
        return;
      }
      await Promise.allSettled(targetIds.map((id) => terminalClient.submit(id, text)));
      setIsSending(false);
      closePalette();
    }
  }, [mode, keystrokePreset, commandText, resolveTargetIds, closePalette]);

  const canSend =
    selectedIds.size > 0 && !isSending && (mode === "keystroke" || commandText.trim().length > 0);

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={closePalette} ariaLabel="Bulk Command Center">
      <AppPaletteDialog.Header label="Bulk Command Center">
        <div className="flex gap-1 mb-1">
          <button
            className={`px-3 py-1 text-xs rounded-[var(--radius-md)] transition-colors ${
              mode === "keystroke"
                ? "bg-canopy-accent text-white"
                : "bg-canopy-sidebar text-canopy-text/60 hover:text-canopy-text"
            }`}
            onClick={() => setMode("keystroke")}
          >
            Keystroke
          </button>
          <button
            className={`px-3 py-1 text-xs rounded-[var(--radius-md)] transition-colors ${
              mode === "text"
                ? "bg-canopy-accent text-white"
                : "bg-canopy-sidebar text-canopy-text/60 hover:text-canopy-text"
            }`}
            onClick={() => setMode("text")}
          >
            Text Command
          </button>
        </div>
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        {rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
            No non-main worktrees available
          </div>
        ) : (
          <>
            <button
              onClick={toggleAll}
              className="w-full text-left px-3 py-1.5 text-xs text-canopy-text/50 hover:text-canopy-text transition-colors"
            >
              {allEnabledSelected ? "Deselect All" : "Select All"}
            </button>
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
        ) : (
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
            placeholder="Enter command to send..."
            className="w-full px-3 py-2 text-sm bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] text-canopy-text placeholder:text-text-muted focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/20"
          />
        )}
      </div>

      <AppPaletteDialog.Footer>
        <div className="flex items-center justify-between w-full">
          <span className="text-xs text-canopy-text/50">
            {selectedIds.size} worktree{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="px-3 py-1 text-xs rounded-[var(--radius-md)] bg-canopy-accent text-white hover:bg-canopy-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        </div>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
