// eager-import-allow: reads voice-input settings via store.get synchronously in the IPC handler
import { ipcMain, systemPreferences } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import type {
  VoiceSessionEvent,
  VoiceTranscriptionService,
} from "../../services/VoiceTranscriptionService.js";
import { VoiceCorrectionService } from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  VoiceInputSettings,
  VoiceTranscriptionProvider,
} from "../../../shared/types/ipc/api.js";
import type { VoiceSessionEndReason, VoiceStartOutcome } from "../../../shared/types/voice.js";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { buildOpenAIHeaders } from "../../../shared/utils/openaiHeaders.js";
import { voiceErrorLogFields } from "../../../shared/utils/voiceLogFields.js";
import { applyDictationCommands } from "../../services/voiceDictationCommands.js";
import { VOICE_DICTATION_AI_MODEL } from "../../../shared/config/voiceCorrection.js";
import { normalizeVoiceLanguage } from "../../../shared/config/voiceLanguages.js";
import { assembleKeyterms } from "../../services/voiceContextKeyterms.js";
import {
  AUDIO_BUFFER_MAX_BYTES,
  AUDIO_BUFFER_MAX_CHUNKS,
  AUDIO_BUFFER_OVERFLOW_CODE,
  createAudioBufferOverflowError,
} from "../../services/voice/TranscriptionProvider.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import { voiceFileLinkResolver } from "../../services/VoiceFileLinkResolver.js";
import { typedHandle, typedHandleValidated } from "../utils.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { AppError } from "../../utils/errorTypes.js";
import { VOICE_INPUT_METHOD_CHANNELS } from "./voiceInput.preload.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { openLinuxSoundSettings } from "../../services/voice/linuxSoundSettings.js";
import {
  VoiceInputCorrectPayloadSchema,
  VoiceSessionIdSchema,
  type VoiceInputCorrectPayload,
} from "../../schemas/ipc.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";

let service: VoiceTranscriptionService | null = null;
let servicePromise: Promise<VoiceTranscriptionService> | null = null;
let correctionService: VoiceCorrectionService | null = null;
// The controller whose signal correctionService currently carries.
let sessionController: AbortController | null = null;

/**
 * One dictation session, named by the id its renderer minted. Everything a
 * session sets up hangs off its record, so ending one tears down only its own
 * subscription, watcher and buffer, never a newer session's.
 */
interface VoiceSession {
  readonly id: string;
  /** The view that started it. */
  readonly sender: Electron.WebContents;
  readonly webContentsId: number;
  readonly projectId: string | null;
  // The global current project at start. Keyterms and file links read this
  // until they move to the owning view's project (#14599).
  readonly projectInfo: { name?: string; path?: string };
  // starting: main is still preparing, and the provider isn't this session's.
  // active: its provider has been started (it may still be connecting).
  // stopping: a stop owns its graceful drain.
  phase: "starting" | "active" | "stopping";
  ended: boolean;
  stopPromise: Promise<{ rawText: string | null }> | null;
  readonly controller: AbortController;
  unsubscribe: (() => void) | null;
  unwatchDestroyed: (() => void) | null;
  // The renderer streams audio as soon as capture is attached, before main has
  // loaded the service, assembled keyterms, and created a provider. Chunks for
  // a session still starting are held here and handed to its provider exactly
  // once; without this they'd go to no provider, or to the previous session's.
  preStartAudio: { chunks: ArrayBuffer[]; bytes: number; overflowed: boolean } | null;
  // Overflow can be hit both here and in the provider's own connect buffer —
  // one report per session is enough.
  overflowReported: boolean;
}

let liveSession: VoiceSession | null = null;

function isLive(session: VoiceSession): boolean {
  return liveSession === session && !session.ended;
}

/** The live session's id and the view and project that own it, or null. */
export function getLiveVoiceSession(): {
  sessionId: string;
  webContentsId: number;
  projectId: string | null;
} | null {
  if (!liveSession) return null;
  return {
    sessionId: liveSession.id,
    webContentsId: liveSession.webContentsId,
    projectId: liveSession.projectId,
  };
}

