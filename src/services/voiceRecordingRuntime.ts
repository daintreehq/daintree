import type { VoiceInputSettings } from "@shared/types";
import { transcribesOnDevice, transcriptionProviderReady } from "@shared/config/voiceProviders";
import {
  isLocalModelReady,
  readLocalModelStatus,
  subscribeLocalModelStatus,
} from "@/clients/localSpeechModelClient";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";
import { isDragCancelEscape } from "@/lib/dragCancelEscape";
import { keybindingService } from "@/services/KeybindingService";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { logDebug, logWarn } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import type { VoiceSendOptions, voiceRecordingService } from "./VoiceRecordingService";

// The recording service is one of the renderer's largest chunks, and voice
// input is off by default. This module is what the rest of the renderer holds
// instead: it loads the service once dictation is configured, or when
// something asks it to start, and keeps what has to exist before that.

export type VoiceRecordingServiceInstance = typeof voiceRecordingService;

const LOG_PREFIX = "[VoiceRecordingRuntime]";

let service: VoiceRecordingServiceInstance | null = null;
let loading: Promise<VoiceRecordingServiceInstance> | null = null;

/**
 * Configured means the selected provider has what it transcribes with: its own
 * key, or for on-device transcription, the model installed and checked (as
 * this view last heard). The cleanup key is separate.
 */
export function isVoiceInputConfigured(
  settings: VoiceInputSettings,
  localModelReady: boolean = isLocalModelReady()
): boolean {
  return settings.enabled && transcriptionProviderReady(settings, localModelReady);
}

/**
 * The service once it has initialized, else null. Never loads it: before then
 * there is no session, correction or held-back dictation for a caller to find.
 */
export function getLoadedVoiceRecordingService(): VoiceRecordingServiceInstance | null {
  return service;
}

/**
 * The service, imported and initialized on first call. `settings`, when the
 * caller has just read them, spares the service reading them again.
 */
export function loadVoiceRecordingService(
  settings?: VoiceInputSettings
): Promise<VoiceRecordingServiceInstance> {
  if (service) return Promise.resolve(service);
  loading ??= import("./VoiceRecordingService")
    .then(({ voiceRecordingService }) => {
      voiceRecordingService.initialize(settings);
      service = voiceRecordingService;
      return voiceRecordingService;
    })
    .catch((error: unknown) => {
      // Nothing cached, so the next caller tries again.
      loading = null;
      throw error;
    });
  return loading;
}

function logLoadFailure(error: unknown): void {
  logWarn(`${LOG_PREFIX} Couldn't load voice dictation`, voiceErrorLogFields(error));
}

/**
 * Runs `run` with the service: at once when it is loaded, as a click handler
 * calling it directly would, else once it loads. A load that fails is logged.
 */
export function withVoiceRecordingService(
  run: (service: VoiceRecordingServiceInstance) => unknown
): void {
  if (service) {
    run(service);
    return;
  }
  loadVoiceRecordingService()
    .then((loaded) => {
      run(loaded);
    })
    .catch(logLoadFailure);
}

/**
 * Called by the service itself as it initializes or is destroyed, whoever
 * started it: the Canopy window initializes it directly.
 */
export function setInitializedVoiceRecordingService(
  instance: VoiceRecordingServiceInstance | null
): void {
  service = instance;
  // A destroyed singleton (HMR) is never handed out again.
  if (!instance) loading = null;
}

const spokenSendHandlers = new Map<string, (options?: VoiceSendOptions) => void>();

const spokenSendKey = (panelId: string, projectId: string | undefined) =>
  `${projectId ?? ""}\0${panelId}`;

/**
 * Registers the composer's send for a spoken "send it". Kept here so a
 * composer mounted before the service loads is still heard once it does.
 */
export function onSpokenSend(
  panelId: string,
  projectId: string | undefined,
  handler: (options?: VoiceSendOptions) => void
): () => void {
  const key = spokenSendKey(panelId, projectId);
  spokenSendHandlers.set(key, handler);
  return () => {
    if (spokenSendHandlers.get(key) === handler) spokenSendHandlers.delete(key);
  };
}

export function getSpokenSendHandler(
  panelId: string,
  projectId: string | undefined
): ((options?: VoiceSendOptions) => void) | undefined {
  return spokenSendHandlers.get(spokenSendKey(panelId, projectId));
}

export function clearSpokenSendHandlers(): void {
  spokenSendHandlers.clear();
}

// Every action that starts recording has to arm the release, or a second
// override combo would start push-to-talk that its keyup can't stop.
const VOICE_START_ACTION_IDS = [
  "voiceInput.toggle",
  "voiceInput.toggleAssistant",
  "voiceInput.rewriteSelection",
] as const;

export function isVoiceStartAction(actionId: string): boolean {
  return VOICE_START_ACTION_IDS.some((id) => id === actionId);
}

/** Whether this keystroke is a single-key combo of an action that starts recording. */
export function matchesVoiceStartShortcut(e: KeyboardEvent): boolean {
  for (const actionId of VOICE_START_ACTION_IDS) {
    for (const combo of keybindingService.getEffectiveCombos(actionId)) {
      if (keybindingService.matchesEvent(e, combo)) return true;
    }
  }
  return false;
}

