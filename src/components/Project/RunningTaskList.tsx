import { useState, useEffect, useCallback } from "react";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { ChevronDown, X, Eye, RotateCw } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { terminalClient } from "@/clients";
import { cn } from "@/lib/utils";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { logError } from "@/utils/logger";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

const MAX_VISIBLE = 5;

type TaskStatus = "running" | "success" | "failed" | "restarting";

function deriveTaskStatus(t: PtyPanelData): TaskStatus {
  if (t.isRestarting) return "restarting";
  if (t.runtimeStatus === "exited") {
    return t.exitCode === 0 ? "success" : "failed";
  }
  return "running";
}

/**
 * Dismissed task ids for this renderer's session. Each project has its own view
 * and V8 context, so this is already per project; ids are pruned as their
 * panels go away.
 */
let sessionDismissedIds: ReadonlySet<string> = new Set();

/** Tests seed the same panel ids in every case; real ids are never reused. */
export function resetDismissedTasks(): void {
  sessionDismissedIds = new Set();
}

interface RunningTaskListProps {
  worktreeId: string;
  /** Where focus goes when a dismissal leaves no task to land on. */
  onFocusFallback?: (options: FocusOptions) => void;
}

export function RunningTaskList({ worktreeId, onFocusFallback }: RunningTaskListProps) {
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
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => sessionDismissedIds);
  // The list unmounts whenever Quick Run is collapsed; a dismissal has to
  // outlive that or collapsing and reopening brings every dismissed row back.
  useEffect(() => {
    sessionDismissedIds = dismissedIds;
  }, [dismissedIds]);

  // Tick for elapsed time — only active when there are running tasks
  const hasRunning = quickRunTerminals.some(
    (t) => deriveTaskStatus(t) === "running" || deriveTaskStatus(t) === "restarting"
  );

  // Per-component visibility-aware tick; only runs while tasks are active and
  // pauses while the document is hidden.
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000, hasRunning);

  // A dismissed task that is restarted is live again, so it comes back.
  //
  // Finished tasks used to clear themselves after three seconds, which took
  // the one-step route to a quick command's output away before the user had
  // looked back. They stay now, quietly, until dismissed or pushed into
  // "earlier" by newer launches.
  useEffect(() => {
    const revived = quickRunTerminals.filter((t) => {
      const status = deriveTaskStatus(t);
      return (status === "running" || status === "restarting") && dismissedIds.has(t.id);
    });
    if (revived.length === 0) return;
    setDismissedIds((prev) => {
      const next = new Set(prev);
      for (const t of revived) next.delete(t.id);
      return next;
    });
  }, [quickRunTerminals, dismissedIds]);

  // Forget dismissals only for panels that are gone from the renderer
  // altogether. Pruning against this worktree's tasks dropped every other
  // worktree's dismissals the moment the user switched away.
  const allPanelIds = usePanelStore((s) => s.panelIds);
  useEffect(() => {
    const currentIds = new Set(allPanelIds);
    setDismissedIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      return next.size !== prev.size ? next : prev;
    });
  }, [allPanelIds]);

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

  // Dismissing unmounts the button that held focus, which dropped it on the
  // page. Hand it to the neighbouring task — or back to the field — first.
  const handleDismissFrom = (id: string, from: HTMLElement, keyboard: boolean) => {
    if (document.activeElement === from) {
      const row = from.closest("[data-task-row]");
      const rows = Array.from(
        row?.closest("[data-task-list]")?.querySelectorAll<HTMLElement>("[data-task-row]") ?? []
      );
      const at = rows.findIndex((r) => r === row);
      const next = rows[at + 1] ?? rows[at - 1];
      const options = { preventScroll: true, focusVisible: keyboard };
      const target = next?.querySelector<HTMLElement>("[data-task-focus]");
      if (target) {
        // Focus follows the dismissal; it is not asking for the command's full text.
        armTooltipFocusSuppression();
        target.focus(options);
      } else onFocusFallback?.(options);
    }
    handleDismiss(id);
  };

  const visibleTasks = quickRunTerminals.filter((t) => !dismissedIds.has(t.id));

  if (visibleTasks.length === 0) return null;

  // The newest launches keep the visible slots and the oldest spill into the
  // overflow. Taking the first five in panel order put the task a user had
  // just started behind "N more" — the one row they had come to find. Launch
  // order stays top to bottom, so the newest sits nearest the field it came from.
  const overflowTasks = visibleTasks.slice(0, Math.max(0, visibleTasks.length - MAX_VISIBLE));
  const displayTasks = visibleTasks.slice(overflowTasks.length);

  return (
    <div data-task-list="" className="-mx-2 mb-2 space-y-0.5">
      {overflowTasks.length > 0 && (
        <TaskOverflow
          tasks={overflowTasks}
          now={now}
          onStop={handleStop}
          onFocus={handleFocus}
          onRestart={handleRestart}
          onDismiss={handleDismissFrom}
        />
      )}
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
            onDismiss={handleDismissFrom}
          />
        );
      })}
    </div>
  );
}

