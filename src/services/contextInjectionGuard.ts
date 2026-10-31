import { copyTreeClient } from "@/clients";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { usePanelStore } from "@/store/panelStore";
import { logError } from "@/utils/logger";
import { isPtyPanel } from "@shared/types/panel";
import type { PanelInstance } from "@shared/types/panel";
import type { CopyTreeOptions, CopyTreeResult, CopyTreeRunSource } from "@shared/types";

export const INPUT_LOCKED_INJECTION_REFUSAL =
  "Context can't be injected while the terminal's input is locked";

function isLockedByUser(panel: PanelInstance | undefined): boolean {
  return panel !== undefined && isPtyPanel(panel) && panel.isInputLocked === true;
}

function panelById(
  panelsById: Record<string, PanelInstance>,
  terminalId: string
): PanelInstance | undefined {
  return Object.hasOwn(panelsById, terminalId) ? panelsById[terminalId] : undefined;
}

/** The pair `terminal.sendKeys` refuses on: the panel's lock, or its instance's. */
export function isTerminalInputLocked(terminalId: string): boolean {
  if (isLockedByUser(panelById(usePanelStore.getState().panelsById, terminalId))) return true;
  return peekTerminalService()?.get(terminalId)?.isInputLocked === true;
}

export interface ContextInjectionRequest {
  terminalId: string;
  worktreeId: string;
  options?: CopyTreeOptions;
  /** Allocated here when the caller has none, so the run can always be stopped. */
  injectionId?: string;
  source?: CopyTreeRunSource;
  name?: string;
}

/**
 * Inject context into a terminal only while its input stays unlocked. Every
 * renderer route into `copytree:inject` comes through here.
 *
 * A locked target is refused before anything is generated. The lock lives in
 * the renderer, so main learns of one set mid-run as a stop aimed at this run,
 * and from the moment it lands writes no more of the bundle.
 *
 * Only the panel's lock is watched mid-run. The instance's own also holds
 * through a history refill, which is no reason to abandon a paste main is
 * already writing, and through a restart, which replaces the PTY and stops the
 * run in main by itself.
 */
export async function injectContextUnlessLocked(
  request: ContextInjectionRequest
): Promise<CopyTreeResult> {
  const { terminalId } = request;
  if (isTerminalInputLocked(terminalId)) {
    throw new UnactionableTargetError(INPUT_LOCKED_INJECTION_REFUSAL);
  }
  const injectionId = request.injectionId ?? crypto.randomUUID();

  let stopSent = false;
  const unsubscribe = usePanelStore.subscribe((state) => {
    if (stopSent || !isLockedByUser(panelById(state.panelsById, terminalId))) return;
    stopSent = true;
    try {
      void Promise.resolve(copyTreeClient.cancel(injectionId, "input-locked")).catch((error) =>
        logError("[contextInjectionGuard] Stop for a locked terminal failed", error)
      );
    } catch (error) {
      logError("[contextInjectionGuard] Stop for a locked terminal failed", error);
    }
  });

  try {
    return await copyTreeClient.injectToTerminal(
      terminalId,
      request.worktreeId,
      request.options,
      injectionId,
      request.source,
      request.name
    );
  } finally {
    unsubscribe();
  }
}
