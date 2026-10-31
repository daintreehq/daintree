import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

/**
 * Says that a launch dropped a retired model and runs on the CLI default
 * (#15652). Nothing on the pane shows that change: its title already reads as
 * the bare agent name for an id the picker no longer lists, so without this a
 * model an account can still use would disappear unseen. Bursts with the same
 * model collapse into one bar, because a project restore relaunches every
 * pane that saved it at once.
 */
export function notifyRetiredModelDropped(
  agentId: string,
  modelIds: readonly string[],
  address: { panelId?: string; worktreeId?: string } = {}
): void {
  if (modelIds.length === 0) return;
  const agentName = getEffectiveAgentConfig(agentId)?.name ?? agentId;
  const models = modelIds.join(", ");
  const retired = modelIds.length === 1 ? "which has been retired" : "which have been retired";
  const message = (count: number) =>
    count === 1
      ? `This ${agentName} pane was set to ${models}, ${retired}, so it starts on the CLI's default model instead.`
      : `${pluralize(count, `${agentName} pane`)} were set to ${models}, ${retired}, so they start on the CLI's default model instead.`;
  notify({
    type: "warning",
    placement: "grid-bar",
    title: "Retired model removed",
    message: message(1),
    context: { eventKind: "recovery", ...address },
    coalesce: {
      key: `retired-model:${agentId}:${models}`,
      buildMessage: message,
    },
  });
}
