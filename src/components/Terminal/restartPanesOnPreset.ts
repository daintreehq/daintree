import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logWarn } from "@/utils/logger";
import type { ActionSource } from "@shared/types/actions";

export interface RestartOnPresetPane {
  id: string;
  title: string | undefined;
}

function paneName(pane: RestartOnPresetPane): string {
  const title = pane.title?.trim();
  return title ? `'${title}'` : "The terminal";
}

/** The refusals `restartTerminalOnPreset` names, in words; anything else says only that it didn't. */
function refusalReason(message: string): string {
  if (message.includes("already restarting")) return "is already restarting";
  if (message.includes("held for recovery")) return "is waiting to be restored";
  if (message.includes("not found")) return "is no longer open";
  return "didn't restart";
}

/**
 * One `terminal.restartOnPreset` per pane, each awaited (#15233). The restart
 * is announced only for the panes that started one, and every pane the store
 * refused is named in one error toast, so a partly refused switch never reads
 * as a whole one. Runs after the confirm has closed: the toast and the
 * announcement land in the main tree, where a screen reader hears them.
 */
export async function restartPanesOnPreset(
  panes: readonly RestartOnPresetPane[],
  preset: { id: string; name: string },
  source: ActionSource,
  announceRestarted: (count: number) => string
): Promise<void> {
  const outcomes = await Promise.all(
    panes.map(async (pane) => {
      const result = await actionService
        .dispatch(
          "terminal.restartOnPreset",
          { terminalId: pane.id, presetId: preset.id, confirmed: true },
          { source }
        )
        .catch((error: unknown) => ({
          ok: false as const,
          error: { message: error instanceof Error ? error.message : String(error) },
        }));
      return result.ok ? { pane, refusal: null } : { pane, refusal: result.error.message };
    })
  );

  const restarted = outcomes.filter((outcome) => outcome.refusal === null).length;
  if (restarted > 0) {
    useAnnouncerStore.getState().announce(announceRestarted(restarted));
  }

  const refused = outcomes.flatMap((outcome) =>
    outcome.refusal === null ? [] : [{ pane: outcome.pane, refusal: outcome.refusal }]
  );
  const first = refused[0];
  if (!first) return;
  for (const { pane, refusal } of refused) {
    logWarn("[RestartOnPreset] Restart refused", { terminalId: pane.id, refusal });
  }
  const message = refused
    .map(({ pane, refusal }) => `${paneName(pane)} ${refusalReason(refusal)}.`)
    .join(" ");
  notify({
    type: "error",
    title:
      refused.length === 1
        ? `Couldn't restart ${first.pane.title?.trim() ? paneName(first.pane) : "the terminal"} on ${preset.name}`
        : `Couldn't restart ${pluralize(refused.length, "pane")} on ${preset.name}`,
    message,
    action: {
      label: "Go to terminal",
      actionId: "panel.focus",
      actionArgs: { panelId: first.pane.id },
      onClick: () =>
        void actionService.dispatch("panel.focus", { panelId: first.pane.id }, { source: "user" }),
    },
    context: { eventKind: "agent", panelId: first.pane.id },
  });
}
