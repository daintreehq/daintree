export interface VoiceMicDevice {
  deviceId: string;
  label: string;
}

// Chromium lists the OS default and the Windows communications device as
// pseudo-entries that alias a real one; only the real entry is a choice.
const PSEUDO_DEVICE_IDS = new Set(["default", "communications"]);
const PSEUDO_LABEL_PREFIX = /^(default|communications)\s+-\s+/i;

// Device names come straight from the OS: CoreAudio names on macOS (sometimes
// with a "(Bluetooth)" or "(Built-in)" transport suffix), endpoint friendly
// names on Windows ("Headset (AirPods Hands-Free AG Audio)"), PulseAudio or
// PipeWire descriptions on Linux ("... (HSP/HFP)", bluez). A bare "headset" is
// left out: wired headsets use it too.
const BLUETOOTH_LABEL =
  /\bbluetooth\b|\bairpods\b|\bbeats\b|\bbuds\b|hands-?free|\bbluez|\bhsp\b|\bhfp\b/i;

const BUILT_IN_LABEL = /\bbuilt-?in\b|\binternal\b|\b(?:macbook(?: pro| air)?|imac) microphone\b/i;
// A laptop's array mic on Windows; only a fallback, since the name doesn't say
// where the array is.
const LIKELY_BUILT_IN_LABEL = /^microphone array\b/i;

export function stripPseudoDevicePrefix(label: string): string {
  return label.replace(PSEUDO_LABEL_PREFIX, "").trim();
}

export function isBluetoothMicLabel(label: string | null | undefined): boolean {
  return !!label && BLUETOOTH_LABEL.test(label);
}

/**
 * The built-in microphone among `devices`, or null when none can be told
 * apart from the rest by its name.
 */
export function findBuiltInMic(devices: readonly VoiceMicDevice[]): VoiceMicDevice | null {
  const candidates = devices
    .filter((device) => device.deviceId && !PSEUDO_DEVICE_IDS.has(device.deviceId))
    .map((device) => ({ deviceId: device.deviceId, label: stripPseudoDevicePrefix(device.label) }))
    .filter((device) => device.label && !isBluetoothMicLabel(device.label));
  return (
    candidates.find((device) => BUILT_IN_LABEL.test(device.label)) ??
    candidates.find((device) => LIKELY_BUILT_IN_LABEL.test(device.label)) ??
    null
  );
}