/**
 * End a session exactly once: drop it as the live one, release what it set up,
 * and tell its owning view why. Retiring its provider is left to the caller:
 * after a drain there is nothing to stop, and by then the provider may belong
 * to a newer session.
 */
function endSession(session: VoiceSession, reason: VoiceSessionEndReason): void {
  if (session.ended) return;
  session.ended = true;
  if (liveSession === session) liveSession = null;
  session.preStartAudio = null;
  session.unsubscribe?.();
  session.unsubscribe = null;
  session.unwatchDestroyed?.();
  session.unwatchDestroyed = null;
  // Abort any in-flight file-link detection / resolution.
  session.controller.abort();
  if (sessionController === session.controller) {
    correctionService?.setSessionSignal(null);
    sessionController = null;
  }
  logInfo("[VoiceInput] Session ended", {
    sessionId: session.id,
    reason,
    phase: session.phase,
  });
  if (!session.sender.isDestroyed()) {
    session.sender.send(CHANNELS.VOICE_INPUT_SESSION_ENDED, { sessionId: session.id, reason });
  }
}

const SUPERSEDED: VoiceStartOutcome = { status: "superseded" };

const VALID_TRANSCRIPTION_PROVIDERS: VoiceTranscriptionProvider[] = ["openai", "deepgram"];

// Fields on VoiceInputSettings that are assembled at runtime and must never be
// written to the persisted store.
const RUNTIME_ONLY_VOICE_FIELDS = new Set<string>(["keyterms"]);

const VOICE_INPUT_DEFAULTS: VoiceInputSettings = {
  enabled: false,
  openaiApiKey: "",
  deepgramApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: VOICE_DICTATION_AI_MODEL,
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [],
  learnFromCorrections: true,
};

/** Read voiceInput settings with defaults for fields added after initial store creation. */
export function getVoiceSettings(): VoiceInputSettings {
  const stored = store.get("voiceInput") as
    | (Partial<VoiceInputSettings> & {
        apiKey?: string;
        correctionApiKey?: string;
      })
    | undefined;

  // Pluck truly-legacy key fields so they don't leak into the merged object via
  // spread. `deepgramApiKey` is now a first-class field, so it flows through
  // `rest` instead of being dropped. `keyterms` is runtime-only — drop any value
  // a stale store/migration left behind so it never seeds a session.
  const { apiKey, correctionApiKey, keyterms, ...rest } = stored ?? {};
  void keyterms;
  const merged: VoiceInputSettings = { ...VOICE_INPUT_DEFAULTS, ...rest };

  // Migrate prior OpenAI keys into the unified field.
  if (!merged.openaiApiKey) {
    if (correctionApiKey?.startsWith("sk-")) {
      merged.openaiApiKey = correctionApiKey;
    } else if (apiKey?.startsWith("sk-")) {
      merged.openaiApiKey = apiKey;
    }
  }

  // Default the provider to "openai" only when it's missing or unrecognized
  // (e.g. settings written before the provider field existed). Crucially this
  // does NOT reset a valid, user-chosen provider on every read — the prior
  // migration's habit of force-resetting fields each launch is the #9175 bug.
  const providerNeedsDefault = !VALID_TRANSCRIPTION_PROVIDERS.includes(
    merged.transcriptionProvider
  );
  if (providerNeedsDefault) merged.transcriptionProvider = "openai";

  // Normalize a stale/invalid transcription model to the only supported value.
  // The model union is single-valued, so this is a one-shot cleanup of the
  // retired 'gpt-realtime-whisper' and legacy Deepgram model strings ('nova-3' /
  // 'nova-2'), not a user-choice revert — the provider, not the model, is what
  // selects the backend, and `transcriptionProvider` above is left untouched.
  // migration027 moves stores below schema 27 forward; this read-time net
  // catches stores already on the current version (never revisited by the
  // migration), plus post-downgrade or hand-edited values. If a model picker is
  // ever added, widening the union must also replace this single-target
  // normalizer with valid-choice preservation.
  const staleTranscriptionModel = merged.transcriptionModel !== "gpt-live-transcribe";
  if (staleTranscriptionModel) merged.transcriptionModel = "gpt-live-transcribe";

  // Same one-shot cleanup for the correction model: gpt-5.6-luna replaced the
  // retired gpt-5-mini/gpt-5-nano tiers, so this union is single-valued too.
  // migration025 upgrades stores on older schema versions; this read-time net
  // catches stores already on the current version (never revisited by the
  // migration), plus post-downgrade or hand-edited values. Not a user-choice
  // revert — there is no correction-model choice left to preserve.
  const staleCorrectionModel = merged.correctionModel !== VOICE_DICTATION_AI_MODEL;
  if (staleCorrectionModel) merged.correctionModel = VOICE_DICTATION_AI_MODEL;

  // Normalize malformed recordingMode values in memory only (no write-back).
  if (merged.recordingMode !== "toggle" && merged.recordingMode !== "push-to-talk") {
    merged.recordingMode = "toggle";
  }

  // Persist the cleaned object on first read after upgrade so the legacy key
  // fields disappear from disk and any defaulted/normalized values are written
  // through. `store.set` with a full object replaces.
  if (
    apiKey !== undefined ||
    correctionApiKey !== undefined ||
    providerNeedsDefault ||
    staleTranscriptionModel ||
    staleCorrectionModel
  ) {
    store.set("voiceInput", merged);
  }

  // Env-var overrides take absolute precedence over stored keys.
  const envOpenAiKey = process.env.WHISPER_API_KEY?.trim();
  if (envOpenAiKey) {
    merged.openaiApiKey = envOpenAiKey;
  }
  const envDeepgramKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (envDeepgramKey) {
    merged.deepgramApiKey = envDeepgramKey;
  }

  return merged;
}

