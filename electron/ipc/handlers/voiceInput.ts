import { ipcMain, systemPreferences, shell } from "electron";
import { spawn } from "child_process";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { VoiceTranscriptionService } from "../../services/VoiceTranscriptionService.js";
import { VoiceCorrectionService } from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies } from "../types.js";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";

let service: VoiceTranscriptionService | null = null;
let activeEventUnsubscribe: (() => void) | null = null;
let correctionService: VoiceCorrectionService | null = null;

const VOICE_INPUT_DEFAULTS: VoiceInputSettings = {
  enabled: false,
  apiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionModel: "gpt-4o-mini-transcribe",
  correctionEnabled: false,
  correctionModel: "gpt-5-nano",
  correctionCustomInstructions: "",
};

/** Read voiceInput settings with defaults for fields added after initial store creation. */
function getVoiceSettings(): VoiceInputSettings {
  const stored = store.get("voiceInput") as Partial<VoiceInputSettings> | undefined;
  return { ...VOICE_INPUT_DEFAULTS, ...stored };
}

function getService(): VoiceTranscriptionService {
  if (!service) {
    service = new VoiceTranscriptionService();
  }
  return service;
}

function cleanupActiveSubscription(): void {
  if (activeEventUnsubscribe) {
    activeEventUnsubscribe();
    activeEventUnsubscribe = null;
  }
}

export type MicPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

function checkMicPermission(): MicPermissionStatus {
  if (process.platform === "darwin" || process.platform === "win32") {
    return systemPreferences.getMediaAccessStatus("microphone") as MicPermissionStatus;
  }
  // Linux doesn't have a system-level media access API
  return "unknown";
}

async function requestMicPermission(): Promise<boolean> {
  if (process.platform === "darwin") {
    return systemPreferences.askForMediaAccess("microphone");
  }
  // On Windows/Linux, permission is requested via getUserMedia in the renderer
  return false;
}

function openMicSettings(): void {
  if (process.platform === "darwin") {
    void shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    );
  } else if (process.platform === "win32") {
    void shell.openExternal("ms-settings:privacy-microphone");
  } else {
    // Linux: try gnome-control-center, fall back silently
    try {
      spawn("gnome-control-center", ["sound"], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // No standard way to open mic settings on Linux
    }
  }
}

