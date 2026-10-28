import { useCallback, useSyncExternalStore } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import { isSpecificMicId } from "@/services/voiceMicDevices";

export interface AudioDevice {
  value: string;
  label: string;
  description?: string;
}

/** Sentinel value for the "System default" option in Radix Select (which rejects empty strings). */
export const SYSTEM_DEFAULT_VALUE = "__system_default__";

const SYSTEM_DEFAULT_DEVICE: AudioDevice = {
  value: SYSTEM_DEFAULT_VALUE,
  label: "System default",
  description: "Follows the system input, headsets included",
};

interface Snapshot {
  devices: AudioDevice[];
  loading: boolean;
  error: string | null;
  /**
   * The last enumeration answered and named every device, so a mic missing
   * from `devices` really isn't connected. False before permission is granted,
   * when devices come back unnamed.
   */
  complete: boolean;
}

let cachedDevices: AudioDevice[] | null = null;
let cachedError: string | null = null;
let cachedLoading = true;
let cachedComplete = false;
let listeners: Array<() => void> = [];
let subscribedToDeviceChange = false;
let enumerationGen = 0;
let stableSnapshot: Snapshot = {
  devices: [SYSTEM_DEFAULT_DEVICE],
  loading: true,
  error: null,
  complete: false,
};

function notifyListeners() {
  stableSnapshot = {
    devices: cachedDevices ?? [SYSTEM_DEFAULT_DEVICE],
    loading: cachedLoading,
    error: cachedError,
    complete: cachedComplete,
  };
  for (const listener of listeners) {
    listener();
  }
}

async function refreshDevices(): Promise<void> {
  const gen = ++enumerationGen;

  if (!navigator?.mediaDevices?.enumerateDevices) {
    cachedDevices = [SYSTEM_DEFAULT_DEVICE];
    cachedError = "Media devices API not available";
    cachedComplete = false;
    cachedLoading = false;
    notifyListeners();
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (gen !== enumerationGen) return;
    const audioInputs = devices.filter((d) => d.kind === "audioinput");
    // Chromium's "default" and "communications" entries alias a real mic and
    // follow the OS, so picking one by its name would track whatever the
    // system switches to. Unnamed entries (no permission yet) can't be chosen.
    const choices = audioInputs.filter((d) => isSpecificMicId(d.deviceId));
    cachedDevices = [
      SYSTEM_DEFAULT_DEVICE,
      ...choices.map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })),
    ];
    cachedError = null;
    cachedComplete = audioInputs.every((d) => d.deviceId !== "");
  } catch (err) {
    if (gen !== enumerationGen) return;
    cachedDevices = [SYSTEM_DEFAULT_DEVICE];
    cachedComplete = false;
    cachedError = `Could not enumerate audio devices: ${formatErrorMessage(err, "enumerate audio devices")}`;
    logWarn("useAudioDevices enumerateDevices failed", voiceErrorLogFields(err));
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
  cachedComplete = false;
  listeners = [];
  subscribedToDeviceChange = false;
  enumerationGen = 0;
  stableSnapshot = {
    devices: [SYSTEM_DEFAULT_DEVICE],
    loading: true,
    error: null,
    complete: false,
  };
}