async function getService(): Promise<VoiceTranscriptionService> {
  if (service) return service;
  if (!servicePromise) {
    servicePromise = import("../../services/VoiceTranscriptionService.js").then((mod) => {
      service = new mod.VoiceTranscriptionService();
      return service;
    });
    servicePromise.catch(() => {
      servicePromise = null;
    });
  }
  return servicePromise;
}

export type MicPermissionStatus =
  "granted" | "denied" | "not-determined" | "restricted" | "unknown";

function checkMicPermission(): MicPermissionStatus {
  if (process.platform === "darwin" || process.platform === "win32") {
    return systemPreferences.getMediaAccessStatus("microphone") as MicPermissionStatus;
  }
  // Linux doesn't have a system-level media access API
  return "unknown";
}

/**
 * Native permission preflight. The boolean means "the renderer may proceed to
 * getUserMedia" — NOT "the OS confirmed access".
 *
 * macOS is the only platform with a main-process request API
 * (askForMediaAccess), so it is the only one that can answer authoritatively;
 * a `false` there is a real denial. Windows and Linux have no such API —
 * getUserMedia is the actual gate — so they must return `true` to let the
 * renderer reach it. Returning `false` here dead-ends voice input on Windows.
 */
async function requestMicPermission(): Promise<boolean> {
  if (process.platform === "darwin") {
    return systemPreferences.askForMediaAccess("microphone");
  }
  return true;
}

/** Resolves whether a settings app opened, so the UI can say when nothing did. */
async function openMicSettings(): Promise<boolean> {
  const logOpenFailure = (err: unknown, command?: string) =>
    logDebug("[VoiceInput] Failed to open mic settings", {
      ...voiceErrorLogFields(err),
      command,
    });

  if (process.platform === "darwin" || process.platform === "win32") {
    const url =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        : "ms-settings:privacy-microphone";
    try {
      await openExternalUrl(url);
      return true;
    } catch (err) {
      logOpenFailure(err);
      return false;
    }
  }

  // Linux has no settings URL; the sound panel is a different app per desktop.
  const opened = await openLinuxSoundSettings(process.env.XDG_CURRENT_DESKTOP, (launcher, err) =>
    logOpenFailure(err, launcher.command)
  );
  if (!opened) {
    logWarn("[VoiceInput] No sound settings app could be opened", {
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
    });
  }
  return opened;
}

