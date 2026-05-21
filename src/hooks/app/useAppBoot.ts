import { useEffect, useRef, useState } from "react";
import type { BootResult } from "@shared/types/ipc/app";
import { isElectronAvailable } from "../useElectron";
import { logError } from "@/utils/logger";

export interface AppBootState {
  /** Loaded boot payload, or null while the IPC is in flight or has failed. */
  result: BootResult | null;
  /** Boot error, or null when in-flight or resolved. Mutually exclusive with `result`. */
  error: Error | null;
  /** True once the IPC has settled (either result or error). */
  settled: boolean;
}

/**
 * Fires `app:boot` exactly once on mount and exposes the combined payload so
 * cold-start hooks can derive crash gate state and hydration from a single
 * round-trip. The `useRef` guard keeps React 19 Strict Mode's double-invocation
 * from issuing a second IPC call.
 *
 * On error, `settled` flips to `true` with `result === null` and `error` set —
 * downstream gates collapse to a "no-op" state so the app can still render.
 * When Electron is unavailable (storybook, SSR), settles immediately as an
 * error so dependent hooks short-circuit.
 */
export function useAppBoot(): AppBootState {
  const [state, setState] = useState<AppBootState>(() => {
    if (!isElectronAvailable()) {
      return { result: null, error: new Error("Electron unavailable"), settled: true };
    }
    return { result: null, error: null, settled: false };
  });
  const hasFired = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || hasFired.current) return;
    hasFired.current = true;

    // No cancellation flag here on purpose. Under React 19 Strict Mode the
    // effect runs setup → cleanup → setup once on mount; if cleanup sets
    // `cancelled=true`, the boot() promise resolves into a stale closure and
    // the hook is stuck in "loading" forever. The setState below is
    // idempotent and React 18+ silently ignores updates after a real unmount,
    // so the no-cancellation form is correct and matches `useAppHydration`'s
    // pattern at src/hooks/app/useAppHydration.ts.
    window.electron.app
      .boot()
      .then((result) => {
        setState({ result, error: null, settled: true });
      })
      .catch((error) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        logError("Failed to fetch boot payload", wrapped);
        setState({ result: null, error: wrapped, settled: true });
      });
  }, []);

  return state;
}
