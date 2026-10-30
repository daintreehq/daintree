import { terminalClient } from "@/clients";
import { usePanelStore } from "@/store/panelStore";
import { saveNormalized } from "@/store/slices/panelRegistry/persistence";
import {
  deferPersistToBatchEnd,
  isHydrationBatchActive,
} from "@/store/slices/panelRegistry/hydrationBatch";
import { isPtyPanel } from "@shared/types/panel";
import { sanitizeFirstPrompt } from "@shared/utils/firstPrompt";
import { DisposableStore, toDisposable } from "@/utils/disposable";

/**
 * Record the first send Daintree wrote to an agent run that had no first
 * prompt (#15521). Main offers each run at most one, but the pane still keeps
 * whatever it already has: a launch prompt committed meanwhile, or a restart
 * under way that decides what the next run keeps.
 */
export function recordSentFirstPrompt(id: string, value: unknown): void {
  const firstPrompt = sanitizeFirstPrompt(value);
  if (firstPrompt?.via !== "send") return;
  let recorded = false;
  usePanelStore.setState((state) => {
    const panel = state.panelsById[id];
    if (
      !panel ||
      !isPtyPanel(panel) ||
      !panel.launchAgentId ||
      panel.firstPrompt ||
      panel.isRestarting ||
      panel.location === "trash"
    ) {
      return state;
    }
    recorded = true;
    return { panelsById: { ...state.panelsById, [id]: { ...panel, firstPrompt } } };
  });
  if (!recorded) return;
  if (isHydrationBatchActive()) {
    deferPersistToBatchEnd();
    return;
  }
  const after = usePanelStore.getState();
  saveNormalized(after.panelsById, after.panelIds);
}

export function setupFirstPromptListeners(): DisposableStore {
  const d = new DisposableStore();
  d.add(
    toDisposable(
      terminalClient.onFirstPrompt((payload) => {
        recordSentFirstPrompt(payload.id, payload.firstPrompt);
      })
    )
  );
  return d;
}
