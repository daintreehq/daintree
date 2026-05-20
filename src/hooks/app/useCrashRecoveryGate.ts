import { useEffect, useRef, useState } from "react";
import type { PendingCrash, CrashRecoveryAction, CrashRecoveryConfig } from "@shared/types/ipc";
import { isElectronAvailable } from "../useElectron";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import type { AppBootState } from "./useAppBoot";

export type CrashRecoveryGateState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "pending"; crash: PendingCrash; config: CrashRecoveryConfig };

/**
 * Derive crash-gate state from the batched boot payload. The pending/config
 * pair used to come from two separate IPC calls (`crash-recovery:get-pending`
 * and `crash-recovery:get-config`) — the renderer now reads them from the
 * single `app:boot` invoke. `resolve` and `updateConfig` still use the
 * standalone crash-recovery handlers because they fire post-gate.
 */
export function useCrashRecoveryGate(boot: AppBootState): {
  state: CrashRecoveryGateState;
  resolve: (action: CrashRecoveryAction) => Promise<void>;
  updateConfig: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
} {
  const [state, setState] = useState<CrashRecoveryGateState>(() =>
    isElectronAvailable() ? { status: "loading" } : { status: "none" }
  );
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || hasProcessed.current) return;
    if (!boot.settled) return;
    hasProcessed.current = true;

    // Boot failed — drop the gate so the app can still render. The cold-start
    // skeleton stays up until hydration resolves (or also fails); a stuck gate
    // would deadlock the loading screen.
    if (!boot.result) {
      setState({ status: "none" });
      return;
    }

    const { crashPending: pending, crashConfig: config } = boot.result;
    if (!pending) {
      setState({ status: "none" });
      return;
    }

    if (config.autoRestoreOnCrash && (pending.crashCount ?? 0) < 2) {
      const suspectCount = (pending.panels ?? []).filter((p) => p.isSuspect).length;
      const crashCount = pending.crashCount ?? 0;
      const allPanelIds = (pending.panels ?? []).map((p) => p.id);
      window.electron.crashRecovery
        .resolve({ kind: "restore", panelIds: allPanelIds })
        .then(() => {
          useRestoreConfirmationStore
            .getState()
            .showRestoreConfirmation({ suspectCount, crashCount });
          setState({ status: "none" });
        })
        .catch(() => setState({ status: "none" }));
      return;
    }

    // Kick off the CrashRecoveryDialog chunk fetch before the next render
    // commits the Suspense boundary, so the dialog appears without a blank
    // fallback. The promise is cached, so the lazy() consumer reuses it.
    void import("@/components/Recovery/CrashRecoveryDialog");
    setState({ status: "pending", crash: pending, config });
  }, [boot]);

  const resolve = async (action: CrashRecoveryAction) => {
    if (!isElectronAvailable()) return;
    await window.electron.crashRecovery.resolve(action);
    setState({ status: "none" });
  };

  const updateConfig = async (patch: Partial<CrashRecoveryConfig>) => {
    if (!isElectronAvailable()) return;
    const updated = await window.electron.crashRecovery.setConfig(patch);
    setState((prev) => {
      if (prev.status !== "pending") return prev;
      return { ...prev, config: updated };
    });
  };

  return { state, resolve, updateConfig };
}
