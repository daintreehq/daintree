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

// A chosen device of "" (system default) or one of Chromium's alias entries
// names no particular mic, so whichever one opens is the one asked for.
export function isSpecificMicId(deviceId: string): boolean {
  return deviceId !== "" && !PSEUDO_DEVICE_IDS.has(deviceId);
}

export function isMicPermissionDenial(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

// The device couldn't be found or started. A denial, or a programming or
// document-state error, would fail the same way on any other mic.
const MIC_DEVICE_FAILURES = new Set([
  "NotReadableError",
  "NotFoundError",
  "OverconstrainedError",
  "AbortError",
]);

function isMicDeviceFailure(error: unknown): boolean {
  return error instanceof DOMException && MIC_DEVICE_FAILURES.has(error.name);
}

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

export interface OpenedMic {
  stream: MediaStream;
  /** The device the track reports it opened; null when it doesn't say. */
  deviceId: string | null;
  /** Its name, without Chromium's alias prefix; null when it has none. */
  label: string | null;
  /** A particular mic was chosen and a different one opened. */
  substituted: boolean;
  /** Why the chosen mic failed to open before the system default did; null when it didn't. */
  chosenFailure: unknown;
  /**
   * The chosen mic's id as listed now, when that differs from the one asked
   * for: its saved id went stale and its name found it again. Null otherwise.
   */
  relocatedId: string | null;
}

const SYSTEM_DEFAULT_MIC: MediaStreamConstraints = { audio: true, video: false };

interface ListedMic {
  deviceId: string;
  groupId: string;
  label: string;
}

/**
 * Opens the mic dictation records from, by the rules dictation and the mic
 * test share: the chosen mic whenever it is connected and opens, the system
 * default otherwise. The chosen mic is asked for as `exact`: Chromium treats
 * an `ideal` device as a preference it can overrule, and binds the "default"
 * alias instead, which follows the system input to a headset that just
 * connected (#15512). A chosen mic the listing shows isn't connected opens
 * the default straight away; one that is listed but won't start, or that the
 * listing couldn't vouch for, rejects and the default is asked for here. Only
 * a device failure falls back: a permission denial is final, and
 * `canFallBack` lets a caller whose start went stale skip opening a mic at
 * all. Rejects with the last attempt's error.
 *
 * Chromium's device ids are salted per origin and can be reset, so a saved id
 * can stop naming anything: `chosenLabel`, the name saved with it, finds the
 * mic again when exactly one listed mic has that name. A track reporting the
 * "default" alias is the chosen mic when it is the same physical device, by
 * group where both say, by name otherwise.
 */
export async function openChosenMic(
  deviceId: string,
  options: { canFallBack?: () => boolean; chosenLabel?: string } = {}
): Promise<OpenedMic> {
  const specific = isSpecificMicId(deviceId);
  const chosenLabel = options.chosenLabel ? stripPseudoDevicePrefix(options.chosenLabel) : "";
  const listing = specific ? await findChosenMic(deviceId, chosenLabel) : null;
  if (specific && options.canFallBack?.() === false) {
    throw new DOMException("The microphone request was superseded", "AbortError");
  }
  const chosen = listing?.chosen ?? null;
  const targetId = chosen?.deviceId ?? deviceId;
  let stream: MediaStream;
  let chosenFailure: unknown = null;
  const askForChosen = specific && !(listing?.complete && !chosen);
  if (!askForChosen) {
    stream = await navigator.mediaDevices.getUserMedia(SYSTEM_DEFAULT_MIC);
  } else {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: targetId } },
        video: false,
      });
    } catch (error) {
      if (!isMicDeviceFailure(error) || options.canFallBack?.() === false) throw error;
      chosenFailure = error;
      stream = await navigator.mediaDevices.getUserMedia(SYSTEM_DEFAULT_MIC);
    }
  }

  let actualId: string | null = null;
  let groupId: string | null = null;
  let label: string | null = null;
  try {
    const track = stream.getAudioTracks()[0];
    label = track?.label ? stripPseudoDevicePrefix(track.label) || null : null;
    const settings = track?.getSettings?.();
    actualId = settings?.deviceId || null;
    groupId = settings?.groupId || null;
  } catch {
    // A track that can't describe itself still records; only the naming is lost.
  }

  let openedChosen: boolean;
  if (actualId === null) openedChosen = askForChosen && chosenFailure === null;
  else if (isSpecificMicId(actualId)) openedChosen = actualId === targetId;
  else {
    // An alias opened. A shared group says it is the chosen mic; a name alone
    // can't, once the chosen mic failed and the default is some other device.
    openedChosen =
      chosen !== null &&
      (groupId && chosen.groupId
        ? groupId === chosen.groupId
        : chosenFailure === null && label === chosen.label);
  }
  return {
    stream,
    deviceId: actualId,
    label,
    substituted: specific && !openedChosen,
    chosenFailure,
    relocatedId: chosen && chosen.deviceId !== deviceId ? chosen.deviceId : null,
  };
}

interface MicListing {
  /** The chosen mic as listed now, or null when the listing doesn't show it. */
  chosen: ListedMic | null;
  /**
   * Every input was listed with its id and name, so a chosen mic missing from
   * it isn't connected. False before permission, when entries come back blank.
   */
  complete: boolean;
}

// The chosen mic as listed now: by its id, else by its saved name when exactly
// one mic has it. Unnamed entries (no permission yet) can't be matched. Null
// when the mics couldn't be listed at all.
async function findChosenMic(deviceId: string, label: string): Promise<MicListing | null> {
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput"
    );
    const complete = all.length > 0 && all.every((device) => device.deviceId && device.label);
    const inputs = all
      .filter((device) => isSpecificMicId(device.deviceId))
      .map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        label: stripPseudoDevicePrefix(device.label),
      }));
    const listed = inputs.find((device) => device.deviceId === deviceId);
    if (listed) return { chosen: listed, complete };
    const named = label ? inputs.filter((device) => device.label === label) : [];
    return { chosen: named.length === 1 ? named[0]! : null, complete };
  } catch {
    return null;
  }
}
