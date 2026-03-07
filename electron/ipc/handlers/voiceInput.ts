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

function buildProjectContext(): string | undefined {
  const projects = store.get("projects");
  const currentId = projects?.currentProjectId;
  if (!currentId) return undefined;
  const project = projects?.list?.find((p) => p.id === currentId);
  if (!project?.name) return undefined;
  return project.name;
}

export function registerVoiceInputHandlers(deps: HandlerDependencies): () => void {
  const handleGetSettings = async () => {
    return store.get("voiceInput");
  };

  const handleSetSettings = async (
    _event: Electron.IpcMainInvokeEvent,
    patch: Partial<VoiceInputSettings>
  ) => {
    const current = store.get("voiceInput");
    store.set("voiceInput", { ...current, ...patch });
  };

  const handleStart = async (event: Electron.IpcMainInvokeEvent) => {
    const svc = getService();
    const settings = store.get("voiceInput") as VoiceInputSettings;

    // Clean up any existing subscription before starting a new session
    cleanupActiveSubscription();

    // Initialize (or reset) the correction service for this session
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }
    correctionService.resetHistory();

    // Build project context from the active project name if available
    const projectContext = buildProjectContext();

    const unsubscribe = svc.onEvent((voiceEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;

      if (voiceEvent.type === "delta") {
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, voiceEvent.text);
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text;
        if (settings.correctionEnabled && settings.apiKey) {
          // Apply correction asynchronously before forwarding to the renderer.
          // Falls back to raw text on timeout or error.
          void correctionService!
            .correct(rawText, {
              model: settings.correctionModel,
              systemPrompt: settings.correctionSystemPrompt,
              apiKey: settings.apiKey,
              customDictionary: settings.customDictionary,
              projectContext,
            })
            .then((finalText) => {
              if (!win.isDestroyed()) {
                win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, finalText);
              }
            });
        } else {
          win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, rawText);
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
