import { useEffect, useRef, useState } from "react";
import type { PendingCrash, CrashRecoveryAction, CrashRecoveryConfig } from "@shared/types/ipc";
import type { BootResult } from "@shared/types/ipc/app";
import { isElectronAvailable } from "../useElectron";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { startRendererSpan } from "@/utils/performance";
import { PERF_MARKS } from "@shared/perf/marks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { withViewTransition } from "@/lib/viewTransition";

export type CrashRecoveryGateState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "pending"; crash: PendingCrash; config: CrashRecoveryConfig }
  | {
      status: "failed";
      crash: PendingCrash;
      config: CrashRecoveryConfig;
      errorMessage: string;
    };

/**
 * Derive crash-gate state from the batched boot payload. The pending/config
 * pair used to come from two separate IPC calls (`crash-recovery:get-pending`
 * and `crash-recovery:get-config`) — the renderer now reads them from the
 * single `app:boot` invoke that `use()` resolves before this hook runs (#8820).
 * `bootResult` is `null` when boot failed or Electron is unavailable, in which
 * case the gate collapses to `none`. `resolve` and `updateConfig` still use the
 * standalone crash-recovery handlers because they fire post-gate.
 */
export function useCrashRecoveryGate(bootResult: BootResult | null): {
  state: CrashRecoveryGateState;
  resolve: (action: CrashRecoveryAction) => Promise<void>;
  updateConfig: (patch: Partial<CrashRecoveryConfig>) => Promise<void>;
} {
  const [state, setState] = useState<CrashRecoveryGateState>(() =>
    isElectronAvailable() ? { status: "loading" } : { status: "none" }
  );
  // Guards the auto-restore IPC against Strict Mode's double-invoked effect —
  // `use()` removes render double-invocation, but mount→cleanup→mount still
  // fires the effect twice and a duplicate `crashRecovery.resolve` would be a
  // real bug.
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || hasProcessed.current) return;
    hasProcessed.current = true;

    const done = startRendererSpan(PERF_MARKS.CRASH_RECOVERY_GATE);

    // Boot failed — drop the gate so the app can still render. The cold-start
    // skeleton stays up until hydration resolves (or also fails); a stuck gate
    // would deadlock the loading screen.
    if (!bootResult) {
      done();
      setState({ status: "none" });
      return;
    }

    const { crashPending: pending, crashConfig: config } = bootResult;
    if (!pending) {
      done();
      setState({ status: "none" });
      return;
    }

    // Skip silent restore when there's nothing to restore — the auto-path
    // hands an empty backup result to the user with no dialog, which is
    // indistinguishable from data loss. Surface the recovery dialog instead.
    if (config.autoRestoreOnCrash && (pending.crashCount ?? 0) < 2 && pending.hasBackup) {
      const suspectCount = (pending.panels ?? []).filter((p) => p.isSuspect).length;
      const crashCount = pending.crashCount ?? 0;
      const allPanelIds = (pending.panels ?? []).map((p) => p.id);
      // Guard against a malformed bridge that throws synchronously off
      // window.electron.crashRecovery.resolve — still close the span and fall
      // back to state: 'none' so the gate doesn't deadlock the loading screen.
      let restorePromise: Promise<void>;
      try {
        restorePromise = window.electron.crashRecovery.resolve({
          kind: "restore",
          panelIds: allPanelIds,
        });
      } catch {
        done();
        setState({ status: "none" });
        return;
      }
      restorePromise
        .then(() => {
          done();
          useRestoreConfirmationStore
            .getState()
            .showRestoreConfirmation({ suspectCount, crashCount });
          setState({ status: "none" });
        })
        .catch((err: unknown) => {
          done();
          // The IPC handler rejects when `restoreBackup()` returns false
          // (no snapshot, zero-match filter, no restorable content, or apply
          // exception). Keep the dialog mounted via a `failed` state — the
          // recovery source is preserved on disk by the service, so the user
          // can retry from the manual path. This also avoids emitting a
          // false "Session restored" confirmation.
          setState({
            status: "failed",
            crash: pending,
            config,
            errorMessage: formatErrorMessage(err, "Crash recovery restore failed"),
          });
        });
      return;
    }

    // Kick off the CrashRecoveryDialog chunk fetch before the next render
    // commits the Suspense boundary, so the dialog appears without a blank
    // fallback. The promise is cached, so the lazy() consumer reuses it. This
    // is a best-effort preload; the actual lazy() import owns user-visible
    // loading/error behavior.
    void import("@/components/Recovery/CrashRecoveryDialog").catch(() => {});
    done();
    setState({ status: "pending", crash: pending, config });
  }, [bootResult]);

  const resolve = async (action: CrashRecoveryAction) => {
    if (!isElectronAvailable()) return;
    await window.electron.crashRecovery.resolve(action);
    withViewTransition(() => setState({ status: "none" }));
  };

  const updateConfig = async (patch: Partial<CrashRecoveryConfig>) => {
    if (!isElectronAvailable()) return;
    const updated = await window.electron.crashRecovery.setConfig(patch);
    setState((prev) => {
      // The dialog can also be visible in `failed` state (after an
      // auto-restore rejection). Keep the local config in sync so the
      // auto-restore switch reflects the user's choice during retry.
      if (prev.status !== "pending" && prev.status !== "failed") return prev;
      return { ...prev, config: updated };
    });
  };

  return { state, resolve, updateConfig };
}