/**
 * The older tasks past the visible cap, above the rows they preceded.
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
  onDismiss: (id: string, from: HTMLElement, keyboard: boolean) => void;
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
        aria-label={`Show ${tasks.length} earlier ${tasks.length === 1 ? "task" : "tasks"}`}
        className={cn(
          "flex w-full min-h-6 items-center gap-0.5 px-2 rounded-[var(--radius-sm)] text-3xs font-sans transition-colors",
          "text-text-secondary hover:text-text-primary hover:bg-overlay-subtle cursor-pointer",
          "outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
        )}
      >
        {tasks.length} earlier
        <ChevronDown className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Earlier tasks"
        className="p-1 min-w-64 max-w-sm max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
      >
        <ul data-task-list="" className="flex flex-col gap-0.5">
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
  onDismiss: (id: string, from: HTMLElement, keyboard: boolean) => void;
}

function TaskRow({ terminal, status, now, onStop, onFocus, onRestart, onDismiss }: TaskRowProps) {
  const elapsed = terminal.startedAt ? now - terminal.startedAt : 0;
  const isActive = status === "running" || status === "restarting";
  const command = terminal.command || terminal.title;

  return (
    // The row used to be a `role="button"` wrapping these action buttons, which
    // is both an invalid content model and a live trap: the inner buttons only
    // stopped propagation on click, so an Enter on Stop bubbled to the row's
    // handler, got `preventDefault()`ed, and focused the terminal instead of
    // stopping it. The row is now a plain container and the command label is the
    // button, so every action is a sibling and owns its own keys.
    <div
      data-task-row={terminal.id}
      className={cn(
        "flex items-center gap-1.5 px-2 rounded-[var(--radius-sm)] text-2xs font-mono group",
        "hover:bg-overlay-subtle transition-colors"
      )}
    >
      {/* Status indicator */}
      <StatusDot status={status} />

      {/* Command */}
      <TruncatedTooltip content={command}>
        <button
          type="button"
          data-task-focus=""
          onClick={() => onFocus(terminal.id)}
          className="flex-1 min-h-6 truncate text-left text-text-secondary hover:text-text-primary transition-colors cursor-pointer min-w-0 rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        >
          {command}
        </button>
      </TruncatedTooltip>

      {/* Elapsed time */}
      {/* Elapsed time and the failure word trade places with the actions on
          hover or focus. The actions used to sit at opacity 0 and keep their
          width, which pushed the time into the middle of the row and cut the
          command to a letter at the 200px floor. */}
      {status === "running" && (
        <span className="text-3xs text-text-secondary tabular-nums shrink-0 group-hover:hidden group-focus-within:hidden">
          {formatElapsedDuration(elapsed)}
        </span>
      )}
      {/* Failure in words, where the elapsed time sat while it ran. A red dot
          alone leaves it to colour, and the left border that used to mark the
          row curved with the row's radius into a stray "(". */}
      {/* Restarting and finished say so in words too. Restarting used to show
          only an elapsed time beside an amber dot, reading as one more running
          row, and a finished row faded as a whole, taking its command below the
          text contrast floor. */}
      {(status === "failed" || status === "success" || status === "restarting") && (
        <span className="text-3xs text-text-secondary shrink-0 group-hover:hidden group-focus-within:hidden">
          {TASK_STATUS_LABEL[status]}
        </span>
      )}

      {/* Actions */}
      <div className="hidden items-center gap-0.5 shrink-0 group-hover:flex group-focus-within:flex">
        {isActive && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop(terminal.id);
                }}
                className="[&_svg]:size-3.5 hover:text-status-error"
                aria-label="Stop task"
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Stop task</TooltipContent>
          </Tooltip>
        )}
        {status === "failed" && terminal.exitBehavior !== "restart" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onRestart(terminal.id);
                }}
                className="[&_svg]:size-3.5"
                aria-label="Restart task"
              >
                <RotateCw aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Restart task</TooltipContent>
          </Tooltip>
        )}
        {(status === "failed" || status === "success") && (
          <DismissButton
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(terminal.id, e.currentTarget, e.detail === 0);
            }}
            aria-label="Dismiss task"
          />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                onFocus(terminal.id);
              }}
              className="[&_svg]:size-3.5"
              aria-label="Focus terminal"
            >
              <Eye aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Focus terminal</TooltipContent>
        </Tooltip>
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
