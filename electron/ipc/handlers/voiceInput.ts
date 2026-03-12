import { ipcMain, systemPreferences, shell } from "electron";
import { spawn } from "child_process";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  VoiceTranscriptionService,
  type CorrectionWord,
} from "../../services/VoiceTranscriptionService.js";
import { VoiceCorrectionService } from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies } from "../types.js";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { CONFIDENCE_TAG_THRESHOLD } from "../../../shared/config/voiceCorrection.js";
import { logDebug, logWarn } from "../../utils/logger.js";
import { assembleKeyterms } from "../../services/voiceContextKeyterms.js";

let service: VoiceTranscriptionService | null = null;
let activeEventUnsubscribe: (() => void) | null = null;
let activeDestroyListener: { sender: Electron.WebContents; fn: () => void } | null = null;
let correctionService: VoiceCorrectionService | null = null;

interface CorrectionEdit {
  start: number;
  end: number;
  fromText: string;
  toText: string;
}

// ── Streaming correction infrastructure ─────────────────────────────────────

const RIGHT_CONTEXT_WORDS = 3;
const POOL_CONCURRENCY_LIMIT = 5;
const POOL_DRAIN_TIMEOUT_MS = 3000;
const BUFFER_PRUNE_THRESHOLD = 100;

interface CorrectionCluster {
  clusterStartIndex: number;
  words: CorrectionWord[];
  leftContext: CorrectionWord[];
  rightContext: CorrectionWord[];
}

export class TranscriptionBuffer {
  private buffer: CorrectionWord[] = [];
  private cursor = 0;

  append(words: CorrectionWord[]): CorrectionCluster[] {
    this.buffer.push(...words);
    return this.scan(false);
  }

  flush(): CorrectionCluster[] {
    return this.scan(true);
  }

  reset(): void {
    this.buffer = [];
    this.cursor = 0;
  }

  private scan(isClosing: boolean): CorrectionCluster[] {
    const clusters: CorrectionCluster[] = [];
    let i = this.cursor;
    let hasPendingCluster = false;

    while (i < this.buffer.length) {
      if (this.buffer[i].confidence >= CONFIDENCE_TAG_THRESHOLD) {
        i++;
        continue;
      }

      // Found start of a low-confidence cluster
      const clusterStart = i;
      while (i < this.buffer.length && this.buffer[i].confidence < CONFIDENCE_TAG_THRESHOLD) {
        i++;
      }
      const clusterEnd = i;

      // Count right-context words available after the cluster
      const rightContextEnd = Math.min(this.buffer.length, clusterEnd + RIGHT_CONTEXT_WORDS);
      const rightContextAvailable = rightContextEnd - clusterEnd;

      if (rightContextAvailable >= RIGHT_CONTEXT_WORDS || isClosing) {
        const leftStart = Math.max(0, clusterStart - RIGHT_CONTEXT_WORDS);
        clusters.push({
          clusterStartIndex: clusterStart,
          words: this.buffer.slice(clusterStart, clusterEnd),
          leftContext: this.buffer.slice(leftStart, clusterStart),
          rightContext: this.buffer.slice(clusterEnd, rightContextEnd),
        });
        this.cursor = rightContextEnd;
      } else {
        // Not enough right-context yet — wait for more segments
        this.cursor = clusterStart;
        hasPendingCluster = true;
        break;
      }
    }

    // Only advance cursor for left-context retention when there is no pending
    // cluster waiting for right-context — otherwise we'd skip past its start.
    if (
      !hasPendingCluster &&
      clusters.length === 0 &&
      !isClosing &&
      this.cursor < this.buffer.length
    ) {
      this.cursor = Math.max(this.cursor, this.buffer.length - RIGHT_CONTEXT_WORDS);
    }

    this.prune();
    return clusters;
  }

  private prune(): void {
    if (this.cursor <= BUFFER_PRUNE_THRESHOLD) return;
    const keepFrom = Math.max(0, this.cursor - RIGHT_CONTEXT_WORDS);
    this.buffer = this.buffer.slice(keepFrom);
    this.cursor -= keepFrom;
  }
}

export class PromisePool {
  private active = 0;
  private queue: Array<() => void> = [];
  private drainResolvers: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  add(task: () => Promise<void>): void {
    if (this.active < this.limit) {
      this.active++;
      void this.run(task);
    } else {
      this.queue.push(() => {
        this.active++;
        void this.run(task);
      });
    }
  }