async function validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey.trim()) {
    return { valid: false, error: "API key is required" };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401) {
      return { valid: false, error: "Invalid API key" };
    }

    if (response.status === 429) {
      // Rate limited but key is valid
      return { valid: true };
    }

    return { valid: false, error: `API returned status ${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { valid: false, error: "Connection timed out" };
    }
    return { valid: false, error: "Failed to connect to OpenAI" };
  }
}

function getProjectInfo(): { name?: string; path?: string } {
  const projects = store.get("projects");
  const currentId = projects?.currentProjectId;
  if (!currentId) return {};
  const project = projects?.list?.find((p) => p.id === currentId);
  return { name: project?.name, path: project?.path };
}

export function registerVoiceInputHandlers(deps: HandlerDependencies): () => void {
  const handleGetSettings = async () => {
    return getVoiceSettings();
  };

  const handleSetSettings = async (
    _event: Electron.IpcMainInvokeEvent,
    patch: Partial<VoiceInputSettings>
  ) => {
    const current = getVoiceSettings();
    store.set("voiceInput", { ...current, ...patch });
  };

  const handleStart = async (event: Electron.IpcMainInvokeEvent) => {
    const svc = getService();
    // Snapshot transcription settings at session start (model, language, API key).
    // Correction settings are read live from store per-event so mid-session changes apply.
    const settings = getVoiceSettings();

    // Clean up any existing subscription before starting a new session
    cleanupActiveSubscription();

    // Initialize (or reset) the correction service for this session
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }
    correctionService.resetHistory();

    // Capture project info at session start for the correction prompt context
    const projectInfo = getProjectInfo();

    const unsubscribe = svc.onEvent((voiceEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;

      if (voiceEvent.type === "delta") {
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, voiceEvent.text);
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();

        // Read correction settings live so mid-session changes take effect immediately.
        // Use getVoiceSettings() to ensure new fields have defaults even if the
        // persisted object predates their addition.
        const liveSettings = getVoiceSettings();
        const willCorrect = !!(liveSettings.correctionEnabled && liveSettings.apiKey);

        // Send raw text + whether correction will happen so the renderer knows
        // whether to mark text as pending (grayed) or finalize it immediately.
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          text: rawText,
          willCorrect,
        });

        if (willCorrect) {
          void correctionService!
            .correct(rawText, {
              model: liveSettings.correctionModel,
              apiKey: liveSettings.apiKey,
              customDictionary: liveSettings.customDictionary,
              customInstructions: liveSettings.correctionCustomInstructions,
              projectName: projectInfo.name,
              projectPath: projectInfo.path,
            })
            .then((correctedText) => {
              if (!win.isDestroyed()) {
                win.webContents.send(CHANNELS.VOICE_INPUT_CORRECTION_REPLACE, {
                  rawText,
                  correctedText,
                });
              }
            });
        }
      } else if (voiceEvent.type === "error") {
        win.webContents.send(CHANNELS.VOICE_INPUT_ERROR, voiceEvent.message);
      } else if (voiceEvent.type === "status") {
        win.webContents.send(CHANNELS.VOICE_INPUT_STATUS, voiceEvent.status);
      }
    });

    activeEventUnsubscribe = unsubscribe;

    // Also clean up if the renderer is destroyed unexpectedly
    const onDestroyed = () => {
      if (activeEventUnsubscribe === unsubscribe) {
        activeEventUnsubscribe = null;
      }
      unsubscribe();
      service?.stop();
    };
    event.sender.once("destroyed", onDestroyed);

    const result = await svc.start(settings);
    if (!result.ok) {
      // Failed to start — clean up subscription immediately
      if (activeEventUnsubscribe === unsubscribe) {
        activeEventUnsubscribe = null;
      }
      unsubscribe();
      event.sender.removeListener("destroyed", onDestroyed);
    }
    return result;
  };

  const handleStop = async () => {
    if (service) {
      // Drain first (waits for pending transcriptions), then clean up subscription.
      await service.stopGracefully();
    }
    cleanupActiveSubscription();
  };

  const handleAudioChunk = (_event: Electron.IpcMainInvokeEvent, chunk: ArrayBuffer) => {
    service?.sendAudioChunk(chunk);
  };

  const handleCheckMicPermission = () => {
    return checkMicPermission();
  };

  const handleRequestMicPermission = async () => {
    return requestMicPermission();
  };

  const handleOpenMicSettings = () => {
    openMicSettings();
  };

  const handleValidateApiKey = async (_event: Electron.IpcMainInvokeEvent, apiKey: string) => {
    return validateOpenAIKey(apiKey);
  };

  ipcMain.handle(CHANNELS.VOICE_INPUT_GET_SETTINGS, handleGetSettings);
  ipcMain.handle(CHANNELS.VOICE_INPUT_SET_SETTINGS, handleSetSettings);
  ipcMain.handle(CHANNELS.VOICE_INPUT_START, handleStart);
  ipcMain.handle(CHANNELS.VOICE_INPUT_STOP, handleStop);
  ipcMain.on(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, handleAudioChunk);
  ipcMain.handle(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION, handleCheckMicPermission);
  ipcMain.handle(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION, handleRequestMicPermission);
  ipcMain.handle(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS, handleOpenMicSettings);
  ipcMain.handle(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, handleValidateApiKey);

  return () => {
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_GET_SETTINGS);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_SET_SETTINGS);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_START);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_STOP);
    ipcMain.removeListener(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, handleAudioChunk);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY);
    cleanupActiveSubscription();
    service?.destroy();
    service = null;
    correctionService = null;
  };
}
