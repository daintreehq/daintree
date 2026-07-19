import { useEffect, useState } from "react";
import { useGitPushConfirmStore } from "@/store/gitPushConfirmStore";
import { useGitPullRebaseConfirmStore } from "@/store/gitPullRebaseConfirmStore";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { useRecipeConflictStore } from "@/store/recipeConflictStore";
import { useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { usePluginConfirmStore } from "@/store/pluginConfirmStore";
import { usePluginMcpConfirmStore } from "@/store/pluginMcpConfirmStore";
import { usePluginCapabilityConfirmStore } from "@/store/pluginCapabilityConfirmStore";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";

export interface ModalResetKeys {
  gitPushResetKey: number;
  gitPullRebaseResetKey: number;
  panelLimitResetKey: number;
  recipeConflictResetKey: number;
  mcpConfirmResetKey: string;
  pluginConfirmResetKey: string;
  pluginMcpConfirmResetKey: string;
  pluginCapabilityConfirmResetKey: string;
  diagnosticsReviewResetKey: number;
  terminalInfoResetKey: number;
}

/**
 * ErrorBoundary reset signals for the always-mounted dialog hosts (#9918). A
 * static `[Number(isStateLoaded)]` collapses to `[1]` after hydration and
 * never changes, so a host that crashes once stays dead for the session (and
 * its deferred promise leaks). Each host instead resets on its own
 * pending-request signal, so a fresh request remounts the crashed boundary:
 *   - request-counter stores bump `requestSeq` on every request (covers the
 *     back-to-back supersede case where `pendingConfirm` never returns to null)
 *   - FIFO-queue stores key off the live `current.requestId` UUID
 *   - the diagnostics host toggles on its own `isOpen`
 *   - the event-driven hosts (terminal-info, file-viewer) hold no store state,
 *     so a local counter increments on each open event below.
 */
export function useModalResetKeys(): ModalResetKeys {
  const gitPushResetKey = useGitPushConfirmStore((s) => s.requestSeq);
  const gitPullRebaseResetKey = useGitPullRebaseConfirmStore((s) => s.requestSeq);
  const panelLimitResetKey = usePanelLimitStore((s) => s.requestSeq);
  const recipeConflictResetKey = useRecipeConflictStore((s) => s.requestSeq);
  const mcpConfirmResetKey = useMcpConfirmStore((s) => s.current?.requestId ?? "");
  const pluginConfirmResetKey = usePluginConfirmStore((s) => s.current?.requestId ?? "");
  const pluginMcpConfirmResetKey = usePluginMcpConfirmStore((s) => s.current?.requestId ?? "");
  const pluginCapabilityConfirmResetKey = usePluginCapabilityConfirmStore(
    (s) => s.current?.requestId ?? ""
  );
  const diagnosticsReviewResetKey = useDiagnosticsReviewStore((s) => s.requestSeq);
  const [terminalInfoResetKey, setTerminalInfoResetKey] = useState(0);
  useEffect(() => {
    const onTerminalInfo = () => setTerminalInfoResetKey((k) => k + 1);
    window.addEventListener("daintree:open-terminal-info", onTerminalInfo);
    return () => {
      window.removeEventListener("daintree:open-terminal-info", onTerminalInfo);
    };
  }, []);

  return {
    gitPushResetKey,
    gitPullRebaseResetKey,
    panelLimitResetKey,
    recipeConflictResetKey,
    mcpConfirmResetKey,
    pluginConfirmResetKey,
    pluginMcpConfirmResetKey,
    pluginCapabilityConfirmResetKey,
    diagnosticsReviewResetKey,
    terminalInfoResetKey,
  };
}
