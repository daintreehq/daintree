import type { PluginSetupStepUiAction } from "@shared/types/plugin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { usePluginSetupStatus } from "@/hooks/usePluginSetupStatus";
import { actionService } from "@/services/ActionService";
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
  /** Called after a step's action is dispatched, so a popover can step out of the way. */
  onAction?: () => void;
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
  const items = rows.map(({ step, done }) => {
    const skipped = !done && step.skipped;
    const action = step.action;
    return (
      <SettingsRow
        key={step.id}
        label={step.title}
        description={step.description ?? undefined}
        accessory={
          done ? <Badge size="xs">Done</Badge> : skipped ? <Badge size="xs">Skipped</Badge> : null
        }
        error={saveErrorStepId === step.id ? "Couldn't save this choice" : undefined}
        rootAttributes={{ "data-setup-step": step.id }}
        control={
          <div className="flex shrink-0 items-center gap-2">
            {action && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`${actionLabel(action)}: ${step.title}`}
                onClick={() => {
                  runSetupAction(pluginId, action);
                  onAction?.();
                }}
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

function runSetupAction(pluginId: string, action: PluginSetupStepUiAction): void {
  if (action.kind === "command") {
    void actionService.dispatch(action.actionId, undefined, { source: "user" });
    return;
  }
  void actionService.dispatch(
    "plugin.openSettings",
    action.key === null ? { pluginId } : { pluginId, key: action.key },
    { source: "user" }
  );
}
