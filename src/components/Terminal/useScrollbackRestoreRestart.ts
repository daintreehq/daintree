import { useCallback } from "react";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";

/**
 * The restart the scrollback-restore banner offers (#16622).
 *
 * That banner reports a terminal that still works, so unlike the banners that
 * serve a process which has already failed or exited, its button can land on a
 * live agent mid-turn. It takes the same split the pane's header menu makes:
 * a working agent goes through `terminal.restart`, which stages the existing
 * "Restart '<title>'?" confirm and leaves the process running until it is
 * answered, and everything else restarts at once.
 *
 * The gated branch deliberately skips `restartImmediately`. Declining the
 * confirm must leave the pane exactly as it was, and a confirmed restart
 * advances `restartKey`, whose effect in `TerminalPane` already resets the
 * input tracker.
 *
 * The panel is read at activation, not render: the agent can change state
 * between the banner appearing and the click, and this hook has no other reason
 * to re-render on every agent state tick.
 */
export function useScrollbackRestoreRestart(
  panelId: string,
  restartImmediately: () => void
): () => void {
  return useCallback(() => {
    if (terminalHasRunningAgentSession(usePanelStore.getState().panelsById[panelId])) {
      void actionService.dispatch("terminal.restart", { terminalId: panelId }, { source: "user" });
      return;
    }
    restartImmediately();
  }, [panelId, restartImmediately]);
}
