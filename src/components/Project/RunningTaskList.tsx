import { useState, useEffect, useRef, useCallback } from "react";
import { X, Eye, RotateCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "@/store/terminalStore";
import { terminalClient } from "@/clients";
import { cn } from "@/lib/utils";
import type { TerminalInstance } from "@/types";

const MAX_VISIBLE = 5;
const AUTO_CLEAR_DELAY = 3000;

type TaskStatus = "running" | "success" | "failed" | "restarting";

function deriveTaskStatus(t: TerminalInstance): TaskStatus {
  if (t.isRestarting) return "restarting";
  if (t.runtimeStatus === "exited") {
    return t.exitCode === 0 ? "success" : "failed";
  }
  return "running";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

interface RunningTaskListProps {
  worktreeId: string;
}

export function RunningTaskList({ worktreeId }: RunningTaskListProps) {
  const quickRunTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.spawnedBy === "quickrun" &&
          t.worktreeId === worktreeId &&
          t.location !== "trash"
      )
    )
  );

  const activateTerminal = useTerminalStore((s) => s.activateTerminal);
  const restartTerminal = useTerminalStore((s) => s.restartTerminal);

  const [now, setNow] = useState(Date.now());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const autoClearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Tick for elapsed time — only active when there are running tasks
  const hasRunning = quickRunTerminals.some(
    (t) => deriveTaskStatus(t) === "running" || deriveTaskStatus(t) === "restarting"
  );

  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Auto-clear successful tasks after delay
  useEffect(() => {
    const timers = autoClearTimers.current;
    for (const t of quickRunTerminals) {
      const status = deriveTaskStatus(t);
      if (status === "success" && !dismissedIds.has(t.id) && !timers.has(t.id)) {
        const timer = setTimeout(() => {
          setDismissedIds((prev) => new Set(prev).add(t.id));
          timers.delete(t.id);
        }, AUTO_CLEAR_DELAY);
        timers.set(t.id, timer);
      }
    }

    return () => {
      for (const [id, timer] of timers) {
        if (!quickRunTerminals.some((t) => t.id === id)) {
          clearTimeout(timer);
          timers.delete(id);
        }
      }
    };
  }, [quickRunTerminals, dismissedIds]);

  // Clean dismissed IDs when terminals disappear from store
  useEffect(() => {
    const currentIds = new Set(quickRunTerminals.map((t) => t.id));
    setDismissedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      return next.size !== prev.size ? next : prev;
    });
  }, [quickRunTerminals]);

  const handleStop = useCallback((id: string) => {
    terminalClient.kill(id).catch(console.error);
  }, []);

  const handleFocus = useCallback(
    (id: string) => {
      activateTerminal(id);
    },
    [activateTerminal]
  );

  const handleRestart = useCallback(
    (id: string) => {
      restartTerminal(id);
    },
    [restartTerminal]
  );

  const handleDismiss = useCallback((id: string) => {
    setDismissedIds((prev) => new Set(prev).add(id));
  }, []);

  const visibleTasks = quickRunTerminals.filter((t) => !dismissedIds.has(t.id));

  if (visibleTasks.length === 0) return null;

  const displayTasks = visibleTasks.slice(0, MAX_VISIBLE);
  const overflowCount = visibleTasks.length - displayTasks.length;

  return (
    <div className="mb-2 space-y-0.5">
      {displayTasks.map((t) => {
        const status = deriveTaskStatus(t);
        return (
          <TaskRow
            key={t.id}
            terminal={t}
            status={status}
            now={now}
            onStop={handleStop}
            onFocus={handleFocus}
            onRestart={handleRestart}
            onDismiss={handleDismiss}
          />
        );
      })}
      {overflowCount > 0 && (
        <div className="text-[10px] text-canopy-text/30 px-2 py-0.5 font-sans">
          +{overflowCount} more
        </div>
      )}
    </div>
  );
}

interface TaskRowProps {
  terminal: TerminalInstance;
  status: TaskStatus;
  now: number;
  onStop: (id: string) => void;
  onFocus: (id: string) => void;
  onRestart: (id: string) => void;
  onDismiss: (id: string) => void;
}

function TaskRow({ terminal, status, now, onStop, onFocus, onRestart, onDismiss }: TaskRowProps) {
  const elapsed = terminal.startedAt ? now - terminal.startedAt : 0;
  const isActive = status === "running" || status === "restarting";
  const command = terminal.command || terminal.title;
  const truncatedCommand = command.length > 28 ? command.slice(0, 28) + "…" : command;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] text-[11px] font-mono group",
        "hover:bg-white/[0.04] transition-colors cursor-pointer",
        status === "failed" && "border-l-2 border-status-error",
        status === "success" && "opacity-60"
      )}
      onClick={() => onFocus(terminal.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus(terminal.id);
        }
      }}
    >
      {/* Status indicator */}
      <StatusDot status={status} />

      {/* Command */}
      <span className="flex-1 truncate text-canopy-text/70" title={command}>
        {truncatedCommand}
      </span>

      {/* Elapsed time */}
      {isActive && (
        <span className="text-[10px] text-canopy-text/30 tabular-nums shrink-0">
          {formatElapsed(elapsed)}
        </span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        {isActive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStop(terminal.id);
            }}
            className="p-0.5 rounded hover:bg-white/10 text-canopy-text/40 hover:text-status-error"
            aria-label="Stop task"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {status === "failed" && (
          <>
            {terminal.exitBehavior !== "restart" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestart(terminal.id);
                }}
                className="p-0.5 rounded hover:bg-white/10 text-canopy-text/40 hover:text-canopy-text"
                aria-label="Restart task"
              >
                <RotateCw className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(terminal.id);
              }}
              className="p-0.5 rounded hover:bg-white/10 text-canopy-text/40 hover:text-canopy-text"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onFocus(terminal.id);
          }}
          className="p-0.5 rounded hover:bg-white/10 text-canopy-text/40 hover:text-canopy-text"
          aria-label="Focus terminal"
        >
          <Eye className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 rounded-full shrink-0",
        status === "running" && "bg-status-success animate-agent-pulse",
        status === "restarting" && "bg-status-warning animate-agent-pulse",
        status === "success" && "bg-status-success",
        status === "failed" && "bg-status-error"
      )}
    />
  );
}
