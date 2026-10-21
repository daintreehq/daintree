import { useEffect, useRef, useState } from "react";
import { deviceAnswerClient } from "@/clients/deviceAnswerClient";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { DeviceAnswerStatus, SetDeviceAnswerPayload } from "@shared/types/ipc/deviceAnswer";

export interface UseDeviceAnswerResult {
  status: DeviceAnswerStatus | null;
  loadError: string | null;
  /** Whatever change is in flight; the controls hold still until it settles. */
  busy: boolean;
  /** The last change that failed, in words to show under the group. */
  actionError: string | null;
  reload(): Promise<void>;
  setEnabled(payload: SetDeviceAnswerPayload): Promise<boolean>;
  createPairingCode(): Promise<void>;
  cancelPairingCode(): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
}

/**
 * Answer from another device's status for this machine: loaded once, then
 * kept current by main's pushes. One change at a time; promise chains rather
 * than try/finally, which the React Compiler can't lower.
 */
export function useDeviceAnswer(): UseDeviceAnswerResult {
  const [status, setStatus] = useState<DeviceAnswerStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const reload = (): Promise<void> => {
    setLoadError(null);
    return deviceAnswerClient.getStatus().then(
      (next) => setStatus(next),
      (error: unknown) =>
        setLoadError(formatErrorMessage(error, "Couldn't read whether devices can answer."))
    );
  };

  useEffect(() => {
    let active = true;
    const off = deviceAnswerClient.onEvent((event) => {
      if (active && event.type === "status-changed") setStatus(event.status);
    });
    deviceAnswerClient.getStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (error: unknown) => {
        if (active) {
          setLoadError(formatErrorMessage(error, "Couldn't read whether devices can answer."));
        }
      }
    );
    return () => {
      active = false;
      off();
    };
  }, []);

  const run = (task: () => Promise<DeviceAnswerStatus>, fallback: string): Promise<boolean> => {
    if (busyRef.current) return Promise.resolve(false);
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    return task()
      .then(
        (next) => {
          setStatus(next);
          return true;
        },
        (error: unknown) => {
          setActionError(formatErrorMessage(error, fallback));
          return false;
        }
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };

  return {
    status,
    loadError,
    busy,
    actionError,
    reload,
    setEnabled: (payload) =>
      run(
        () => deviceAnswerClient.setEnabled(payload),
        payload.enabled ? "Couldn't turn it on." : "Couldn't turn it off."
      ),
    createPairingCode: () =>
      run(() => deviceAnswerClient.createPairingCode(), "Couldn't make a pairing code.").then(
        () => {}
      ),
    cancelPairingCode: () =>
      run(() => deviceAnswerClient.cancelPairingCode(), "Couldn't cancel the code.").then(() => {}),
    revokeDevice: (deviceId) =>
      run(() => deviceAnswerClient.revokeDevice(deviceId), "Couldn't remove that device.").then(
        () => {}
      ),
  };
}
