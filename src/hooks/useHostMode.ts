import { useEffect, useRef, useState } from "react";
import { hostModeClient } from "@/clients/hostModeClient";
import { isRemoteHostsSupported } from "@/lib/remoteHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HostModeStatus, SetHostModePayload } from "@shared/types/ipc/hostMode";

export interface HostModeSaveFailure {
  payload: SetHostModePayload;
  message: string;
}

export interface UseHostModeResult {
  /** False on a platform that can't host (Windows): render nothing. */
  supported: boolean;
  status: HostModeStatus | null;
  loadError: string | null;
  /** The change in flight, so the switches show what was asked while main acts. */
  pending: SetHostModePayload | null;
  saveFailure: HostModeSaveFailure | null;
  checkingKeychain: boolean;
  reload(): Promise<void>;
  setEnabled(payload: SetHostModePayload): Promise<void>;
  runKeychainPreflight(): Promise<void>;
}

/**
 * Host mode's live status for this machine: loaded once, then kept current by
 * main's pushes. Changes go through one at a time; promise chains rather than
 * try/finally, which the React Compiler can't lower.
 */
export function useHostMode(): UseHostModeResult {
  const supported = isRemoteHostsSupported();
  const [status, setStatus] = useState<HostModeStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<SetHostModePayload | null>(null);
  const [saveFailure, setSaveFailure] = useState<HostModeSaveFailure | null>(null);
  const [checkingKeychain, setCheckingKeychain] = useState(false);
  const savingRef = useRef(false);

  const reload = (): Promise<void> => {
    if (!supported) return Promise.resolve();
    setLoadError(null);
    return hostModeClient.getStatus().then(
      (next) => setStatus(next),
      (error: unknown) =>
        setLoadError(formatErrorMessage(error, "Host mode status couldn't be read."))
    );
  };

  useEffect(() => {
    if (!supported) return;
    let active = true;
    const off = hostModeClient.onEvent((event) => {
      if (active && event.type === "status-changed") setStatus(event.status);
    });
    hostModeClient.getStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (error: unknown) => {
        if (active) setLoadError(formatErrorMessage(error, "Host mode status couldn't be read."));
      }
    );
    return () => {
      active = false;
      off();
    };
  }, [supported]);

  const setEnabled = (payload: SetHostModePayload): Promise<void> => {
    if (!supported || savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPending(payload);
    setSaveFailure(null);
    return hostModeClient
      .setEnabled(payload)
      .then(
        (next) => setStatus(next),
        (error: unknown) =>
          setSaveFailure({
            payload,
            message: formatErrorMessage(error, "Host mode couldn't be changed."),
          })
      )
      .finally(() => {
        savingRef.current = false;
        setPending(null);
      });
  };

  const runKeychainPreflight = (): Promise<void> => {
    if (!supported) return Promise.resolve();
    setCheckingKeychain(true);
    return hostModeClient
      .runKeychainPreflight()
      .then(
        (next) => setStatus(next),
        () => {
          // The row keeps its last observation; the check can be run again.
        }
      )
      .finally(() => setCheckingKeychain(false));
  };

  return {
    supported,
    status,
    loadError,
    pending,
    saveFailure,
    checkingKeychain,
    reload,
    setEnabled,
    runKeychainPreflight,
  };
}
