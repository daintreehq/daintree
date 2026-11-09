import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { latestUndoOnly, UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { useCanopyStore } from "@/store/canopyStore";

/**
 * Hides Canopy from its offer. The panel closes as the hidden snapshot lands;
 * the toast says where it went and takes it back — unless Canopy was shown,
 * hidden again or turned on since, here or in another view, which stands.
 */
export async function hideCanopy(): Promise<void> {
  const { applySnapshot } = useCanopyStore.getState();
  const hidden = await window.electron.canopy.setMode("hidden");
  applySnapshot(hidden);
  // The revision this hide left, as main counts them: an Undo applies only
  // while main still stands there.
  const revision = hidden.modeRevision ?? 0;
  notify({
    type: "success",
    title: "Canopy hidden",
    message: "Show it again from Settings > Canopy.",
    context: { eventKind: "settings" },
    priority: "high",
    transient: true,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: "Undo",
      onClick: latestUndoOnly("canopy-hide", () => {
        if (useCanopyStore.getState().mode !== "hidden") return;
        window.electron.canopy.setMode("unset", revision).then(applySnapshot, () =>
          notify({
            type: "error",
            title: "Couldn't show Canopy",
            message: "Show it again from Settings > Canopy.",
            // Settings events default to the inbox alone; a failed Undo is seen now.
            priority: "high",
            context: { eventKind: "settings" },
            action: {
              label: "Open settings",
              onClick: () =>
                void actionService.dispatch(
                  "app.settings.openTab",
                  { tab: "canopy" },
                  { source: "user" }
                ),
            },
          })
        );
      }),
    },
  });
}