  async drain(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private async run(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch {
      // Errors are handled inside the task
    } finally {
      this.active--;
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next();
      } else if (this.active === 0) {
        const resolvers = this.drainResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
    }
  }
}

// ── Session state ───────────────────────────────────────────────────────────

let sessionBuffer: TranscriptionBuffer | null = null;
let correctionPool: PromisePool | null = null;
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

function wordsToText(words: CorrectionWord[]): string {
  return words.map((w) => w.word).join(" ");
}

function fireMicroCorrection(
  cluster: CorrectionCluster,
  win: Electron.BrowserWindow,
  svc: VoiceCorrectionService
): void {
  if (!correctionPool) return;

  const rawSpan = wordsToText(cluster.words);
  const correctionId = crypto.randomUUID();
  const uncertainWords = cluster.words
    .filter((w) => w.confidence < CONFIDENCE_TAG_THRESHOLD)
    .map((w) => w.word);

  logDebug("[VoiceStreamCorrection] firing micro-correction", {
    correctionId,
    rawSpan,
    uncertainWords,
  });

  // Notify renderer that a correction is pending
  if (!win.isDestroyed()) {
    win.webContents.send(CHANNELS.VOICE_INPUT_CORRECTION_QUEUED, {
      correctionId,
      rawText: rawSpan,
      reason: "streaming",
    });
  }

  // Snapshot project info at queue time so a new session can't overwrite it.
  const projectInfo = { ...sessionProjectInfo };

  correctionPool.add(async () => {
    if (!correctionService) return;
    const liveSettings = getVoiceSettings();

    const result = await svc.correctWord(
      {
        uncertainWords,
        leftContext: wordsToText(cluster.leftContext),
        rightContext: wordsToText(cluster.rightContext),
        rawSpan,
      },
      {
        model: liveSettings.correctionModel,
        apiKey: liveSettings.correctionApiKey,
        customDictionary: liveSettings.customDictionary,
        customInstructions: liveSettings.correctionCustomInstructions,
        projectName: projectInfo.name,
        projectPath: projectInfo.path,
      }
    );

    const edits = computeCompactCorrectionEdits(rawSpan, result.confirmedText);

    if (!win.isDestroyed()) {
      win.webContents.send(CHANNELS.VOICE_INPUT_CORRECTION_REPLACE, {
        correctionId,
        correctedText: result.confirmedText,
        action: result.action,
        confidence: result.confidence,
        rawText: rawSpan,
        reason: "streaming",
        edits,
      });
    }
  });
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

    // Reset streaming correction state
    sessionBuffer = new TranscriptionBuffer();
    correctionPool = new PromisePool(POOL_CONCURRENCY_LIMIT);

    // Capture project info at session start.
    sessionProjectInfo = getProjectInfo();

    // Assemble dynamic keyterms from project context (branch, terminal output, etc.)
    let sessionSettings = settings;
    try {
      const assembledKeyterms = await assembleKeyterms({
        customDictionary: settings.customDictionary,
        projectName: sessionProjectInfo.name,
        projectPath: sessionProjectInfo.path,
        ptyClient: deps.ptyClient,
      });
      sessionSettings = { ...settings, customDictionary: assembledKeyterms };
    } catch (err) {
      logWarn("[VoiceInput] Failed to assemble dynamic keyterms, using static dictionary", {
        error: (err as Error).message,
      });
    }

    const unsubscribe = svc.onEvent((voiceEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;

      if (voiceEvent.type === "delta") {
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, voiceEvent.text);
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();

        // Notify the renderer so it can finalize the utterance in the draft.
        win.webContents.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          text: rawText,
          willCorrect: false,
        });

        // Feed word-level data into the streaming correction buffer
        const liveSettings = getVoiceSettings();
        const correctionEnabled = !!(
          liveSettings.correctionEnabled && liveSettings.correctionApiKey
        );
        if (
          correctionEnabled &&
          correctionService &&
          sessionBuffer &&
          voiceEvent.confidence?.words?.length
        ) {
          const clusters = sessionBuffer.append(voiceEvent.confidence.words);
          for (const cluster of clusters) {
            fireMicroCorrection(cluster, win, correctionService);
          }
        }
      } else if (voiceEvent.type === "paragraph_boundary") {
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

    const result = await svc.start(sessionSettings);
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
      // Drain Deepgram first (waits for pending transcriptions, fires remaining complete events).
      await service.stopGracefully();
    }

    // Flush any remaining clusters that lacked right-context
    const win = deps.mainWindow;
    if (sessionBuffer && correctionService && win && !win.isDestroyed()) {
      const remaining = sessionBuffer.flush();
      for (const cluster of remaining) {
        fireMicroCorrection(cluster, win, correctionService);
      }
    }

    // Wait for all in-flight micro-corrections to complete (with timeout)
    if (correctionPool) {
      await Promise.race([
        correctionPool.drain(),
        new Promise<void>((resolve) => setTimeout(resolve, POOL_DRAIN_TIMEOUT_MS)),
      ]);
    }

    cleanupActiveSubscription();

    // No batch correction — streaming corrections have already been fired
    return { rawText: null, correctionId: null };
  };

  const handleFlushParagraph = (): { rawText: string | null; correctionId: string | null } => {
    // Capture in-flight utterance text before inserting a paragraph break in the draft.
    // The buffer continues to accumulate words for streaming corrections across paragraphs.
    if (service) {
      service.commitParagraphBoundary();
    }
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
    sessionBuffer = null;
    correctionPool = null;
  };
}