/** A voice key pressed while no listener of the service's could see it. */
export interface PendingVoiceShortcutPress {
  code: string;
  timeStamp: number;
  pressedAt: number;
  released: boolean;
}

let pendingPress: PendingVoiceShortcutPress | null = null;
let stopWatchingPress: (() => void) | null = null;

function forgetPendingPress(): void {
  stopWatchingPress?.();
  stopWatchingPress = null;
  pendingPress = null;
}

/**
 * The keybinding resolver hands over a voice key it is about to dispatch. The
 * service's own capture listener records the press whenever dictation is on
 * here; otherwise the press is kept, with whether it has come back up, until
 * the action that loads the service takes it, so a hold still ends on release.
 */
export function noteVoiceShortcutKeydown(e: KeyboardEvent): void {
  forgetPendingPress();
  if (service?.recordsShortcutPresses()) return;
  if (e.repeat || !matchesVoiceStartShortcut(e)) return;
  const press: PendingVoiceShortcutPress = {
    code: e.code,
    timeStamp: e.timeStamp,
    pressedAt: performance.now(),
    released: false,
  };
  const release = () => {
    press.released = true;
    stopWatchingPress?.();
    stopWatchingPress = null;
  };
  // The same releases the service's own listeners take: the key, or Meta,
  // whose keyup macOS delivers in place of the key's.
  const onKeyUp = (event: KeyboardEvent) => {
    if (isDragCancelEscape(event)) return;
    if (event.code === press.code || event.code === "MetaLeft" || event.code === "MetaRight") {
      release();
    }
  };
  window.addEventListener("keyup", onKeyUp, { capture: true });
  window.addEventListener("blur", release);
  stopWatchingPress = () => {
    window.removeEventListener("keyup", onKeyUp, { capture: true });
    window.removeEventListener("blur", release);
  };
  pendingPress = press;
}

/** The press a keybinding dispatch is running for, once; null when none is waiting. */
export function takePendingVoiceShortcutPress(): PendingVoiceShortcutPress | null {
  const press = pendingPress;
  forgetPendingPress();
  return press;
}

/**
 * Loads the service when this view finds dictation configured: once at boot,
 * and again when Settings turn it on here or another view's session is
 * reported. Until then nothing of the service runs, and no keystroke reaches
 * it. Returns the teardown.
 */
export function startVoiceRecordingRuntime(): () => void {
  const voiceInput = window.electron?.voiceInput;
  if (!voiceInput) {
    logWarn(`${LOG_PREFIX} window.electron.voiceInput not available`);
    return () => {};
  }

  let disposed = false;
  let loadRequested = false;
  // Bumped by every settings change: a read it overtook is not trusted.
  let generation = 0;
  const unsubscribers: Array<() => void> = [];
  const stopWatching = () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
  const load = (settings?: VoiceInputSettings) => {
    if (disposed || loadRequested) return;
    loadRequested = true;
    const requestedAt = generation;
    loadVoiceRecordingService(settings).then(
      (loaded) => {
        // The service watches from here. A change made while its chunk loaded
        // reached neither it nor the settings it was handed.
        stopWatching();
        if (generation !== requestedAt) {
          loaded.refreshConfiguration().catch((error: unknown) => {
            logDebug(`${LOG_PREFIX} Couldn't read voice settings`, voiceErrorLogFields(error));
          });
        }
      },
      (error: unknown) => {
        // Still watching, so the next change or session tries again.
        loadRequested = false;
        logLoadFailure(error);
      }
    );
  };

  const readSettings = () => {
    const readAt = generation;
    voiceInput
      .getSettings()
      .then(async (settings) => {
        if (disposed || service || generation !== readAt) return;
        // On-device transcription is ready once its model is: ask main, which
        // checks the files, before deciding.
        if (settings.enabled && transcribesOnDevice(settings.transcriptionProvider)) {
          await readLocalModelStatus();
          if (disposed || service || generation !== readAt) return;
        }
        if (isVoiceInputConfigured(settings)) load(settings);
      })
      .catch((error: unknown) => {
        logDebug(`${LOG_PREFIX} Couldn't read voice settings`, voiceErrorLogFields(error));
      });
  };

  // Read afresh rather than taken from the event: it carries what the tab
  // last saw, not what main stored.
  const handleSettingsChanged = () => {
    generation++;
    // Loaded some other way (an action, a click), the service has its own.
    if (service) {
      stopWatching();
      return;
    }
    if (!loadRequested) readSettings();
  };
  window.addEventListener(VOICE_INPUT_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
  // A model downloaded from any view makes on-device dictation ready here too.
  unsubscribers.push(
    subscribeLocalModelStatus((status) => {
      if (status.state === "ready") handleSettingsChanged();
    })
  );
  unsubscribers.push(() =>
    window.removeEventListener(VOICE_INPUT_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
  );

  // Settings changed in another view never reach this one, but a session
  // started there does: dictation is on after all. The service pulls the
  // session again as it initializes.
  unsubscribers.push(
    voiceInput.onLiveSession((update) => {
      // Loaded some other way (an action, a click), the service has its own.
      if (service) {
        stopWatching();
        return;
      }
      if (!update.session) return;
      useVoiceRecordingStore.getState().applyLiveSessionUpdate(update);
      load();
    })
  );

  readSettings();

  return () => {
    disposed = true;
    stopWatching();
  };
}
