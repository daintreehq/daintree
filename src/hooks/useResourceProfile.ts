import { useEffect } from "react";
import { setWebglThresholds } from "../services/terminal/TerminalWebGLConfig";
import { terminalInstanceService } from "../services/terminal/TerminalInstanceService";
import { useResourceProfileStore } from "../store/resourceProfileStore";
import type { ResourceProfilePayload } from "@shared/types/resourceProfile";

export function useResourceProfile(): void {
  useEffect(() => {
    const cleanup = window.electron.system.onResourceProfileChanged(
      (payload: ResourceProfilePayload) => {
        setWebglThresholds(payload.config.webglUpperThreshold, payload.config.webglLowerThreshold);
        // Threshold writes alone don't move the live manager out of its
        // current mode — nudge it so a profile downgrade with N wants > new
        // upper flips to dom immediately instead of waiting on the next
        // consumer event to evaluate it.
        terminalInstanceService.refreshWebGLMode();
        useResourceProfileStore.getState().setProfile(payload.profile);
      }
    );
    return cleanup;
  }, []);
}
