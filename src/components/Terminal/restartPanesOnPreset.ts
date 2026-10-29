import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { usePanelStore } from "@/store/panelStore";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionSource } from "@shared/types/actions";

export interface RestartOnPresetPane {
  id: string;
  title: string | undefined;
}

function paneName(pane: RestartOnPresetPane): string {
  const title = pane.title?.trim();
  return title ? `'${title}'` : "The terminal";
}

type Refusal = "restarting" | "recovery" | "closed" | "preset-missing" | "other";

/** The refusals `restartTerminalOnPreset` names; anything else says only that it didn't restart. */
function classifyRefusal(message: string): Refusal {
  if (message === "already restarting") return "restarting";
  if (message === "panel is held for recovery") return "recovery";
  if (message === "terminal not found") return "closed";
  if (/^preset ".*" not found$/.test(message)) return "preset-missing";
  return "other";
}

function describeRefusal(pane: RestartOnPresetPane, refusal: Refusal, presetName: string): string {
  switch (refusal) {
    case "restarting":
      return `${paneName(pane)} is already restarting.`;
    case "recovery":
      return `${paneName(pane)} is waiting to be restored.`;
    case "closed":
      return `${paneName(pane)} is no longer open.`;
    case "preset-missing":
      return `The ${presetName} preset is no longer available.`;
    case "other":
      return `${paneName(pane)} didn't restart.`;
  }
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
  // Read before the restarts: a refused pane may be gone by the time they settle.
  const worktreeIds = new Map(
    panes.map((pane) => [pane.id, usePanelStore.getState().panelsById[pane.id]?.worktreeId])
  );
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
          error: { message: formatErrorMessage(error, "Couldn't restart the terminal") },
        }));
      return result.ok ? { pane, refusal: null } : { pane, refusal: result.error.message };
    })
  );

  const restarted = outcomes.filter((outcome) => outcome.refusal === null).length;
  if (restarted > 0) {
    useAnnouncerStore.getState().announce(announceRestarted(restarted));
  }

  const refused = outcomes.flatMap((outcome) =>
    outcome.refusal === null
      ? []
      : [
          {
            pane: outcome.pane,
            message: outcome.refusal,
            refusal: classifyRefusal(outcome.refusal),
          },
        ]
  );
  const first = refused[0];
  if (!first) return;
  for (const { pane, message } of refused) {
    logWarn("[RestartOnPreset] Restart refused", { terminalId: pane.id, refusal: message });
  }
  const message = [
    ...new Set(refused.map(({ pane, refusal }) => describeRefusal(pane, refusal, preset.name))),
  ].join(" ");
  const title =
    refused.length === 1
      ? `Couldn't restart ${first.pane.title?.trim() ? paneName(first.pane) : "the terminal"} on ${preset.name}`
      : `Couldn't restart ${pluralize(refused.length, "pane")} on ${preset.name}`;
  // The way to a pane that is still open now, after the restarts settled: one
  // that closed, or went to the trash meanwhile, has nowhere to go.
  const panelsById = usePanelStore.getState().panelsById;
  const target = refused.find(({ pane, refusal }) => {
    const panel = panelsById[pane.id];
    return refusal !== "closed" && panel !== undefined && panel.location !== "trash";
  })?.pane;
  const worktreeId = worktreeIds.get((target ?? first.pane).id);
  if (!target) {
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok. Every pane it names has closed, so there is nothing left to go to or retry.
    notify({
      type: "error",
      title,
      message,
      context: { eventKind: "agent", ...(worktreeId ? { worktreeId } : {}) },
    });
    return;
  }
  notify({
    type: "error",
    title,
    message,
    action: {
      label: "Go to terminal",
      actionId: "panel.focus",
      actionArgs: { panelId: target.id },
      onClick: () =>
        void actionService.dispatch("panel.focus", { panelId: target.id }, { source: "user" }),
    },
    context: { eventKind: "agent", panelId: target.id, ...(worktreeId ? { worktreeId } : {}) },
  });
}
