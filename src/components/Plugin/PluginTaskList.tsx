import type { PluginTaskSnapshot } from "@shared/types/plugin";
import { pluginClient } from "@/clients";
import { Button } from "@/components/ui/button";
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

function PluginTaskRow({ task }: { task: PluginTaskSnapshot }) {
  const status = taskStatus(task);
  // The plugin's name always leads: every word on the row after the title is
  // the plugin's own, and this is what says whose.
  const context = task.detail ? `${task.pluginName} · ${task.detail}` : task.pluginName;
  const cancelling = task.state === "cancelling";

  const cancel = () => {
    pluginClient.cancelTask(task.pluginId, task.id).catch((error: unknown) => {
      logError("[PluginTaskList] Failed to cancel a plugin task", error);
    });
  };
  const dismiss = () => {
    pluginClient.dismissTask(task.pluginId, task.id).catch((error: unknown) => {
      logError("[PluginTaskList] Failed to dismiss a plugin task", error);
    });
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
          <Button variant="ghost" size="xs" aria-label={`Dismiss ${task.title}`} onClick={dismiss}>
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
              onClick={cancelling ? undefined : cancel}
              className={cancelling ? ARIA_DISABLED_INERT_CLASSES : undefined}
            >
              Cancel
            </Button>
          )
        )}
      </div>
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
