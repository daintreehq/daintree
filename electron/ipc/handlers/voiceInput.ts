import { ipcMain, systemPreferences, shell } from "electron";
import { spawn } from "child_process";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import { VoiceTranscriptionService } from "../../services/VoiceTranscriptionService.js";
import { VoiceCorrectionService } from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies } from "../types.js";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";

let service: VoiceTranscriptionService | null = null;
let activeEventUnsubscribe: (() => void) | null = null;
let activeDestroyListener: { sender: Electron.WebContents; fn: () => void } | null = null;
let correctionService: VoiceCorrectionService | null = null;

/** Utterances accumulated since the last paragraph boundary. */
let paragraphBuffer: string[] = [];
/** Project info captured at session start for correction prompts. */
let sessionProjectInfo: { name?: string; path?: string } = {};

const VOICE_INPUT_DEFAULTS: VoiceInputSettings = {
  enabled: false,
  deepgramApiKey: "",
  correctionApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionModel: "nova-3",
  correctionEnabled: false,
  correctionModel: "gpt-5-nano",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
};

/** Read voiceInput settings with defaults for fields added after initial store creation. */
function getVoiceSettings(): VoiceInputSettings {
  const stored = store.get("voiceInput") as
    | (Partial<VoiceInputSettings> & { apiKey?: string })
    | undefined;
  const merged = { ...VOICE_INPUT_DEFAULTS, ...stored };

  // Migrate legacy apiKey (OpenAI sk-* key) to correctionApiKey.
  // The deepgramApiKey field is new and must be set explicitly by the user.
  if (stored?.apiKey && !stored.deepgramApiKey && !stored.correctionApiKey) {
    if (stored.apiKey.startsWith("sk-")) {
      merged.correctionApiKey = stored.apiKey;
    }
  }

  return merged;
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
  if (activeDestroyListener) {
    activeDestroyListener.sender.removeListener("destroyed", activeDestroyListener.fn);
    activeDestroyListener = null;
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

async function validateDeepgramKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey.trim()) {
    return { valid: false, error: "API key is required" };
  }

  try {
    const response = await fetch("https://api.deepgram.com/v1/auth/token", {
      method: "GET",
      headers: {
        Authorization: `Token ${apiKey.trim()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }

    return { valid: false, error: `API returned status ${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { valid: false, error: "Connection timed out" };
    }
    return { valid: false, error: "Failed to connect to Deepgram" };
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
  const currentProject = projectStore.getCurrentProject();
  if (!currentProject) return {};
  return { name: currentProject.name, path: currentProject.path };
}

/**
 * Join the paragraph buffer into a single raw text string and clear it.
 * If correction is enabled, generates a stable correctionId, fires an async
 * correction call, and sends VOICE_INPUT_CORRECTION_REPLACE when it resolves.
 * Returns the raw paragraph text and correctionId (null if correction is not queued).
 */
function flushParagraphBuffer(win: Electron.BrowserWindow | null): {
  rawText: string | null;
  correctionId: string | null;
} {
  if (paragraphBuffer.length === 0) return { rawText: null, correctionId: null };

  const rawText = paragraphBuffer.join(" ");
  paragraphBuffer = [];

  const liveSettings = getVoiceSettings();
  const willCorrect = !!(liveSettings.correctionEnabled && liveSettings.correctionApiKey);

  if (willCorrect && correctionService && win && !win.isDestroyed()) {
    const correctionId = crypto.randomUUID();
    void correctionService
      .correct(rawText, {
        model: liveSettings.correctionModel,
        apiKey: liveSettings.correctionApiKey,
        customDictionary: liveSettings.customDictionary,
        customInstructions: liveSettings.correctionCustomInstructions,
        projectName: sessionProjectInfo.name,
        projectPath: sessionProjectInfo.path,
      })
      .then((correctedText) => {
        if (!win.isDestroyed()) {
          win.webContents.send(CHANNELS.VOICE_INPUT_CORRECTION_REPLACE, {
            correctionId,
            correctedText,
          });
        }
      })
      .catch(() => {});
    return { rawText, correctionId };
  }

  return { rawText, correctionId: null };
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

    // Capture project info and reset paragraph buffer at session start
    sessionProjectInfo = getProjectInfo();
    paragraphBuffer = [];

    const unsubscribe = svc.onEvent((voiceEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;

      if (voiceEvent.type === "delta") {
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, voiceEvent.text);
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();

        // Accumulate utterance into paragraph buffer — correction fires at paragraph
        // boundaries (Enter or stop), not per utterance.
        if (rawText) {
          paragraphBuffer.push(rawText);
        }

        // Notify the renderer so it can finalize the utterance in the draft.
        // willCorrect is always false here: correction is batched at paragraph level.
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          text: rawText,
          willCorrect: false,
        });
      } else if (voiceEvent.type === "paragraph_boundary") {
        // Deepgram detected a paragraph break — auto-flush the previous paragraph
        // for correction (if enabled) and notify the renderer with the flushed text and ID.
        const { rawText: flushedText, correctionId } = flushParagraphBuffer(win);
        win.webContents.send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
          rawText: flushedText,
          correctionId,
        });
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
      activeDestroyListener = null;
      unsubscribe();
      service?.stop();
    };
    event.sender.once("destroyed", onDestroyed);
    activeDestroyListener = { sender: event.sender, fn: onDestroyed };

    const result = await svc.start(settings);
    if (!result.ok) {
      // Failed to start — clean up subscription immediately
      if (activeEventUnsubscribe === unsubscribe) {
        activeEventUnsubscribe = null;
      }
      unsubscribe();
      event.sender.removeListener("destroyed", onDestroyed);
      activeDestroyListener = null;
    }
    return result;
  };

  const handleStop = async (): Promise<{ rawText: string | null }> => {
    if (service) {
      // Drain first (waits for pending transcriptions), then clean up subscription.
      await service.stopGracefully();
    }
    cleanupActiveSubscription();

    // Flush any remaining paragraph utterances gathered since the last boundary.
    return flushParagraphBuffer(deps.mainWindow);
  };

  const handleFlushParagraph = (): { rawText: string | null } => {
    return flushParagraphBuffer(deps.mainWindow);
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
    return validateDeepgramKey(apiKey);
  };

  const handleValidateCorrectionApiKey = async (
    _event: Electron.IpcMainInvokeEvent,
    apiKey: string
  ) => {
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
  ipcMain.handle(CHANNELS.VOICE_INPUT_VALIDATE_CORRECTION_API_KEY, handleValidateCorrectionApiKey);
  ipcMain.handle(CHANNELS.VOICE_INPUT_FLUSH_PARAGRAPH, handleFlushParagraph);

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
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_VALIDATE_CORRECTION_API_KEY);
    ipcMain.removeHandler(CHANNELS.VOICE_INPUT_FLUSH_PARAGRAPH);
    cleanupActiveSubscription();
    service?.destroy();
    service = null;
    correctionService = null;
    paragraphBuffer = [];
  };
}
