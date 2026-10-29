import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheck, CircleDashed, CircleSlash, RefreshCw, X } from "lucide-react";
import type {
  PluginTask,
  PluginTaskListProps,
  PluginTaskStatus,
} from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { useNow } from "../../../packages/plugin-sdk/src/react/useNow";
import { useKitOverlayZClass } from "./kitScope";
import { PROGRAMMATIC_FOCUS_RING } from "./kitPaneShared";
import { field, fn, hasContent, node, nonEmpty, oneOf, pickRootProps, str } from "./kitProps";
import { toTimestamp } from "./kitTime";

const ErrorGlyph = SEVERITY_GLYPH.error;

const TASK_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;

const TASK_WORD: Record<PluginTaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Summary order: what is moving, what is waiting, what needs a look, then
// what has settled.
const TASK_SUMMARY_ORDER: PluginTaskStatus[] = [
  "running",
  "pending",
  "failed",
  "done",
  "cancelled",
];

interface TaskEntry {
  task: PluginTask;
  id: string;
  title: string;
  status: PluginTaskStatus;
  progress: number | null;
  started: number;
  finished: number;
  retryable: boolean;
  cancellable: boolean;
}

function readTasks(tasks: unknown, canRetry: boolean, canCancel: boolean): TaskEntry[] {
  if (!Array.isArray(tasks)) return [];
  const seen = new Set<string>();
  const out: TaskEntry[] = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const id = nonEmpty(field(task, "id"));
    const status = oneOf(field(task, "status"), TASK_STATUSES);
    if (id === undefined || status === undefined || seen.has(id)) continue;
    seen.add(id);
    const progress = field(task, "progress");
    const retryable = field(task, "retryable");
    const cancellable = field(task, "cancellable");
    out.push({
      task,
      id,
      title: str(field(task, "title")) ?? "",
      status,
      progress:
        typeof progress === "number" && Number.isFinite(progress)
          ? Math.min(1, Math.max(0, progress))
          : null,
      started: toTimestamp(field(task, "startedAt")),
      finished: toTimestamp(field(task, "finishedAt")),
      retryable:
        canRetry &&
        (status === "failed" || status === "cancelled") &&
        (typeof retryable === "boolean" ? retryable : true),
      cancellable:
        canCancel &&
        (status === "pending" || status === "running") &&
        (typeof cancellable === "boolean" ? cancellable : true),
    });
  }
  return out;
}

