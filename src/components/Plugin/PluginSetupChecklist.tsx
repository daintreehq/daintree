import { useEffect, useRef, useState } from "react";
import type { ActionDispatchResult } from "@shared/types/actions";
import type { PluginSetupStepUiAction } from "@shared/types/plugin";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { usePluginSetupStatus } from "@/hooks/usePluginSetupStatus";
import { actionService } from "@/services/ActionService";
import { isStagedConfirmation } from "@/services/actions/confirmationStaged";
import type { PluginSetupRow } from "@/services/plugin/pluginSetupProgress";
import { useProjectStore } from "@/store/projectStore";

interface PluginSetupChecklistProps {
  pluginId: string;
  rows: readonly PluginSetupRow[];
  /** Skips are remembered per project, so with none open a step can't be skipped. */
  canSkip: boolean;
  onSetSkipped: (stepId: string, skipped: boolean) => void;
  saveErrorStepId: string | null;
  /** `settings` sits on the settings page as a group; `plain` is the rows alone, for a popover. */
  variant: "settings" | "plain";
  /** The settings group's visible label. */
  groupLabel?: string;
  /** Called once a step's action has gone through, so a popover can step out of the way. */
  onAction?: () => void;
}

/** A step whose action came back failed, said on its own row. */
interface StepFailure {
  pluginId: string;
  stepId: string;
  message: string;
}

/**
 * A plugin's `contributes.setup` checklist (#13824). Done is what the host can
 * see, so a step is never ticked by hand: the user follows its action, or
 * skips it. A skip is reversible from the same row.
 */
export function PluginSetupChecklist({
  pluginId,
  rows,
  canSkip,
  onSetSkipped,
  saveErrorStepId,
  variant,
  groupLabel,
  onAction,
}: PluginSetupChecklistProps) {
  const [runningStepId, setRunningStepId] = useState<string | null>(null);
  const [failure, setFailure] = useState<StepFailure | null>(null);
  // A popover's rows unmount when it closes. An answer landing after that
  // belongs to an opening that's gone, and must not close the next one.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The popover stays up until the action answers: closed first, a command
  // that failed or was refused would leave nothing on screen to say so. The
  // row's own button is the retry.
  const run = (stepId: string, action: PluginSetupStepUiAction) => {
    if (runningStepId !== null) return;
    setRunningStepId(stepId);
    setFailure(null);
    void runSetupAction(pluginId, action)
      .then(
        (result) => {
          if (!mountedRef.current) return;
          // A staged confirmation is a dialog now asking the user, not a failure.
          if (result.ok || isStagedConfirmation(result.error)) {
            onAction?.();
            return;
          }
          setFailure({ pluginId, stepId, message: result.error.message });
        },
        (error: unknown) => {
          setFailure({ pluginId, stepId, message: formatErrorMessage(error, "") });
        }
      )
      .finally(() => setRunningStepId(null));
  };

  const items = rows.map(({ step, done }) => {
    const skipped = !done && step.skipped;
    const action = step.action;
    const failed =
      !done && action && failure?.pluginId === pluginId && failure.stepId === step.id
        ? failureText(action, failure.message)
        : undefined;
    return (
      <SettingsRow
        key={step.id}
        label={step.title}
        description={step.description ?? undefined}
        accessory={
          done ? <Badge size="xs">Done</Badge> : skipped ? <Badge size="xs">Skipped</Badge> : null
        }
        error={failed ?? (saveErrorStepId === step.id ? "Couldn't save this choice" : undefined)}
        rootAttributes={{ "data-setup-step": step.id }}
        control={
          <div className="flex shrink-0 items-center gap-2">
            {action && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`${actionLabel(action)}: ${step.title}`}
                loading={runningStepId === step.id}
                onClick={() => run(step.id, action)}
              >
                {actionLabel(action)}
              </Button>
            )}
            {canSkip && !done && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${skipped ? "Undo skip" : "Skip"}: ${step.title}`}
                onClick={() => onSetSkipped(step.id, !skipped)}
              >
                {skipped ? "Undo skip" : "Skip"}
              </Button>
            )}
          </div>
        }
      />
    );
  });

  if (variant === "settings") return <SettingsGroup label={groupLabel}>{items}</SettingsGroup>;
  return <div className="divide-y divide-border-subtle">{items}</div>;
}

/**
 * The checklist at the top of a plugin's settings, against the current
 * project. It stays once every step is handled — it's where a skip is undone —
 * and with no project open it shows what the host can see and offers no skip.
 */
export function PluginSetupSettingsGroup({ pluginId }: { pluginId: string }) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const setup = usePluginSetupStatus(pluginId, projectId);
  if (setup.total === 0) return null;
  return (
    <PluginSetupChecklist
      pluginId={pluginId}
      rows={setup.rows}
      canSkip={projectId !== null}
      onSetSkipped={setup.setSkipped}
      saveErrorStepId={setup.saveErrorStepId}
      variant="settings"
      groupLabel={`Setup · ${setup.handled} of ${setup.total}`}
    />
  );
}

function actionLabel(action: PluginSetupStepUiAction): string {
  if (action.kind === "command") return "Run";
  return action.key === null ? "Open settings" : "Open setting";
}

function failureText(action: PluginSetupStepUiAction, message: string): string {
  const what = action.kind === "command" ? "Couldn't run this step" : "Couldn't open settings";
  return message.trim() ? `${what}: ${message.trim()}` : what;
}

function runSetupAction(
  pluginId: string,
  action: PluginSetupStepUiAction
): Promise<ActionDispatchResult> {
  if (action.kind === "command") {
    return actionService.dispatch(action.actionId, undefined, { source: "user" });
  }
  return actionService.dispatch(
    "plugin.openSettings",
    action.key === null ? { pluginId } : { pluginId, key: action.key },
    { source: "user" }
  );
}
