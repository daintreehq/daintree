import { useEffect, useState } from "react";
import type { PendingCrash, CrashRecoveryAction, CrashRecoveryConfig } from "@shared/types/ipc";
import { isElectronAvailable } from "../useElectron";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";

export type CrashRecoveryGateState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "pending"; crash: PendingCrash; config: CrashRecoveryConfig };

export function useCrashRecoveryGate(): {
  state: CrashRecoveryGateState;
  resolve: (action: CrashRecoveryAction) => Promise<void>;
  updateConfig: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
} {
  const [state, setState] = useState<CrashRecoveryGateState>({ status: "loading" });

  useEffect(() => {
    if (!isElectronAvailable()) {
      setState({ status: "none" });
      return;
    }

    const electron = window.electron;

    Promise.all([electron.crashRecovery.getPending(), electron.crashRecovery.getConfig()])
      .then(([pending, config]) => {
        if (!pending) {
          setState({ status: "none" });
          return;
        }

        if (config.autoRestoreOnCrash && (pending.crashCount ?? 0) < 2) {
          const suspectCount = (pending.panels ?? []).filter((p) => p.isSuspect).length;
          const crashCount = pending.crashCount ?? 0;
          const allPanelIds = (pending.panels ?? []).map((p) => p.id);
          electron.crashRecovery
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
      })
      .catch(() => {
        setState({ status: "none" });
      });
  }, []);

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
