import { useEffect } from "react";
import { setWebglThresholds } from "../services/terminal/TerminalWebGLConfig";
import { setAgentScrollbackMaxLines } from "../utils/scrollbackConfig";
import { terminalInstanceService } from "../services/terminal/TerminalInstanceService";
import { useResourceProfileStore } from "../store/resourceProfileStore";
import { safeFireAndForget } from "../utils/safeFireAndForget";
import type { ResourceProfilePayload } from "@shared/types/resourceProfile";

export function useResourceProfile(): void {
  useEffect(() => {
    const apply = (payload: ResourceProfilePayload) => {
      setWebglThresholds(payload.config.webglUpperThreshold, payload.config.webglLowerThreshold);
      // Threshold writes alone don't move the live manager out of its
      // current mode — nudge it so a profile downgrade with N wants > new
      // upper flips to dom immediately instead of waiting on the next
      // consumer event to evaluate it.
      terminalInstanceService.refreshWebGLMode();
      // Same write-then-apply shape for the scrollback ceiling: the config
      // write covers terminals created later, the re-derive covers the ones
      // already open.
      setAgentScrollbackMaxLines(payload.config.agentScrollbackMaxLines);
      terminalInstanceService.restoreScrollbackAllForeground();
      useResourceProfileStore.getState().setProfile(payload.profile);
    };

    let pushed = false;
    const cleanup = window.electron.system.onResourceProfileChanged(
      (payload: ResourceProfilePayload) => {
        pushed = true;
        apply(payload);
      }
    );
    // Pull the current profile once on mount: the push has no replay, so a
    // view created after the last transition (new window, LRU-recreated view)
    // would otherwise run balanced defaults until the next transition. A push
    // arriving before the pull resolves is fresher and wins.
    safeFireAndForget(
      window.electron.system.getResourceProfile().then((payload) => {
        if (!pushed) apply(payload);
      }),
      { context: "Pulling current resource profile on mount" }
    );
    return cleanup;
  }, []);
}
