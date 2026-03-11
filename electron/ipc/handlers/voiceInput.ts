import { ipcMain, systemPreferences, shell } from "electron";
import { spawn } from "child_process";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  VoiceTranscriptionService,
  type SegmentConfidence,
} from "../../services/VoiceTranscriptionService.js";
import { VoiceCorrectionService } from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies } from "../types.js";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { logDebug } from "../../utils/logger.js";

let service: VoiceTranscriptionService | null = null;
let activeEventUnsubscribe: (() => void) | null = null;
let activeDestroyListener: { sender: Electron.WebContents; fn: () => void } | null = null;
let correctionService: VoiceCorrectionService | null = null;
let correctionRequestTail: Promise<void> = Promise.resolve();

interface CorrectionEdit {
  start: number;
  end: number;
  fromText: string;
  toText: string;
}

interface QueuedCorrectionJob {
  correctionId: string;
  rawText: string;
  reason: "stop";
  minConfidence?: number;
  uncertainWords?: string[];
  wordCount?: number;
}

let sessionTranscript = "";
let sessionConfidenceSegments: SegmentConfidence[] = [];
let pendingParagraphBreak = false;
let sessionProjectInfo: { name?: string; path?: string } = {};

const VOICE_INPUT_DEFAULTS: VoiceInputSettings = {
  enabled: false,
  deepgramApiKey: "",
  correctionApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionModel: "nova-3",
  correctionEnabled: false,
  correctionModel: "gpt-5-mini",
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

function appendSessionText(text: string): void {
  const normalized = text.trim();
  if (!normalized) return;

  if (sessionTranscript) {
    if (pendingParagraphBreak) {
      sessionTranscript += "\n";
    } else if (!sessionTranscript.endsWith(" ") && !sessionTranscript.endsWith("\n")) {
      sessionTranscript += " ";
    }
  }

  sessionTranscript += normalized;
  pendingParagraphBreak = false;
}

function markParagraphBreak(): void {
  if (!sessionTranscript) return;
  pendingParagraphBreak = true;
}

function computeCompactCorrectionEdits(rawText: string, correctedText: string): CorrectionEdit[] {
  if (rawText === correctedText) return [];

  let prefix = 0;
  const maxPrefix = Math.min(rawText.length, correctedText.length);
  while (prefix < maxPrefix && rawText[prefix] === correctedText[prefix]) {
    prefix++;
  }

  let rawSuffix = rawText.length;
  let correctedSuffix = correctedText.length;
  while (
    rawSuffix > prefix &&
    correctedSuffix > prefix &&
    rawText[rawSuffix - 1] === correctedText[correctedSuffix - 1]
  ) {
    rawSuffix--;
    correctedSuffix--;
  }

  return [
    {
      start: prefix,
      end: rawSuffix,
      fromText: rawText.slice(prefix, rawSuffix),
      toText: correctedText.slice(prefix, correctedSuffix),
    },
  ];
}

function getSessionCorrectionText(): string {
  return sessionTranscript.replace(/[ \t]+$/g, "");
}

function mergeSessionConfidence(): {
  minConfidence: number;
  uncertainWords: string[];
  wordCount: number;
} {
  if (sessionConfidenceSegments.length === 0) {
    return { minConfidence: 0, uncertainWords: [], wordCount: 0 };
  }
  return {
    minConfidence: Math.min(...sessionConfidenceSegments.map((s) => s.minConfidence)),
    uncertainWords: sessionConfidenceSegments.flatMap((s) => s.uncertainWords),
    wordCount: sessionConfidenceSegments.reduce((sum, s) => sum + s.wordCount, 0),
  };
}

function buildCorrectionJob(): QueuedCorrectionJob | null {
  const rawText = getSessionCorrectionText();
  if (!rawText) return null;

  const { minConfidence, uncertainWords, wordCount } = mergeSessionConfidence();
  const job: QueuedCorrectionJob = {
    correctionId: crypto.randomUUID(),
    rawText,
    reason: "stop",
    minConfidence,
    uncertainWords,
    wordCount,
  };

  sessionTranscript = "";
  sessionConfidenceSegments = [];
  pendingParagraphBreak = false;
  return job;
}

function queueCorrectionRequest(job: QueuedCorrectionJob, win: Electron.BrowserWindow): void {
  if (!correctionService || win.isDestroyed()) {
    return;
  }

  logDebug("[VoiceCorrectionQueue] queued job", {
    correctionId: job.correctionId,
    reason: job.reason,
    rawLen: job.rawText.length,
  });

  correctionRequestTail = correctionRequestTail
    .catch(() => {})
    .then(async () => {
      if (!correctionService) return;
      const liveSettings = getVoiceSettings();
      const result = await correctionService!.correct(
        {
          rawText: job.rawText,
          reason: job.reason,
          uncertainWords: job.uncertainWords,
          minConfidence: job.minConfidence,
          wordCount: job.wordCount,
        },
        {
          model: liveSettings.correctionModel,
          apiKey: liveSettings.correctionApiKey,
          customDictionary: liveSettings.customDictionary,
          customInstructions: liveSettings.correctionCustomInstructions,
          projectName: sessionProjectInfo.name,
          projectPath: sessionProjectInfo.path,
        }
      );
      const edits = computeCompactCorrectionEdits(job.rawText, result.confirmedText);

      if (!win.isDestroyed()) {
        win.webContents.send(CHANNELS.VOICE_INPUT_CORRECTION_REPLACE, {
          correctionId: job.correctionId,
          correctedText: result.confirmedText,
          action: result.action,
          confidence: result.confidence,
          rawText: job.rawText,
          reason: job.reason,
          edits,
        });
      }
    });
}

/**
 * Join the stabilized correction buffer into a single raw text string and clear it.
 * If correction is enabled, generates a stable correctionId, fires an async
 * correction call, and optionally notifies the renderer that the correction is pending.
 * Returns the raw text chunk and correctionId (null if correction is not queued).
 */
function flushParagraphBuffer(win: Electron.BrowserWindow | null): {
  rawText: string | null;
  correctionId: string | null;
} {
  const job = buildCorrectionJob();
  if (!job) return { rawText: null, correctionId: null };

  const liveSettings = getVoiceSettings();
  const willCorrect = !!(liveSettings.correctionEnabled && liveSettings.correctionApiKey);

  if (willCorrect && correctionService && win && !win.isDestroyed()) {
    win.webContents.send(CHANNELS.VOICE_INPUT_CORRECTION_QUEUED, {
      correctionId: job.correctionId,
      rawText: job.rawText,
      reason: job.reason,
    });
    queueCorrectionRequest(job, win);
    return { rawText: job.rawText, correctionId: job.correctionId };
  }

  return { rawText: job.rawText, correctionId: null };
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

    // Initialize the correction service for this session
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }
    correctionRequestTail = Promise.resolve();

    // Capture project info and reset the session transcript at session start.
    sessionProjectInfo = getProjectInfo();
    sessionTranscript = "";
    sessionConfidenceSegments = [];
    pendingParagraphBreak = false;

    const unsubscribe = svc.onEvent((voiceEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;

      if (voiceEvent.type === "delta") {
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, voiceEvent.text);
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();

        if (rawText) {
          appendSessionText(rawText);
        }
        if (voiceEvent.confidence) {
          sessionConfidenceSegments.push(voiceEvent.confidence);
        }

        // Notify the renderer so it can finalize the utterance in the draft.
        // willCorrect is always false here: correction is batched at paragraph level.
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          text: rawText,
          willCorrect: false,
        });
      } else if (voiceEvent.type === "paragraph_boundary") {
        // Deepgram detected a paragraph break. Keep the structure in the session
        // transcript, but defer the single correction request until stop.
        markParagraphBreak();
        win.webContents.send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
          rawText: null,
          correctionId: null,
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

  const handleStop = async (): Promise<{ rawText: string | null; correctionId: string | null }> => {
    if (service) {
      // Drain first (waits for pending transcriptions), then clean up subscription.
      await service.stopGracefully();
    }
    cleanupActiveSubscription();

    return flushParagraphBuffer(deps.mainWindow);
  };

  const handleFlushParagraph = (): { rawText: string | null; correctionId: string | null } => {
    // Capture in-flight utterance text before inserting a paragraph break in the draft,
    // but defer AI correction until the session stops.
    if (service) {
      const { text: inFlightText, confidence } = service.commitParagraphBoundary();
      if (inFlightText) {
        appendSessionText(inFlightText);
      }
      sessionConfidenceSegments.push(confidence);
    }
    markParagraphBreak();
    return { rawText: null, correctionId: null };
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
    sessionTranscript = "";
    sessionConfidenceSegments = [];
    pendingParagraphBreak = false;
  };
}
