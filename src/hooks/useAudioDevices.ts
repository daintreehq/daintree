import { useCallback, useSyncExternalStore } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";

export interface AudioDevice {
  value: string;
  label: string;
}

/** Sentinel value for the "System default" option in Radix Select (which rejects empty strings). */
export const SYSTEM_DEFAULT_VALUE = "__system_default__";

interface Snapshot {
  devices: AudioDevice[];
  loading: boolean;
  error: string | null;
}

let cachedDevices: AudioDevice[] | null = null;
let cachedError: string | null = null;
let cachedLoading = true;
let listeners: Array<() => void> = [];
let subscribedToDeviceChange = false;
let enumerationGen = 0;
let stableSnapshot: Snapshot = {
  devices: [{ value: SYSTEM_DEFAULT_VALUE, label: "System default" }],
  loading: true,
  error: null,
};

function notifyListeners() {
  stableSnapshot = {
    devices: cachedDevices ?? [{ value: SYSTEM_DEFAULT_VALUE, label: "System default" }],
    loading: cachedLoading,
    error: cachedError,
  };
  for (const listener of listeners) {
    listener();
  }
}

async function refreshDevices(): Promise<void> {
  const gen = ++enumerationGen;

  if (!navigator?.mediaDevices?.enumerateDevices) {
    cachedDevices = [{ value: SYSTEM_DEFAULT_VALUE, label: "System default" }];
    cachedError = "Media devices API not available";
    cachedLoading = false;
    notifyListeners();
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (gen !== enumerationGen) return;
    const audioInputs = devices.filter((d) => d.kind === "audioinput");
    cachedDevices = [
      { value: SYSTEM_DEFAULT_VALUE, label: "System default" },
      ...audioInputs.map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })),
    ];
    cachedError = null;
  } catch (err) {
    if (gen !== enumerationGen) return;
    cachedDevices = [{ value: SYSTEM_DEFAULT_VALUE, label: "System default" }];
    cachedError = `Could not enumerate audio devices: ${formatErrorMessage(err, "enumerate audio devices")}`;
    logWarn("useAudioDevices enumerateDevices failed", { err });
  }

  if (gen !== enumerationGen) return;
  cachedLoading = false;
  notifyListeners();
}

function getSnapshot(): Snapshot {
  return stableSnapshot;
}

function subscribe(callback: () => void): () => void {
  listeners = [...listeners, callback];

  // App-lifetime listener: never detached, so remount cycles reuse the single
  // subscription instead of stacking unremovable anonymous handlers.
  if (!subscribedToDeviceChange && navigator?.mediaDevices?.addEventListener) {
    subscribedToDeviceChange = true;
    navigator.mediaDevices.addEventListener("devicechange", () => {
      cachedLoading = true;
      notifyListeners();
      void refreshDevices();
    });
  }

  if (cachedDevices === null) {
    void refreshDevices();
  }

  return () => {
    listeners = listeners.filter((l) => l !== callback);
  };
}

export function useAudioDevices(): Snapshot & { refresh: () => void } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    // eslint-disable-next-line react-compiler/react-compiler -- module-level state writes are the point of this useSyncExternalStore hook
    cachedLoading = true;
    notifyListeners();
    void refreshDevices();
  }, []);

  return { ...snapshot, refresh };
}

/** Reset all module-level state. Only for test isolation. */
export function __resetForTesting(): void {
  cachedDevices = null;
  cachedError = null;
  cachedLoading = true;
  listeners = [];
  subscribedToDeviceChange = false;
  enumerationGen = 0;
  stableSnapshot = {
    devices: [{ value: SYSTEM_DEFAULT_VALUE, label: "System default" }],
    loading: true,
    error: null,
  };
}
