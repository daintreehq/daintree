import { useState } from "react";
import type { PluginTaskSnapshot } from "@shared/types/plugin";
import { pluginClient } from "@/clients";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { ARIA_DISABLED_INERT_CLASSES } from "@/components/ui/ariaDisabled";
import { logError } from "@/utils/logger";

/** Where the task stands, in words: its share done, or the state that replaced its bar. */
function taskStatus(task: PluginTaskSnapshot): string | null {
  if (task.state === "interrupted") return "Interrupted";
  if (task.state === "cancelling") return "Cancelling…";
  return task.fraction !== null ? `${Math.round(task.fraction * 100)}%` : null;
}

/**
 * A Cancel or Dismiss the user asked for, against the state the task was in
 * then. Once the task moves on — to cancelling, or interrupted — the row says
 * that instead, so the request stops counting.
 */
interface TaskRequest {
  kind: "cancel" | "dismiss";
  state: PluginTaskSnapshot["state"];
  failed: boolean;
}

function PluginTaskRow({ task }: { task: PluginTaskSnapshot }) {
  const [request, setRequest] = useState<TaskRequest | null>(null);
  const live = request !== null && request.state === task.state ? request : null;
  const asking = live !== null && !live.failed;
  const cancelling = task.state === "cancelling" || (asking && live.kind === "cancel");
  const status = cancelling ? "Cancelling…" : taskStatus(task);
  // The plugin's name always leads: every word on the row after the title is
  // the plugin's own, and this is what says whose.
  const context = task.detail ? `${task.pluginName} · ${task.detail}` : task.pluginName;

  // `false` is a real answer — the host refused, or the task wasn't in a state
  // to take it — and so is a rejected call. Either way the row says so: one
  // that looks untouched reads as a sync that stopped when it's still running.
  // The row's own button is the retry.
  const ask = (kind: TaskRequest["kind"]) => {
    if (asking) return;
    const state = task.state;
    setRequest({ kind, state, failed: false });
    const call =
      kind === "cancel"
        ? pluginClient.cancelTask(task.pluginId, task.id)
        : pluginClient.dismissTask(task.pluginId, task.id);
    call.then(
      // Taken, it lapses when the task's own state moves on — cancelling, or
      // gone — rather than flicking back to working in between.
      (taken) => {
        if (!taken) setRequest({ kind, state, failed: true });
      },
      (error: unknown) => {
        logError(`[PluginTaskList] Failed to ${kind} a plugin task`, error);
        setRequest({ kind, state, failed: true });
      }
    );
  };

  return (
    <li className="space-y-1" data-plugin-task={task.state}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <TruncatedTooltip content={task.title}>
            <div className="truncate text-xs text-text-primary">{task.title}</div>
          </TruncatedTooltip>
          <div className="flex items-baseline gap-2 text-2xs text-text-secondary">
            <TruncatedTooltip content={context}>
              <span className="min-w-0 flex-1 truncate">{context}</span>
            </TruncatedTooltip>
            {status !== null && <span className="shrink-0 tabular-nums">{status}</span>}
          </div>
        </div>
        {task.state === "interrupted" ? (
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Dismiss ${task.title}`}
            aria-disabled={asking || undefined}
            onClick={asking ? undefined : () => ask("dismiss")}
            className={asking ? ARIA_DISABLED_INERT_CLASSES : undefined}
          >
            Dismiss
          </Button>
        ) : (
          task.cancellable && (
            // `aria-disabled`, not `disabled`, once the cancel is asked for: a
            // native disabled button would drop keyboard focus to <body>.
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Cancel ${task.title}`}
              aria-disabled={cancelling || undefined}
              onClick={cancelling ? undefined : () => ask("cancel")}
              className={cancelling ? ARIA_DISABLED_INERT_CLASSES : undefined}
            >
              Cancel
            </Button>
          )
        )}
      </div>
      {live?.failed && (
        <InlineError role="alert" className="text-2xs">
          {live.kind === "cancel"
            ? "Couldn't cancel this task. It may still be running."
            : "Couldn't dismiss this task."}
        </InlineError>
      )}
      {task.state !== "interrupted" && (
        <ProgressBar
          size="thin"
          label={task.title}
          value={task.fraction === null ? null : task.fraction * 100}
          {...(status !== null ? { valueText: status } : {})}
        />
      )}
    </li>
  );
}

/**
 * The tasks plugins are running (#13819), oldest first, each attributed to its
 * plugin, in the footer readout's popover beside the host's own background
 * work. Draws only what the plugin said — its title, detail and fraction —
 * plus the host's own states: cancelling once the user asked, and interrupted
 * once the plugin went.
 */
export function PluginTaskList({ tasks }: { tasks: PluginTaskSnapshot[] }) {
  return (
    <ul className="space-y-2" aria-label="Plugin tasks">
      {tasks.map((task) => (
        <PluginTaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}
