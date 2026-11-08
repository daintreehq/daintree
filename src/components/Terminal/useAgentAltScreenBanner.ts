import { useCallback, useEffect, useState } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalChromeDescriptor } from "@/utils/terminalChrome";
import {
  peek as peekTerminalService,
  subscribeWhenReady,
} from "@/services/terminal/terminalInstanceServiceAccessor";

/**
 * The agent a pane's full-screen notice would name, or `undefined` for a pane
 * that owes none: a plain shell, a shell running `vim`, an agent that has exited.
 */
export function altScreenNoticeAgentId(
  chrome: Pick<TerminalChromeDescriptor, "isAgent" | "hasExited" | "agentId">
): string | undefined {
  return chrome.isAgent && !chrome.hasExited ? (chrome.agentId ?? undefined) : undefined;
}

export interface AgentAltScreenBanner {
  visible: boolean;
  dismiss: () => void;
}

/**
 * Whether this agent pane is on the alternate screen right now, and so owes the
 * user a notice that Daintree's scrollback and search don't reach it (#16357).
 *
 * `agentId` is the pane's current agent identity: a plain shell, where `vim` or
 * `htop` takes the screen, passes `undefined` and is never watched. The buffer
 * state comes from the terminal service's listener, which reports the current
 * screen on subscribe and every change after, so the notice follows the screen
 * and cannot outlive it.
 *
 * `attachEpoch` re-subscribes after each attach: a subscription made before the
 * terminal exists is a no-op, and a restart builds a new terminal under the same
 * panel id.
 *
 * Dismissal lives on the panel for the same reason `useSessionLostBanner`'s
 * does: the grid unmounts the pane on a worktree switch.
 */
export function useAgentAltScreenBanner(
  panelId: string,
  agentId: string | undefined,
  attachEpoch: number
): AgentAltScreenBanner {
  const dismissed = usePanelStore((state) => {
    const panel = state.panelsById[panelId];
    return panel && isPtyPanel(panel) ? panel.altScreenNoticeDismissed === true : false;
  });
  const dismissAltScreenNotice = usePanelStore((state) => state.dismissAltScreenNotice);

  const watching = agentId !== undefined && !dismissed;

  // Seeded from the service so a pane that remounts while already full-screen
  // doesn't open without its notice and then fade it in.
  const [isAltBuffer, setIsAltBuffer] = useState(
    () => watching && (peekTerminalService()?.getAltBufferState(panelId) ?? false)
  );

  useEffect(() => {
    if (!watching) return;
    const unsubscribe = subscribeWhenReady((service) => {
      const stopBufferWatch = service.addAltBufferListener(panelId, setIsAltBuffer);
      // A restart or close tears the terminal down without a last word on its
      // screen; until the next one attaches, the old reading would stand.
      const stopDestroyWatch = service.addInstanceDestroyedListener((destroyedId) => {
        if (destroyedId === panelId) setIsAltBuffer(false);
      });
      return () => {
        stopBufferWatch();
        stopDestroyWatch();
      };
    });
    return () => {
      unsubscribe();
      setIsAltBuffer(false);
    };
  }, [panelId, watching, attachEpoch]);

  const dismiss = useCallback(
    () => dismissAltScreenNotice(panelId),
    [dismissAltScreenNotice, panelId]
  );

  return { visible: watching && isAltBuffer, dismiss };
}
