import type { TerminalActivityPayload } from "@shared/types";
import { terminalRegistryController } from "@/controllers";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { enqueueActivityUpdate } from "@/store/panelStatusBuffer";

export function setupActivityListeners(): DisposableStore {
  const d = new DisposableStore();

  d.add(
    toDisposable(
      terminalRegistryController.onActivity((data: TerminalActivityPayload) => {
        enqueueActivityUpdate(
          data.terminalId,
          data.headline,
          data.status,
          data.type,
          data.lastCommand
        );
      })
    )
  );

  return d;
}