async function parseOpenAIErrorBody(
  response: Response
): Promise<{ message?: string; code?: string } | undefined> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return undefined;
  }
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; code?: unknown };
    };
    const err = body?.error;
    if (err && typeof err === "object") {
      return {
        message: typeof err.message === "string" ? err.message : undefined,
        code: typeof err.code === "string" ? err.code : undefined,
      };
    }
  } catch {
    // Non-JSON body or parse failure.
  }
  return undefined;
}

export async function validateOpenAIKey(
  apiKey: string,
  organizationId?: string,
  projectId?: string
): Promise<{ valid: boolean; error?: string }> {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return { valid: false, error: "API key is required" };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: buildOpenAIHeaders(apiKey, organizationId, projectId),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return { valid: true };
    }

    const body = await parseOpenAIErrorBody(response);

    if (response.status === 401) {
      return { valid: false, error: body?.message || "Invalid API key" };
    }

    if (response.status === 429) {
      if (body?.code === "insufficient_quota") {
        return {
          valid: false,
          error:
            "API key is valid but the OpenAI account has no credits. Add a payment method to continue.",
        };
      }
      // rate_limit_exceeded and unknown 429 codes are transient — key is valid.
      return { valid: true };
    }

    if (response.status === 403) {
      if (body?.code === "unsupported_country_region_territory") {
        return {
          valid: false,
          error: body.message || "OpenAI is not available in your current region.",
        };
      }
      return { valid: false, error: body?.message || "Access denied" };
    }

    return { valid: false, error: body?.message || `API returned status ${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
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

export function registerVoiceInputHandlers(deps: HandlerDependencies): () => void {
  const handleGetSettings = async () => {
    return getVoiceSettings();
  };

  const handleSetSettings = async (patch: Partial<VoiceInputSettings>) => {
    if (!patch || typeof patch !== "object") return;
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      // `keyterms` is runtime-only — assembled per session, never persisted. Skip
      // it so a renderer patch can't seed stored keyterms into future sessions.
      if (RUNTIME_ONLY_VOICE_FIELDS.has(field)) continue;
      store.set(`voiceInput.${field}`, value);
    }
  };

  const reportAudioOverflow = (session: VoiceSession) => {
    if (session.overflowReported) return;
    session.overflowReported = true;
    const win = deps.mainWindow;
    if (!win || win.isDestroyed()) return;
    getAppWebContents(win).send(CHANNELS.VOICE_INPUT_ERROR, {
      sessionId: session.id,
      error: createAudioBufferOverflowError(),
    });
  };

  const flushPreStartAudio = (session: VoiceSession, svc: VoiceTranscriptionService) => {
    const pending = session.preStartAudio;
    if (!pending) return;
    session.preStartAudio = null;
    if (pending.chunks.length > 0) {
      logDebug("[VoiceInput] Flushing pre-start audio", {
        chunks: pending.chunks.length,
        bytes: pending.bytes,
      });
    }
    for (const chunk of pending.chunks) {
      svc.sendAudioChunk(chunk);
    }
  };

  // A failed or superseded start is an outcome, not an exception: the
  // provider's message goes back to the renderer and never through the IPC
  // error logger, where it could quote dictated text (#14620).
  const handleStart = async (ctx: IpcContext, sessionId: string): Promise<VoiceStartOutcome> => {
    // Events and the ended notice go back to the view that started it.
    const sender = ctx.event?.sender;
    if (!sender || sender.isDestroyed()) return SUPERSEDED;
    // Two sessions under one id would make every chunk and stop ambiguous.
    if (liveSession?.id === sessionId) {
      throw new AppError({ code: "VALIDATION", message: "Voice session already started" });
    }
    // Published before the first await, so a stop or a newer start landing
    // during the service import or keyterm assembly sees this session, and its
    // audio buffer is armed before any chunk of this capture can arrive.
    const session: VoiceSession = {
      id: sessionId,
      sender,
      webContentsId: ctx.webContentsId,
      projectId: ctx.projectId,
      projectInfo: getProjectInfo(),
      phase: "starting",
      ended: false,
      stopPromise: null,
      controller: new AbortController(),
      unsubscribe: null,
      unwatchDestroyed: null,
      preStartAudio: { chunks: [], bytes: 0, overflowed: false },
      overflowReported: false,
    };
    const previous = liveSession;
    liveSession = session;
    if (previous) {
      const previousOwnsProvider = previous.phase !== "starting";
      endSession(previous, "superseded");
      // Nothing listens to it any more, and its audio is now refused.
      if (previousOwnsProvider) service?.stop();
    }
    // A view that goes away takes its session with it. Only a session that is
    // still live owns the provider it would stop.
    session.unwatchDestroyed = onWebContentsDestroyed(sender, () => {
      if (session.ended) return;
      const ownsProvider = session.phase !== "starting";
      endSession(session, "cancelled");
      if (ownsProvider) service?.stop();
    });
    // Main-process clock only; correlate with renderer start steps by session id.
    const startedAt = performance.now();
    // Whatever already ended it (a stop, a newer start, its view going away)
    // chose the reason; a stop in progress owns the ending.
    let outcome: VoiceStartOutcome;
    try {
      outcome = await startSession(session, startedAt);
    } catch (error) {
      if (session.phase !== "stopping") endSession(session, "failed");
      throw error;
    }
    if (outcome.status === "failed" && session.phase !== "stopping") {
      endSession(session, "failed");
    }
    return outcome;
  };

  const startSession = async (
    session: VoiceSession,
    startedAt: number
  ): Promise<VoiceStartOutcome> => {
    const svc = await getService();
    const serviceReadyAt = performance.now();
    // The renderer went away during the import — nothing is left to record for.
    if (session.sender.isDestroyed()) endSession(session, "cancelled");
    if (!isLive(session)) return SUPERSEDED;
    // Snapshot transcription settings at session start (model, language, API key).
    // Correction settings are read live from store per-event so mid-session changes apply.
    const settings = getVoiceSettings();

    // Initialize the correction service for this session
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }

    sessionController = session.controller;
    correctionService.setSessionSignal(session.controller.signal);

    // Kick off keyterm assembly concurrently with the subscription/provider
    // setup below so leading speech isn't delayed waiting on git/terminal reads.
    // Both providers consume the result: Deepgram via repeated `keyterm=` params,
    // OpenAI via the transcription prompt. The frozen list is awaited just before
    // svc.start() and travels inside the settings snapshot, so both providers'
    // reconnect paths reuse it unchanged. Assembly is capped internally (~500ms)
    // and failures are non-fatal — we just start without keyterms.
    const keytermsPromise = assembleKeyterms({
      customDictionary: settings.customDictionary,
      projectName: session.projectInfo.name,
      projectPath: session.projectInfo.path,
      ptyClient: deps.ptyClient,
    });

    const forwardEvent = (voiceEvent: VoiceSessionEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;
      const sessionId = session.id;

      if (voiceEvent.type === "delta") {
        logDebug("[VoiceInput] → renderer delta", { length: voiceEvent.text.length });
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, {
          sessionId,
          text: voiceEvent.text,
          ...(voiceEvent.itemId ? { itemId: voiceEvent.itemId } : {}),
        });
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();
        const liveSettings = getVoiceSettings();

        // OpenAI Realtime emits spoken dictation commands ("new paragraph",
        // "new line", etc.) as literal text. applyDictationCommands rewrites
        // them post-hoc to \n\n / \n, gated on the session-
        // snapshotted paragraphing strategy.
        const processedText =
          settings.paragraphingStrategy === "spoken-command" &&
          normalizeVoiceLanguage(settings.language) === "en"
            ? applyDictationCommands(rawText)
            : rawText;

        // Split on line breaks and emit one complete event per non-empty part
        // with a paragraph_boundary between each pair of pieces. Empty pieces
        // still get their boundary, so a break at the start or end of an
        // utterance ("fix the bug new line") survives for the next utterance.
        const pieces = processedText.split(/\s*\n\s*/).map((p) => p.trim());
        const parts = pieces.filter(Boolean);
        // Lengths only — dictated text is user content, kept out of logs.
        logDebug("[VoiceInput] complete event → renderer", {
          rawLength: rawText.length,
          processedLength: processedText.length,
          paragraphingStrategy: settings.paragraphingStrategy,
          partCount: parts.length,
        });
        // Every part of one item carries its id so the renderer retires that
        // item's preview. An identified item that yields no text still sends one
        // empty completion — otherwise its interim deltas would linger as ghost
        // text and be flushed into the draft on stop.
        const itemIdField = voiceEvent.itemId ? { itemId: voiceEvent.itemId } : {};
        if (parts.length === 0 && voiceEvent.itemId) {
          getAppWebContents(win).send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
            sessionId,
            text: "",
            willCorrect: false,
            ...itemIdField,
          });
        }
        for (let i = 0; i < pieces.length; i++) {
          if (pieces[i]) {
            getAppWebContents(win).send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
              sessionId,
              text: pieces[i],
              willCorrect: false,
              ...itemIdField,
            });
          }
          if (i < pieces.length - 1) {
            getAppWebContents(win).send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
              sessionId,
              rawText: null,
              correctionId: null,
            });
          }
        }

        // File link detection: scan the complete utterance for file-reference voice commands.
        if (
          liveSettings.correctionEnabled &&
          liveSettings.resolveFileLinks &&
          correctionService &&
          rawText.length > 0
        ) {
          const projectPath = session.projectInfo.path;
          const apiKey = liveSettings.openaiApiKey;
          if (projectPath && apiKey) {
            // Capture the service synchronously so a replacement instance can't
            // be used here. The signal aborts when this session ends.
            const signal = session.controller.signal;
            const correctionSvc = correctionService;
            void (async () => {
              const tokens = await correctionSvc.detectFileLinkTokens(rawText, {
                apiKey,
                organizationId: liveSettings.organizationId,
                projectId: liveSettings.projectId,
              });
              for (const { description } of tokens) {
                const resolved = await voiceFileLinkResolver.resolve({
                  cwd: projectPath,
                  description,
                  apiKey,
                  organizationId: liveSettings.organizationId,
                  projectId: liveSettings.projectId,
                  signal,
                });
                // Guard the IPC send: voiceFileLinkResolver may return on a
                // local-only match without ever consulting `signal`, so a session
                // stopped mid-resolution could otherwise leak FILE_TOKEN_RESOLVED
                // events into a new session's panel.
                if (signal.aborted) return;
                const replacement = resolved ? `@${resolved}` : `@?${description}`;
                if (!win.isDestroyed()) {
                  getAppWebContents(win).send(CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED, {
                    sessionId,
                    description,
                    replacement,
                    resolved: !!resolved,
                  });
                }
              }
            })();
          }
        }
      } else if (voiceEvent.type === "paragraph_boundary") {
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
          sessionId,
          rawText: null,
        });
      } else if (voiceEvent.type === "error") {
        if (voiceEvent.error.code === AUDIO_BUFFER_OVERFLOW_CODE) {
          if (session.overflowReported) return;
          session.overflowReported = true;
        }
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_ERROR, {
          sessionId,
          error: voiceEvent.error,
        });
      } else if (voiceEvent.type === "status") {
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_STATUS, {
          sessionId,
          status: voiceEvent.status,
        });
      }
    };

    session.unsubscribe = svc.onEvent((voiceEvent) => {
      // A retired provider's events, and anything after this session ended.
      if (voiceEvent.sessionId !== session.id || session.ended) return;
      forwardEvent(voiceEvent);
      // A provider that dies on its own ends the session, even while still
      // connecting. During a stop, its finishing → idle is the drain that
      // handleStop is waiting on.
      if (
        session.phase === "active" &&
        voiceEvent.type === "status" &&
        (voiceEvent.status === "error" || voiceEvent.status === "idle")
      ) {
        endSession(session, "failed");
      }
    });

    // Freeze the assembled keyterms into the session settings snapshot. Assembly
    // has its own internal timeouts, so this await is bounded and never blocks the
    // session start indefinitely.
    let keyterms: string[] = [];
    const termsWaitStartedAt = performance.now();
    try {
      keyterms = await keytermsPromise;
    } catch (err) {
      logDebug("[VoiceInput] Keyterm assembly failed, starting without keyterms", {
        ...voiceErrorLogFields(err),
      });
    }
    const keytermsReadyAt = performance.now();
    // A stop, a newer start or the owner going away ended this session while
    // assembly ran (on either path). Whatever ended it already released its
    // subscription and watcher, so there is nothing of ours left to undo.
    if (!isLive(session)) return SUPERSEDED;
    // Field names avoid "key": the logger blanks any field containing it.
    logInfo("[VoiceInput] Start timing — provider start", {
      sessionId: session.id,
      serviceLoadMs: Math.round(serviceReadyAt - startedAt),
      biasTermsWaitMs: Math.round(keytermsReadyAt - termsWaitStartedAt),
      elapsedMs: Math.round(keytermsReadyAt - startedAt),
      heldChunks: session.preStartAudio?.chunks.length ?? 0,
    });
    // Not awaited before the flush: start() installs the provider and enters its
    // pending-start state synchronously, so the held audio lands in the
    // provider's own connect buffer, ahead of any chunk that arrives next.
    session.phase = "active";
    const startPromise = svc.start({ ...settings, keyterms }, session.id);
    flushPreStartAudio(session, svc);
    const result = await startPromise;
    const providerSettledAt = performance.now();
    logInfo("[VoiceInput] Start timing — provider settled", {
      sessionId: session.id,
      ok: result.ok,
      providerStartMs: Math.round(providerSettledAt - keytermsReadyAt),
      elapsedMs: Math.round(providerSettledAt - startedAt),
    });
    if (!result.ok) return { status: "failed", error: result.error };
    return isLive(session) ? { status: "started" } : SUPERSEDED;
  };

  const handleStop = async (sessionId: string): Promise<{ rawText: string | null }> => {
    const session = liveSession;
    // Another view's session, or one that has already ended.
    if (!session || session.id !== sessionId) return { rawText: null };
    if (session.stopPromise) return session.stopPromise;
    // Still preparing, so no provider has any of its audio. Ending it makes the
    // start bail at its next check instead of bringing the session up.
    if (session.phase === "starting") {
      endSession(session, "cancelled");
      return { rawText: null };
    }
    session.phase = "stopping";
    session.stopPromise = (async () => {
      try {
        // Drain the transcription service first (waits for pending
        // transcriptions, fires remaining complete events) — the subscription
        // stays up until it has.
        await service?.stopGracefully();
      } catch (error) {
        endSession(session, "failed");
        throw error;
      }
      endSession(session, "stopped");
      return { rawText: null };
    })();
    return session.stopPromise;
  };

  const handleFlushParagraph = (sessionId: string): { rawText: string | null } => {
    const session = liveSession;
    // Until the session is active, the service's provider belongs to no one.
    if (session?.id === sessionId && session.phase !== "starting") {
      service?.commitParagraphBoundary();
    }
    return { rawText: null };
  };

  const handleAudioChunk = (
    _event: Electron.IpcMainEvent,
    sessionId: unknown,
    chunk: ArrayBuffer
  ) => {
    const session = liveSession;
    // Audio for a session that isn't live — another view's, or one that has
    // already ended — must never reach the provider or the held buffer.
    if (!session || session.id !== sessionId) return;
    const pending = session.preStartAudio;
    if (!pending) {
      service?.sendAudioChunk(chunk);
      return;
    }
    // Drop-newest: the start of the utterance is what this buffer exists to keep.
    // Once full, stay full — a later, smaller chunk must not be spliced in after a gap.
    if (
      pending.overflowed ||
      pending.chunks.length >= AUDIO_BUFFER_MAX_CHUNKS ||
      pending.bytes + chunk.byteLength > AUDIO_BUFFER_MAX_BYTES
    ) {
      if (!pending.overflowed) {
        pending.overflowed = true;
        logWarn("[VoiceInput] Pre-start audio buffer full, dropping audio", {
          chunks: pending.chunks.length,
          bytes: pending.bytes,
        });
        reportAudioOverflow(session);
      }
      return;
    }
    pending.chunks.push(chunk);
    pending.bytes += chunk.byteLength;
  };

  const handleCheckMicPermission = () => {
    return checkMicPermission();
  };

  const handleRequestMicPermission = async () => {
    return requestMicPermission();
  };

  const handleOpenMicSettings = () => openMicSettings();

  const handleValidateApiKey = async (apiKey: string) => {
    const settings = getVoiceSettings();
    return validateOpenAIKey(apiKey, settings.organizationId, settings.projectId);
  };

  // Whole-passage cleanup pass. The renderer calls this once after recording
  // stops, with the full dictated text; correction runs as a single gpt-5.6-luna
  // request rather than the old per-segment streaming pipeline.
  const handleCorrect = async (
    request: VoiceInputCorrectPayload
  ): Promise<{ action: "no_change" | "replace"; correctedText: string }> => {
    const settings = getVoiceSettings();
    if (!settings.correctionEnabled || !settings.openaiApiKey || !request.rawText.trim()) {
      return { action: "no_change", correctedText: request.rawText };
    }

    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }

    const projectInfo = getProjectInfo();
    const result = await correctionService.correct(
      {
        rawText: request.rawText,
        recentContext: request.recentContext,
        reason: "stop",
      },
      {
        model: settings.correctionModel,
        apiKey: settings.openaiApiKey,
        customDictionary: settings.customDictionary,
        customInstructions: settings.correctionCustomInstructions,
        language: normalizeVoiceLanguage(settings.language),
        projectName: projectInfo.name,
        projectPath: projectInfo.path,
        organizationId: settings.organizationId,
        projectId: settings.projectId,
      }
    );

    return { action: result.action, correctedText: result.confirmedText };
  };

  const sessionNamespace = defineIpcNamespace({
    name: "voiceInput",
    ops: {
      start: opValidated(VOICE_INPUT_METHOD_CHANNELS.start, VoiceSessionIdSchema, handleStart, {
        withContext: true,
      }),
      stop: opValidated(VOICE_INPUT_METHOD_CHANNELS.stop, VoiceSessionIdSchema, handleStop),
      flushParagraph: opValidated(
        VOICE_INPUT_METHOD_CHANNELS.flushParagraph,
        VoiceSessionIdSchema,
        handleFlushParagraph
      ),
    },
  });

  const cleanups: Array<() => void> = [
    sessionNamespace.register(),
    typedHandle(CHANNELS.VOICE_INPUT_GET_SETTINGS, handleGetSettings),
    typedHandle(CHANNELS.VOICE_INPUT_SET_SETTINGS, handleSetSettings),
    typedHandle(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION, handleCheckMicPermission),
    typedHandle(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION, handleRequestMicPermission),
    typedHandle(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS, handleOpenMicSettings),
    typedHandle(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, handleValidateApiKey),
    typedHandleValidated(
      CHANNELS.VOICE_INPUT_CORRECT,
      VoiceInputCorrectPayloadSchema,
      handleCorrect
    ),
  ];

  // Fire-and-forget audio-chunk stream stays on ipcMain.on.
  ipcMain.on(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, handleAudioChunk);

  return () => {
    for (const cleanup of cleanups) cleanup();
    ipcMain.removeListener(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, handleAudioChunk);
    if (liveSession) endSession(liveSession, "cancelled");
    service?.destroy();
    service = null;
    servicePromise = null;
    correctionService = null;
    sessionController = null;
  };
}
