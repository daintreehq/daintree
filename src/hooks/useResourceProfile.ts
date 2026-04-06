import { useEffect } from "react";
import { TerminalWebGLManager } from "../services/terminal/TerminalWebGLManager";
import type { ResourceProfilePayload } from "@shared/types/resourceProfile";

export function useResourceProfile(): void {
  useEffect(() => {
    const cleanup = window.electron.system.onResourceProfileChanged(
      (payload: ResourceProfilePayload) => {
        TerminalWebGLManager.setMaxContexts(payload.config.maxWebGLContexts);
      }
    );
    return cleanup;
  }, []);
}
