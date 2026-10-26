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
// left out: wired headsets use it too. Only the warning's wording depends on
// this; the built-in mic is offered either way.
const BLUETOOTH_LABEL =
  /\bbluetooth\b|\bairpods\b|\bbeats\b|\bbuds\b|hands-?free|\bbluez|\bhsp\b|\bhfp\b/i;

// Strongest first: the Mac's own mic by name, then anything that says it is
// built in. A Mac's headphone-jack input is "External Microphone (Built-in)",
// which is the wired headset's mic, not the laptop's.
const MAC_MIC_LABEL = /\b(?:macbook(?: pro| air)?|imac) microphone\b/i;
const BUILT_IN_LABEL = /\bbuilt-?in\b|\binternal\b/i;
const EXTERNAL_LABEL = /\bexternal\b|\busb\b|\([0-9a-f]{4}:[0-9a-f]{4}\)/i;
// A laptop's array mic on Windows. The name doesn't say where the array is, so
// it counts only when it is the one such device and says nothing external.
const MIC_ARRAY_LABEL = /^microphone array\b/i;

export function stripPseudoDevicePrefix(label: string): string {
  return label.replace(PSEUDO_LABEL_PREFIX, "").trim();
}

export function isBluetoothMicLabel(label: string | null | undefined): boolean {
  return !!label && BLUETOOTH_LABEL.test(label);
}

/**
 * The built-in microphone among `devices`, or null when none can be told
 * apart from the rest by its name. Never a Bluetooth or external device.
 */
export function findBuiltInMic(devices: readonly VoiceMicDevice[]): VoiceMicDevice | null {
  const candidates = devices
    .filter((device) => device.deviceId && !PSEUDO_DEVICE_IDS.has(device.deviceId))
    .map((device) => ({ deviceId: device.deviceId, label: stripPseudoDevicePrefix(device.label) }))
    .filter(
      (device) =>
        device.label && !isBluetoothMicLabel(device.label) && !EXTERNAL_LABEL.test(device.label)
    );
  const named =
    candidates.find((device) => MAC_MIC_LABEL.test(device.label)) ??
    candidates.find((device) => BUILT_IN_LABEL.test(device.label));
  if (named) return named;
  const arrays = candidates.filter((device) => MIC_ARRAY_LABEL.test(device.label));
  return arrays.length === 1 ? arrays[0]! : null;
}
