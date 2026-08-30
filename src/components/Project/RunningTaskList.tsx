import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, X, Eye, RotateCw } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { terminalClient } from "@/clients";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

const MAX_VISIBLE = 5;
const AUTO_CLEAR_DELAY = 3000;

type TaskStatus = "running" | "success" | "failed" | "restarting";

function deriveTaskStatus(t: PtyPanelData): TaskStatus {
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
  const quickRunTerminals = usePanelStore(
    useShallow((state) => {
      const result: PtyPanelData[] = [];
      for (const id of state.panelIds) {
        const panel = getNarrowPanel(state.panelsById, id);
        if (
          panel &&
          isPtyPanel(panel) &&
          panel.spawnedBy === "quickrun" &&
          panel.worktreeId === worktreeId &&
          panel.location !== "trash"
        ) {
          result.push(panel);
        }
      }
      return result;
    })
  );

  const activateTerminal = usePanelStore((s) => s.activateTerminal);
  const restartTerminal = usePanelStore((s) => s.restartTerminal);

  const [now, setNow] = useState(Date.now());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const autoClearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Tick for elapsed time — only active when there are running tasks
  const hasRunning = quickRunTerminals.some(
    (t) => deriveTaskStatus(t) === "running" || deriveTaskStatus(t) === "restarting"
  );

  // Per-component visibility-aware tick; only runs while tasks are active and
  // pauses while the document is hidden.
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000, hasRunning);

  // Auto-clear successful tasks after delay, and clear dismiss/timers on restart
  useEffect(() => {
    const timers = autoClearTimers.current;
    for (const t of quickRunTerminals) {
      const status = deriveTaskStatus(t);

      // If a terminal is running/restarting again (was restarted), clear its dismiss state and timer
      if (status === "running" || status === "restarting") {
        if (dismissedIds.has(t.id)) {
          setDismissedIds((prev) => {
            const next = new Set(prev);
            next.delete(t.id);
            return next;
          });
        }
        const existingTimer = timers.get(t.id);
        if (existingTimer) {
          clearTimeout(existingTimer);
          timers.delete(t.id);
        }
        continue;
      }

      if (status === "success" && !dismissedIds.has(t.id) && !timers.has(t.id)) {
        const timer = setTimeout(() => {
          setDismissedIds((prev) => new Set(prev).add(t.id));
          timers.delete(t.id);
        }, AUTO_CLEAR_DELAY);
        timers.set(t.id, timer);
      }
    }

    return () => {
      // On unmount or dependency change, clear all timers
      for (const [, timer] of timers) {
        clearTimeout(timer);
      }
      timers.clear();
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
    terminalClient.kill(id).catch((err) => logError("Failed to kill terminal", err));
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
  const overflowTasks = visibleTasks.slice(MAX_VISIBLE);

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
      {overflowTasks.length > 0 && (
        <TaskOverflow
          tasks={overflowTasks}
          now={now}
          onStop={handleStop}
          onFocus={handleFocus}
          onRestart={handleRestart}
          onDismiss={handleDismiss}
        />
      )}
    </div>
  );
}

/**
 * The tasks past the visible cap.
 *
 * This used to be "+N more" as static text, which named running processes the
 * user could then neither watch, stop, nor restart — every handler the rows
 * need was already in scope, only the rows weren't rendered (#12001). Mounted
 * only while a tail exists, so the popover can't reopen against a stale one
 * after the list shrinks.
 */
function TaskOverflow({
  tasks,
  now,
  onStop,
  onFocus,
  onRestart,
  onDismiss,
}: {
  tasks: PtyPanelData[];
  now: number;
  onStop: (id: string) => void;
  onFocus: (id: string) => void;
  onRestart: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        data-testid="running-task-overflow"
        // Deliberately not an enumeration of every hidden command: a task
        // command is an arbitrary-length string, and concatenating several
        // makes focusing this button read a paragraph before its state. The
        // popover is labelled and exposes the rows themselves once opened.
        aria-label={`Show ${tasks.length} more running ${tasks.length === 1 ? "task" : "tasks"}`}
        className={cn(
          "flex w-full items-center gap-0.5 px-2 py-0.5 rounded-[var(--radius-sm)] text-3xs font-sans transition-colors",
          "text-text-secondary hover:text-text-primary hover:bg-tint/[0.04]",
          "outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        )}
      >
        {tasks.length} more
        <ChevronDown className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-label="More running tasks"
        className="p-1 min-w-64 max-w-sm max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
      >
        <ul className="flex flex-col gap-0.5">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskRow
                terminal={t}
                status={deriveTaskStatus(t)}
                now={now}
                // Focusing a terminal moves the user out of this surface, so
                // the popover has nothing left to anchor; stop, restart and
                // dismiss all keep it open so several can be handled in a row.
                onStop={onStop}
                onFocus={(id) => {
                  setOpen(false);
                  onFocus(id);
                }}
                onRestart={onRestart}
                onDismiss={onDismiss}
              />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

interface TaskRowProps {
  terminal: PtyPanelData;
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
        "flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-sm)] text-2xs font-mono group",
        "hover:bg-tint/[0.04] transition-colors cursor-pointer",
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
      <span className="flex-1 truncate text-text-secondary" title={command}>
        {truncatedCommand}
      </span>

      {/* Elapsed time */}
      {isActive && (
        <span className="text-3xs text-text-placeholder tabular-nums shrink-0">
          {formatElapsed(elapsed)}
        </span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
        {isActive && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStop(terminal.id);
            }}
            className="p-0.5 rounded hover:bg-tint/10 text-daintree-text/40 hover:text-status-error"
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
                className="p-0.5 rounded hover:bg-tint/10 text-daintree-text/40 hover:text-text-primary"
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
              className="p-0.5 rounded hover:bg-tint/10 text-daintree-text/40 hover:text-text-primary"
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
          className="p-0.5 rounded hover:bg-tint/10 text-daintree-text/40 hover:text-text-primary"
          aria-label="Focus terminal"
        >
          <Eye className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Running",
  restarting: "Restarting",
  success: "Finished",
  failed: "Failed",
};

function StatusDot({ status }: { status: TaskStatus }) {
  return (
    <span
      role="img"
      aria-label={TASK_STATUS_LABEL[status]}
      className={cn(
        "status-mark h-1.5 w-1.5 rounded-full shrink-0",
        status === "running" && "bg-activity-working animate-activity-pulse",
        status === "restarting" && "bg-status-warning animate-activity-pulse",
        status === "success" && "bg-status-success",
        status === "failed" && "bg-status-error"
      )}
    />
  );
}