/** "2 running · 1 failed · 5 done", in the order a reader acts on. Exported for tests. */
export function taskSummary(statuses: readonly PluginTaskStatus[]): string {
  const counts = new Map<PluginTaskStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return TASK_SUMMARY_ORDER.filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${counts.get(status)} ${TASK_WORD[status].toLowerCase()}`)
    .join(" · ");
}

// Settled work is demoted to neutral (docs/themes/status-success-policy.md):
// only a failure keeps a status colour.
function TaskGlyph({ status }: { status: PluginTaskStatus }) {
  const glyph = "h-3.5 w-3.5 shrink-0";
  switch (status) {
    case "running":
      return <Spinner size="sm" className="text-text-secondary" />;
    case "pending":
      return <CircleDashed aria-hidden="true" className={cn(glyph, "text-text-secondary")} />;
    case "done":
      return <CircleCheck aria-hidden="true" className={cn(glyph, "text-text-secondary")} />;
    case "failed":
      return <ErrorGlyph aria-hidden="true" className={cn(glyph, "text-status-error")} />;
    case "cancelled":
      return <CircleSlash aria-hidden="true" className={cn(glyph, "text-text-secondary")} />;
  }
}

function taskDuration(entry: TaskEntry, now: number): string | null {
  if (Number.isNaN(entry.started)) return null;
  if (entry.status === "running") return formatElapsedDuration(Math.max(0, now - entry.started));
  if (entry.status === "pending" || Number.isNaN(entry.finished)) return null;
  return formatElapsedDuration(Math.max(0, entry.finished - entry.started));
}

/** What a change of state says, for the list's live region; nothing while it moves. */
function taskOutcome(title: string, status: PluginTaskStatus): string | null {
  const name = title || "Task";
  if (status === "done") return `${name} finished`;
  if (status === "failed") return `${name} failed`;
  if (status === "cancelled") return `${name} cancelled`;
  return null;
}

/**
 * What changed between two renders of a task list, from the snapshot the
 * list serialises: each task's state now, and the outcomes worth saying.
 * Nothing is news on the first render. Exported for tests.
 */
export function taskNews(
  snapshot: string,
  previous: ReadonlyMap<string, PluginTaskStatus> | null
): { statuses: Map<string, PluginTaskStatus>; news: string; changed: boolean } {
  const statuses = new Map<string, PluginTaskStatus>();
  const messages: string[] = [];
  const rows: unknown = JSON.parse(snapshot);
  let changed = false;
  if (!Array.isArray(rows)) return { statuses, news: "", changed };
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const id: unknown = row[0];
    const status = oneOf(row[1], TASK_STATUSES);
    const name: unknown = row[2];
    if (typeof id !== "string" || status === undefined) continue;
    statuses.set(id, status);
    const before = previous?.get(id);
    if (before === undefined || before === status) continue;
    changed = true;
    const message = taskOutcome(typeof name === "string" ? name : "", status);
    if (message) messages.push(message);
  }
  return { statuses, news: messages.join(". "), changed };
}

/** An icon-only row action: a 24px ghost button with its name as the tooltip. */
function TaskAction({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const overlayZ = useKitOverlayZClass();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className="shrink-0 [&_svg]:size-3.5"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={overlayZ}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export function KitTaskList({
  tasks,
  "aria-label": ariaLabel,
  title,
  summary,
  actions,
  onRetry,
  onCancel,
  empty,
  className,
  ...rest
}: PluginTaskListProps) {
  const overlayZ = useKitOverlayZClass();
  const retry = fn(onRetry);
  const cancel = fn(onCancel);
  const entries = readTasks(tasks, retry !== undefined, cancel !== undefined);
  const ticking = entries.some(
    (entry) => entry.status === "running" && !Number.isNaN(entry.started)
  );
  // A second's clock only while something is running with a start time.
  const now = useNow({ intervalMs: ticking ? 1000 : 60_000 });
  const showSummary = summary !== false;
  const line = taskSummary(entries.map((entry) => entry.status));
  const hasHeader = hasContent(title) || (showSummary && line !== "") || hasContent(actions);
  // One action at most per row (Retry once settled, Cancel before), so one
  // reserved slot keeps every duration in a single column.
  const hasActions = entries.some((entry) => entry.retryable || entry.cancellable);
  const signature = entries.map((entry) => `${entry.id}:${entry.status}`).join("|");

  const listRef = useRef<HTMLUListElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const focusedTask = useRef<string | null>(null);
  const seen = useRef<Map<string, PluginTaskStatus> | null>(null);
  const [spoken, setSpoken] = useState("");

  // A row's action goes away as its task moves on (Cancel once it finishes,
  // Retry once it restarts): focus it held stays on that task's row.
  useLayoutEffect(() => {
    const id = focusedTask.current;
    if (id === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const list = listRef.current;
    const row = list
      ? [...list.querySelectorAll<HTMLElement>("[data-task-id]")].find(
          (candidate) => candidate.dataset.taskId === id
        )
      : undefined;
    // The last task gone takes the list with it: the section is what is left.
    (row ?? list ?? sectionRef.current)?.focus({ preventScroll: true });
    if (!list) focusedTask.current = null;
  }, [signature]);

  // Outcomes only: a task settling is news, its ticking time and progress are
  // not. The snapshot changes exactly when a task's state does.
  const snapshot = JSON.stringify(entries.map((entry) => [entry.id, entry.status, entry.title]));
  useEffect(() => {
    const { statuses, news, changed } = taskNews(snapshot, seen.current);
    seen.current = statuses;
    // A task moving on without news (a retry starting) clears the last
    // outcome, so the same outcome a second time is spoken again.
    if (news !== "") setSpoken(news);
    else if (changed) setSpoken("");
  }, [snapshot]);

  return (
    <section
      {...pickRootProps(rest)}
      ref={sectionRef}
      tabIndex={-1}
      aria-label={nonEmpty(ariaLabel)}
      data-task-list=""
      className={cn("flex min-w-0 flex-col", PROGRAMMATIC_FOCUS_RING, str(className))}
    >
      {hasHeader ? (
        <div className="flex h-7 shrink-0 items-center gap-2 pr-1.5 pl-3">
          {hasContent(title) ? (
            <h3 className={cn(SECTION_LABEL_CLASS, "m-0 shrink-0")}>{node(title)}</h3>
          ) : null}
          {showSummary && line !== "" ? (
            <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary tabular-nums">
              {line}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {hasContent(actions) ? (
            <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
          ) : null}
        </div>
      ) : null}
      {entries.length === 0 ? (
        hasContent(empty) ? (
          <div className="px-3 py-2 text-xs text-text-secondary">{node(empty)}</div>
        ) : null
      ) : (
        <ul
          ref={listRef}
          tabIndex={-1}
          aria-label={nonEmpty(ariaLabel)}
          onFocus={(event) => {
            const row =
              event.target instanceof HTMLElement
                ? event.target.closest<HTMLElement>("[data-task-id]")
                : null;
            focusedTask.current = row?.dataset.taskId ?? null;
          }}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next !== null && !event.currentTarget.contains(next)) focusedTask.current = null;
          }}
          className={cn("m-0 flex list-none flex-col p-0", PROGRAMMATIC_FOCUS_RING)}
        >
          {entries.map((entry) => {
            const duration = taskDuration(entry, now);
            const detail = field(entry.task, "detail");
            const showBar = entry.status === "running" && entry.progress !== null;
            const name = entry.title || "task";
            return (
              <li
                key={entry.id}
                tabIndex={-1}
                data-task-id={entry.id}
                data-task-status={entry.status}
                className={cn(
                  "flex min-h-8 min-w-0 items-start gap-2 py-1 pl-3",
                  hasActions ? "pr-1.5" : "pr-3",
                  PROGRAMMATIC_FOCUS_RING
                )}
              >
                <span className="flex h-6 w-3.5 shrink-0 items-center justify-center">
                  <TaskGlyph status={entry.status} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
                  <TruncatedTooltip content={entry.title} contentClassName={overlayZ}>
                    <span className="min-w-0 truncate text-xs leading-4 text-text-primary">
                      <span className="sr-only">{TASK_WORD[entry.status]}: </span>
                      {entry.title}
                    </span>
                  </TruncatedTooltip>
                  {hasContent(detail) ? (
                    <TruncatedTooltip content={node(detail)} contentClassName={overlayZ}>
                      <div className="min-w-0 truncate text-2xs text-text-secondary">
                        {node(detail)}
                      </div>
                    </TruncatedTooltip>
                  ) : null}
                  {showBar ? (
                    <ProgressBar
                      value={Math.round((entry.progress ?? 0) * 100)}
                      label={entry.title || "Progress"}
                      size="thin"
                      className="mt-1"
                    />
                  ) : null}
                </div>
                <span className="flex h-6 shrink-0 items-center text-2xs text-text-secondary tabular-nums">
                  {duration}
                </span>
                {hasActions ? (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                    {entry.retryable ? (
                      <TaskAction
                        label={`Retry ${name}`}
                        tooltip="Retry"
                        onClick={() => retry?.(entry.task)}
                      >
                        <RefreshCw aria-hidden="true" />
                      </TaskAction>
                    ) : entry.cancellable ? (
                      <TaskAction
                        label={`Cancel ${name}`}
                        tooltip="Cancel"
                        onClick={() => cancel?.(entry.task)}
                      >
                        <X aria-hidden="true" />
                      </TaskAction>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <span role="status" className="sr-only">
        {spoken}
      </span>
    </section>
  );
}
