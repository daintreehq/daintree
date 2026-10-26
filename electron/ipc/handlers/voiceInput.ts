// eager-import-allow: reads voice-input settings via store.get synchronously in the IPC handler
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
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
import type { PtyClient } from "../../services/PtyClient.js";
import type {
  VoiceDictionaryEntry,
  VoiceInputSettings,
  VoiceInputSettingsPatch,
  VoiceTranscriptionProvider,
} from "../../../shared/types/ipc/api.js";
import type {
  VoiceLiveSessionUpdate,
  VoiceRewriteOutcome,
  LastDictationTerms,
  VoiceKeytermSource,
  VoiceSentTerm,
  VoiceSessionEndReason,
  VoiceStartOutcome,
} from "../../../shared/types/voice.js";
import type { VoiceSessionReport } from "../../../shared/types/voiceSessionSummary.js";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { buildOpenAIHeaders } from "../../../shared/utils/openaiHeaders.js";
import { voiceErrorLogFields } from "../../../shared/utils/voiceLogFields.js";
import {
  applyDictationCommands,
  extractSendCommand,
  type SendCommandResult,
} from "../../services/voiceDictationCommands.js";
import { VOICE_DICTATION_AI_MODEL } from "../../../shared/config/voiceCorrection.js";
import { normalizeVoiceLanguage } from "../../../shared/config/voiceLanguages.js";
import {
  assembleTaggedKeyterms,
  screenDictationNames,
} from "../../services/voiceContextKeyterms.js";
import { readProjectVoiceDictionary } from "../../services/projectVoiceDictionary.js";
import { flattenDictationNames, gatherDictationNames } from "../../services/voiceContextNames.js";
import { collectHeardAsRules, createHeardAsRewriter } from "../../../shared/utils/voiceHeardAs.js";
import {
  dictionaryTerms,
  sanitizeDictionary,
  sessionDictionary,
  sanitizeSuggestions,
  sanitizeDismissedSuggestions,
} from "../../../shared/utils/voiceDictionary.js";
import {
  AUDIO_BUFFER_MAX_BYTES,
  AUDIO_BUFFER_MAX_CHUNKS,
  AUDIO_BUFFER_OVERFLOW_CODE,
  NO_PROVIDER_SESSION_STATS,
  createAudioBufferOverflowError,
} from "../../services/voice/TranscriptionProvider.js";
import { voiceFileLinkResolver } from "../../services/VoiceFileLinkResolver.js";
import { mayReferenceFile } from "../../../shared/utils/voiceFileLinkCommands.js";
import { createTimeoutSignal } from "../../../shared/utils/timeoutSignal.js";
import { typedHandle, typedHandleWithContextValidated } from "../utils.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { ValidationError } from "../validationError.js";
import { AppError } from "../../utils/errorTypes.js";
import { VOICE_INPUT_METHOD_CHANNELS } from "./voiceInput.preload.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { openLinuxSoundSettings } from "../../services/voice/linuxSoundSettings.js";
import {
  VoiceInputCorrectPayloadSchema,
  VoiceInputRewritePayloadSchema,
  VoiceInputStartOptionsSchema,
  VoiceSessionIdSchema,
  type VoiceInputCorrectPayload,
  type VoiceInputRewritePayload,
  type VoiceInputStartOptions,
} from "../../schemas/ipc.js";
import { onWebContentsDestroyed } from "../../window/webContentsDestroyed.js";
import { isDictationKey } from "../../services/menuAccelerators.js";
import { registerPageDictationKey } from "../../services/voice/pageDictationKey.js";
import {
  getAllAppWebContents,
  getAppWebContents,
  getWindowForWebContents,
} from "../../window/webContentsRegistry.js";

let service: VoiceTranscriptionService | null = null;
let servicePromise: Promise<VoiceTranscriptionService> | null = null;
let correctionService: VoiceCorrectionService | null = null;
// The controller whose signal correctionService currently carries.
let sessionController: AbortController | null = null;

// A completion ending in a spoken "send it", waiting to see whether the
// speaker stays quiet. It goes out as a send, as literal words when the
// speaker went on, or stripped with no send when dictation stopped first.
type HeldSendOutcome = "send" | "literal" | "strip";
interface HeldSend {
  timer: ReturnType<typeof setTimeout>;
  readonly release: (outcome: HeldSendOutcome) => void;
}

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
  // The starting view's project at start (#14599). File links fall back to it
  // when no terminal vouches for a worktree.
  readonly projectInfo: { name?: string; path?: string };
  /** The terminal being dictated into, as the renderer named it at start. */
  readonly terminalId: string | undefined;
  /** "rewrite" records an instruction for selected text, forwarded as spoken. */
  readonly intent: "dictation" | "rewrite";
  // starting: main is still preparing, and the provider isn't this session's.
  // active: its provider has been started (it may still be connecting).
  // stopping: a stop owns its graceful drain.
  phase: "starting" | "active" | "stopping";
  ended: boolean;
  stopPromise: Promise<{ rawText: string | null }> | null;
  readonly controller: AbortController;
  unsubscribe: (() => void) | null;
  unwatchDestroyed: (() => void) | null;
  // The renderer streams audio from the moment it sends the start request,
  // before main has loaded the service, assembled keyterms, and created a
  // provider. Chunks for a session still starting are held here and handed to
  // its provider exactly once; without this they'd go to no provider, or to the
  // previous session's.
  preStartAudio: { chunks: ArrayBuffer[]; bytes: number; overflowed: boolean } | null;
  // Settles once the held audio is in this session's provider, or once the
  // session has ended, so a stop that lands while it is still starting can
  // wait for the handoff instead of discarding what was said.
  readonly handedOff: Promise<void>;
  readonly markHandedOff: () => void;
  // Overflow can be hit both here and in the provider's own connect buffer —
  // one report per session is enough.
  overflowReported: boolean;
  // Spoken file references still resolving, one job per transcript. A stop
  // waits for them before ending the session, so a reference in the final
  // utterance lands before the renderer's post-stop correction reads the
  // draft. Ending the session for any reason aborts what is left.
  readonly fileLinkJobs: Set<Promise<void>>;
  heldSend: HeldSend | null;
  // Main's share of the session summary, sent with its ended notice. Kept
  // apart from the buffers above, which are released as the session goes.
  readonly stats: Pick<
    VoiceSessionReport,
    "provider" | "biasTermCount" | "droppedPreStart" | "completedSegments" | "emptyCompletions"
  >;
}

// The most recent dictation's request, for the settings page. Memory only, and
// replaced by the next dictation. The source lookup is lowercased because
// providers report terms after trimming and dedup, not as assembled.
let lastDictationTerms: LastDictationTerms | null = null;
let lastTermSources = new Map<string, VoiceKeytermSource>();

let liveSession: VoiceSession | null = null;
// A replaced session whose provider is still draining. The service stays its
// until the drain settles, so a newer session waits for it before starting.
let drainingSession: VoiceSession | null = null;
// Grows with every change of the live session, so a view can order the
// snapshot it pulled against the updates pushed to it.
let liveSessionRevision = 0;

function isLive(session: VoiceSession): boolean {
  return liveSession === session && !session.ended;
}

/** The live session as one view sees it: none when that view owns it. */
function liveSessionUpdateFor(webContentsId: number): VoiceLiveSessionUpdate {
  const session = liveSession;
  if (!session || session.ended || session.webContentsId === webContentsId) {
    return { revision: liveSessionRevision, session: null };
  }
  return {
    revision: liveSessionRevision,
    session: {
      sessionId: session.id,
      projectId: session.projectId,
      projectName: session.projectInfo.name ?? null,
    },
  };
}

// Every view hears about it, cached ones included: the dictation key has to
// stop the live session from any of them, and each says where it runs.
function publishLiveSession(): void {
  liveSessionRevision++;
  for (const wc of getAllAppWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(CHANNELS.VOICE_INPUT_LIVE_SESSION, liveSessionUpdateFor(wc.id));
    } catch {
      // A view being torn down misses it; a new one pulls the current state.
    }
  }
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
 * Ask the live session's owner to stop it, as the owner's own dictation key
 * would: the owner drains it, so the text lands in its draft and its microphone
 * is released. False when nothing is live, or when `sessionId` names another.
 */
export function requestLiveSessionStop(sessionId?: string): boolean {
  const session = liveSession;
  if (!session || session.ended || session.sender.isDestroyed()) return false;
  if (sessionId !== undefined && session.id !== sessionId) return false;
  session.sender.send(CHANNELS.VOICE_INPUT_STOP_REQUESTED, { sessionId: session.id });
  return true;
}

/**
 * Whether a focused page that isn't an app view (a browser or dev-preview
 * guest, a portal tab) takes this keystroke from the page. The dictation key
 * stops dictation running in any view, as it would from an app view; a held
 * key's repeats go with it. With nothing running it stays the page's (#14601).
 */
export function claimDictationKey(input: Electron.Input): boolean {
  // Checked first: idle on nearly every keystroke, so most skip the binding lookup.
  if (!liveSession || liveSession.ended) return false;
  if (!isDictationKey(input)) return false;
  if (input.isAutoRepeat) return true;
  return requestLiveSessionStop();
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
  if (liveSession === session) {
    liveSession = null;
    publishLiveSession();
  }
  // A stop or a dying provider has already let a held send's words through;
  // what is left belongs to a session nobody is dictating into any more.
  if (session.heldSend) clearTimeout(session.heldSend.timer);
  session.heldSend = null;
  // A provider that never reported (rejected, or cancelled while connecting)
  // sent nothing, and must not read as still connecting or as trimmed by limits.
  if (lastDictationTerms?.sessionId === session.id && lastDictationTerms.sent === null) {
    lastDictationTerms = { ...lastDictationTerms, sent: [], endedBeforeSending: true };
  }
  session.preStartAudio = null;
  session.markHandedOff();
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
  // Read before the caller retires the provider: until then it is still this
  // session's, or the service answers null.
  const report: VoiceSessionReport = {
    ...session.stats,
    ...(service?.getSessionStats(session.id) ?? NO_PROVIDER_SESSION_STATS),
  };
  if (!session.sender.isDestroyed()) {
    session.sender.send(CHANNELS.VOICE_INPUT_SESSION_ENDED, {
      sessionId: session.id,
      reason,
      report,
    });
  }
}

const SUPERSEDED: VoiceStartOutcome = { status: "superseded" };

// Bounds a whole file-link job (detection, worktree lookup, search, rerank),
// and so how long a stop can wait on one. Local search ignores abort signals,
// so the job is raced against its deadline rather than trusted to stop.
const FILE_LINK_JOB_TIMEOUT_MS = 6000;

// Deepgram ends an utterance after 300ms of silence (`endpointing=300`), a
// pause that falls inside sentences, so a completion ending in "send it" is
// held this much longer: about a second of silence in all, close to what
// OpenAI's VAD waits before it ends an utterance.
const SPOKEN_SEND_SETTLE_MS = 700;
// Deepgram's VAD hears speech start long before an interim result for it, and
// noise can set it off too: a held send then waits this long for a transcript
// to show the speaker went on.
const SPOKEN_SEND_SPEECH_CONFIRM_MS = 1500;

function releaseHeldSend(session: VoiceSession, outcome: HeldSendOutcome): void {
  const held = session.heldSend;
  if (!held) return;
  session.heldSend = null;
  clearTimeout(held.timer);
  held.release(outcome);
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}

function normalizeSpoken(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const VALID_TRANSCRIPTION_PROVIDERS: VoiceTranscriptionProvider[] = ["openai", "deepgram"];

// The only fields setSettings writes. Everything else is refused: `keyterms` is
// assembled per session, the dictionary and its suggestion queue change only
// through the voiceDictionary operations so a stale renderer copy can't
// overwrite them, and a dotted key would reach inside either through the
// store's dot-path setter. Typed against the patch, so a new setting must be
// listed here to be saved at all.
const WRITABLE_VOICE_FIELDS: Record<keyof VoiceInputSettingsPatch, true> = {
  enabled: true,
  openaiApiKey: true,
  deepgramApiKey: true,
  language: true,
  transcriptionProvider: true,
  transcriptionModel: true,
  correctionEnabled: true,
  correctionModel: true,
  correctionCustomInstructions: true,
  paragraphingStrategy: true,
  resolveFileLinks: true,
  deviceId: true,
  organizationId: true,
  projectId: true,
  recordingMode: true,
  learnFromCorrections: true,
};

const VOICE_INPUT_DEFAULTS: VoiceInputSettings = {
  enabled: false,
  openaiApiKey: "",
  deepgramApiKey: "",
  language: "en",
  dictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: true,
  correctionModel: VOICE_DICTATION_AI_MODEL,
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "tap-or-hold",
  suggestedDictionary: [],
  dismissedSuggestions: [],
  learnFromCorrections: true,
};

/** Read voiceInput settings with defaults for fields added after initial store creation. */
export function getVoiceSettings(): VoiceInputSettings {
  const stored = store.get("voiceInput") as
    | (Partial<VoiceInputSettings> & {
        apiKey?: string;
        correctionApiKey?: string;
        customDictionary?: unknown;
      })
    | undefined;

  // Pluck truly-legacy key fields so they don't leak into the merged object via
  // spread. `deepgramApiKey` is now a first-class field, so it flows through
  // `rest` instead of being dropped. `keyterms` is runtime-only — drop any value
  // a stale store/migration left behind so it never seeds a session.
  const { apiKey, correctionApiKey, keyterms, customDictionary, ...rest } = stored ?? {};
  void keyterms;
  const merged: VoiceInputSettings = { ...VOICE_INPUT_DEFAULTS, ...rest };

  // migration036 turned the old word list into entries. A list that shows up
  // again on a store already past it (a downgraded build, another branch on a
  // shared dev profile) is folded in rather than lost, then dropped from disk.
  // Anything else needing repair (a missing time, a case-only repeat, a broken
  // suggestion) is fixed here and written back once, so a repaired value is
  // the same on every read.
  const storedEntries: unknown[] = Array.isArray(rest.dictionary) ? rest.dictionary : [];
  merged.dictionary = sanitizeDictionary(
    Array.isArray(customDictionary) ? [...storedEntries, ...customDictionary] : storedEntries,
    Date.now()
  );
  merged.suggestedDictionary = sanitizeSuggestions(rest.suggestedDictionary ?? []);
  merged.dismissedSuggestions = sanitizeDismissedSuggestions(rest.dismissedSuggestions ?? []);
  const dictionaryRepaired =
    customDictionary !== undefined ||
    JSON.stringify(rest.dictionary ?? []) !== JSON.stringify(merged.dictionary) ||
    JSON.stringify(rest.suggestedDictionary ?? []) !== JSON.stringify(merged.suggestedDictionary) ||
    JSON.stringify(rest.dismissedSuggestions ?? []) !== JSON.stringify(merged.dismissedSuggestions);

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

  // Same one-shot cleanup for the correction model: gpt-6-luna replaced the
  // retired gpt-5-mini/gpt-5-nano tiers, so this union is single-valued too.
  // migration025 upgrades stores on older schema versions; this read-time net
  // catches stores already on the current version (never revisited by the
  // migration), plus post-downgrade or hand-edited values. Not a user-choice
  // revert — there is no correction-model choice left to preserve.
  const staleCorrectionModel = merged.correctionModel !== VOICE_DICTATION_AI_MODEL;
  if (staleCorrectionModel) merged.correctionModel = VOICE_DICTATION_AI_MODEL;

  // Normalize malformed recordingMode values in memory only (no write-back).
  if (
    merged.recordingMode !== "toggle" &&
    merged.recordingMode !== "push-to-talk" &&
    merged.recordingMode !== "tap-or-hold"
  ) {
    merged.recordingMode = "tap-or-hold";
  }

  // Persist the cleaned object on first read after upgrade so the legacy key
  // fields disappear from disk and any defaulted/normalized values are written
  // through. `store.set` with a full object replaces.
  if (
    apiKey !== undefined ||
    correctionApiKey !== undefined ||
    dictionaryRepaired ||
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

function getProjectInfo(projectId: string | null): { name?: string; path?: string } {
  const currentProject = projectId ? projectStore.getProjectById(projectId) : null;
  if (!currentProject) return {};
  return { name: currentProject.name, path: currentProject.path };
}

// Automatic hints come only from the terminal being dictated into: its output,
// its worktree's branch, its owning project's name, and names read from that
// project's repository (package, workspace, directory and dependency names).
// All of them are sent to the transcription provider. A terminal main doesn't
// track, or one another project owns than the view asking, contributes none.
function resolveKeytermTarget(
  viewProjectId: string | null,
  terminalId: string | undefined,
  ptyClient: PtyClient | undefined
): { terminalId?: string; projectName?: string; projectPath?: string } {
  if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return {};
  const ownerId = ptyClient.getTerminalProjectId(terminalId);
  if (ownerId && viewProjectId && ownerId !== viewProjectId) return {};
  const project = ownerId ? projectStore.getProjectById(ownerId) : undefined;
  return { terminalId, projectName: project?.name, projectPath: project?.path };
}

// References resolve in the worktree the dictated terminal is filed under,
// else its cwd, as keyterms do. Without a terminal main can vouch for, the
// starting view's project; a view that owns no project resolves nothing, never
// the app's current one (#14599).
async function resolveFileLinkCwd(
  session: VoiceSession,
  ptyClient: PtyClient | undefined
): Promise<string | null> {
  const { terminalId } = resolveKeytermTarget(session.projectId, session.terminalId, ptyClient);
  if (terminalId && ptyClient) {
    const terminal = await ptyClient.getTerminalAsync(terminalId).catch(() => null);
    const path = terminal?.worktreeId ?? terminal?.cwd;
    if (typeof path === "string" && isAbsolute(path)) return path;
  }
  return session.projectInfo.path ?? null;
}

// The project whose vocabulary a dictation uses: the one that owns the target
// terminal, or the asking view's own for a panel main doesn't track as a
// terminal. A terminal another project owns than the view asking gets none,
// so a project's rules never reach dictation outside its own panels.
function resolveVocabularyProject(
  viewProjectId: string | null,
  terminalId: string | undefined,
  ptyClient: PtyClient | undefined
): string | null {
  if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return viewProjectId;
  const ownerId = ptyClient.getTerminalProjectId(terminalId);
  if (ownerId && viewProjectId && ownerId !== viewProjectId) return null;
  return ownerId ?? viewProjectId;
}

// An unreadable vocabulary leaves dictation with the global dictionary alone.
async function readVocabulary(projectId: string | null): Promise<VoiceDictionaryEntry[]> {
  if (!projectId) return [];
  try {
    return await readProjectVoiceDictionary(projectId);
  } catch {
    logDebug("[VoiceInput] Project vocabulary read failed, using the global dictionary alone");
    return [];
  }
}

// The names the latest dictation sent, so its end-of-passage correction spells
// them the same way. Keyed by view: another view's names aren't this one's.
let lastSessionNames: { webContentsId: number; names: string[] } | null = null;

export function registerVoiceInputHandlers(deps: HandlerDependencies): () => void {
  const handleGetSettings = async () => {
    return getVoiceSettings();
  };

  const handleSetSettings = async (patch: VoiceInputSettingsPatch) => {
    if (!patch || typeof patch !== "object") return;
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!Object.hasOwn(WRITABLE_VOICE_FIELDS, field)) continue;
      store.set(`voiceInput.${field}`, value);
    }
  };

  const reportAudioOverflow = (session: VoiceSession) => {
    if (session.overflowReported) return;
    session.overflowReported = true;
    if (session.sender.isDestroyed()) return;
    session.sender.send(CHANNELS.VOICE_INPUT_ERROR, {
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

  const findFileLinks = async (
    session: VoiceSession,
    correctionSvc: VoiceCorrectionService,
    transcriptId: string,
    text: string,
    settings: VoiceInputSettings,
    signal: AbortSignal
  ): Promise<void> => {
    const credentials = {
      apiKey: settings.openaiApiKey,
      organizationId: settings.organizationId,
      projectId: settings.projectId,
    };
    const detected = await correctionSvc.detectFileLinkTokens(text, credentials, signal);
    // A description the transcript doesn't contain has nowhere to land.
    const spoken = normalizeSpoken(text);
    const descriptions = detected
      .map(({ description }) => description.trim())
      .filter((description) => spoken.includes(normalizeSpoken(description)));
    if (descriptions.length === 0 || signal.aborted) return;
    const cwd = await resolveFileLinkCwd(session, deps.ptyClient);
    if (!cwd || signal.aborted) return;
    const paths = await Promise.all(
      descriptions.map((description) =>
        voiceFileLinkResolver.resolve({ cwd, description, ...credentials, signal })
      )
    );
    // A local match returns without consulting the signal.
    if (signal.aborted) return;
    // Misses go too, so a hit can't claim a missed command's words; their
    // own words stay as spoken.
    const references = descriptions.map((description, i) => ({
      description,
      path: paths[i] ?? null,
    }));
    const resolved = references.filter((reference) => reference.path).length;
    logDebug("[VoiceInput] File links resolved", { detected: references.length, resolved });
    // The view that started the session, wherever it is now; never the app's
    // current view (#14599).
    if (resolved === 0 || session.sender.isDestroyed()) return;
    session.sender.send(CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED, {
      sessionId: session.id,
      transcriptId,
      references,
    });
  };

  const trackFileLinkJob = (
    session: VoiceSession,
    run: (signal: AbortSignal) => Promise<void>
  ): void => {
    const deadline = createTimeoutSignal(FILE_LINK_JOB_TIMEOUT_MS, session.controller.signal);
    const work = run(deadline.signal).catch((error: unknown) => {
      logWarn("[VoiceInput] File link resolution failed", voiceErrorLogFields(error));
    });
    const job: Promise<void> = Promise.race([work, whenAborted(deadline.signal)]).finally(() => {
      deadline.dispose();
      session.fileLinkJobs.delete(job);
    });
    session.fileLinkJobs.add(job);
  };

  // Drains the provider a session owns, keeping its subscription up so the
  // remaining text reaches its owner, then ends it.
  const drainSession = (
    session: VoiceSession,
    reason: "stopped" | "superseded"
  ): Promise<{ rawText: string | null }> => {
    session.stopPromise = (async () => {
      // The renderer sends every chunk it captured before this stop, so audio
      // held for a session still loading the service or assembling keyterms is
      // the whole dictation so far. Let the start hand it to the provider, then
      // drain the provider like any other session: its stop-before-ready path
      // transcribes the buffered audio once connected.
      if (session.phase === "starting") await session.handedOff;
      // Superseded, failed, or its view went away before the handoff; whatever
      // ended it chose the reason and owns the provider.
      if (session.ended) return { rawText: null };
      session.phase = "stopping";
      // Dictation stopped before a held send was confirmed: keep its words,
      // drop the command, and send nothing.
      releaseHeldSend(session, "strip");
      try {
        // Drain the transcription service first (waits for pending
        // transcriptions, fires remaining complete events) — the subscription
        // stays up until it has.
        await service?.stopGracefully();
      } catch (error) {
        endSession(session, "failed");
        throw error;
      }
      // The drain can finish the final utterance, whose references only start
      // resolving then. Each job is bounded, and ending the session another
      // way aborts them.
      await Promise.allSettled(session.fileLinkJobs);
      endSession(session, reason);
      return { rawText: null };
    })();
    return session.stopPromise;
  };

  // A newer start takes over from the live session. One still preparing has no
  // provider and ends now, and one whose own stop is draining finishes it. One
  // running in another view is drained on its owner's behalf, so that view
  // keeps the text it was given and releases its microphone. A view replacing
  // its own session has already let the old one go, so that one is cut short.
  const retireSession = (previous: VoiceSession, next: VoiceSession) => {
    if (previous.phase === "starting") {
      endSession(previous, "superseded");
      return;
    }
    if (previous.phase === "active") {
      if (previous.webContentsId === next.webContentsId) {
        endSession(previous, "superseded");
        service?.stop();
        return;
      }
      // Told first, so the owner stops capturing and waits on the drain
      // instead of treating it as its own stop.
      if (!previous.sender.isDestroyed()) {
        previous.sender.send(CHANNELS.VOICE_INPUT_STATUS, {
          sessionId: previous.id,
          status: "finishing",
        });
      }
      drainSession(previous, "superseded");
    }
    const draining = previous.stopPromise;
    if (!draining) return;
    drainingSession = previous;
    const release = () => {
      if (drainingSession === previous) drainingSession = null;
    };
    draining.then(release, release);
  };

  // A failed or superseded start is an outcome, not an exception: the
  // provider's message goes back to the renderer and never through the IPC
  // error logger, where it could quote dictated text (#14620).
  const handleStart = async (
    ctx: IpcContext,
    sessionId: string,
    options?: VoiceInputStartOptions
  ): Promise<VoiceStartOutcome> => {
    // Validated here rather than by opValidated, which parses a single
    // payload: a malformed start must not supersede the one in flight.
    if (
      !VoiceSessionIdSchema.safeParse(sessionId).success ||
      !VoiceInputStartOptionsSchema.safeParse(options).success
    ) {
      throw new ValidationError(VOICE_INPUT_METHOD_CHANNELS.start);
    }
    // Events and the ended notice go back to the view that started it.
    const sender = ctx.event?.sender;
    if (!sender || sender.isDestroyed()) return SUPERSEDED;
    // Two sessions under one id would make every chunk and stop ambiguous.
    if (liveSession?.id === sessionId || drainingSession?.id === sessionId) {
      throw new AppError({ code: "VALIDATION", message: "Voice session already started" });
    }
    // Published before the first await, so a stop or a newer start landing
    // during the service import or keyterm assembly sees this session, and its
    // audio buffer is armed before any chunk of this capture can arrive.
    let markHandedOff!: () => void;
    const handedOff = new Promise<void>((resolve) => {
      markHandedOff = resolve;
    });
    const session: VoiceSession = {
      id: sessionId,
      sender,
      webContentsId: ctx.webContentsId,
      projectId: ctx.projectId,
      projectInfo: getProjectInfo(ctx.projectId),
      terminalId: options?.terminalId,
      intent: options?.intent ?? "dictation",
      phase: "starting",
      ended: false,
      stopPromise: null,
      controller: new AbortController(),
      unsubscribe: null,
      unwatchDestroyed: null,
      preStartAudio: { chunks: [], bytes: 0, overflowed: false },
      overflowReported: false,
      handedOff,
      markHandedOff,
      fileLinkJobs: new Set(),
      heldSend: null,
      stats: {
        provider: null,
        biasTermCount: null,
        droppedPreStart: 0,
        completedSegments: 0,
        emptyCompletions: 0,
      },
    };
    const previous = liveSession;
    liveSession = session;
    if (previous) retireSession(previous, session);
    publishLiveSession();
    // A view that goes away takes its session with it, and stops the provider
    // if the session has one: live, or replaced and still draining.
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
      outcome = await startSession(session, startedAt, options?.terminalId);
    } catch (error) {
      if (session.phase !== "stopping") endSession(session, "failed");
      throw error;
    } finally {
      session.markHandedOff();
    }
    if (outcome.status === "failed" && session.phase !== "stopping") {
      endSession(session, "failed");
    }
    return outcome;
  };

  const startSession = async (
    session: VoiceSession,
    startedAt: number,
    terminalId: string | undefined
  ): Promise<VoiceStartOutcome> => {
    const svc = await getService();
    const serviceReadyAt = performance.now();
    // The renderer went away during the import — nothing is left to record for.
    if (session.sender.isDestroyed()) endSession(session, "cancelled");
    if (!isLive(session)) return SUPERSEDED;
    // Snapshot transcription settings at session start (model, language, API key).
    // Correction settings are read live from store per-event so mid-session changes apply.
    const settings = getVoiceSettings();
    session.stats.provider = settings.transcriptionProvider;
    // Like the keyterms, the rules are the dictionary as it was at the start.
    const rewriteHeardAs = createHeardAsRewriter(collectHeardAsRules(settings.dictionary));

    // Kick off keyterm assembly concurrently with the subscription/provider
    // setup below so leading speech isn't delayed waiting on git/terminal reads.
    // Both providers consume the result: Deepgram via repeated `keyterm=` params,
    // OpenAI via the transcription prompt. Each provider freezes the list for
    // the session, so its reconnect path reuses it unchanged. Assembly, the
    // names read included, is capped internally (~500ms) and failures are
    // non-fatal — we just start without keyterms.
    const projectDictionary = readVocabulary(
      resolveVocabularyProject(session.projectId, terminalId, deps.ptyClient)
    ).then(dictionaryTerms);
    const names = gatherDictationNames({
      projectId: session.projectId,
      terminalId,
      ptyClient: deps.ptyClient,
      worktreeService: deps.worktreeService,
    });
    // The correction gets the same screened names as the keyterms, whenever
    // they arrive. Its own record, so a slow read from an older session can't
    // overwrite this one's.
    const sessionNames = { webContentsId: session.webContentsId, names: [] as string[] };
    lastSessionNames = sessionNames;
    void names.then((gathered) => {
      sessionNames.names = flattenDictationNames(screenDictationNames(gathered));
    });
    const keytermsPromise = assembleTaggedKeyterms({
      customDictionary: dictionaryTerms(settings.dictionary),
      projectDictionary,
      ...resolveKeytermTarget(session.projectId, terminalId, deps.ptyClient),
      ptyClient: deps.ptyClient,
      names,
    }).catch((err: unknown): VoiceSentTerm[] => {
      logDebug("[VoiceInput] Keyterm assembly failed, starting without keyterms", {
        ...voiceErrorLogFields(err),
      });
      return [];
    });
    // Counted whenever assembly lands: OpenAI's start doesn't wait for it.
    void keytermsPromise.then((terms) => {
      session.stats.biasTermCount = terms.length;
    });

    // OpenAI Realtime emits spoken dictation commands ("new paragraph",
    // "new line", "send it") as literal text; they are rewritten post-hoc,
    // gated on the session-snapshotted paragraphing strategy.
    const spokenCommands =
      settings.paragraphingStrategy === "spoken-command" &&
      normalizeVoiceLanguage(settings.language) === "en";
    // OpenAI's VAD already waits out a long silence, and checks it again,
    // before it ends an utterance; only Deepgram's short endpoint needs more.
    const sendSettleMs = settings.transcriptionProvider === "deepgram" ? SPOKEN_SEND_SETTLE_MS : 0;

    const emitCompletion = (
      itemId: string | undefined,
      rawText: string,
      sendCommand: SendCommandResult
    ) => {
      const target = session.sender;
      if (target.isDestroyed()) return;
      const sessionId = session.id;
      const liveSettings = getVoiceSettings();
      // applyDictationCommands rewrites trailing break commands to \n\n / \n.
      const processedText = spokenCommands ? applyDictationCommands(sendCommand.text) : rawText;

      // Split on line breaks and emit one complete event per non-empty part
      // with a paragraph_boundary between each pair of pieces. Empty pieces
      // still get their boundary, so a break at the start or end of an
      // utterance ("fix the bug new line") survives for the next utterance.
      const pieces = processedText.split(/\s*\n\s*/).map((p) => p.trim());
      const parts = pieces.filter(Boolean);
      // Heard-as rules run after the commands, so a rule never eats a break
      // or a send and a term it writes is never taken for one, and over the
      // whole text, so a code fence spanning lines still protects what's
      // inside. Rules never cross or write a line break, so the pieces line up.
      const writtenText = rewriteHeardAs(processedText);
      const written = writtenText.split(/\s*\n\s*/).map((p) => p.trim());
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
      const itemIdField = itemId ? { itemId } : {};
      // Spoken file references resolve after the words land. Every part of
      // this transcript carries the id their result will name, so the
      // renderer swaps them inside these words and nowhere else.
      const correctionSvc = correctionService;
      const transcriptId =
        correctionSvc &&
        parts.length > 0 &&
        liveSettings.correctionEnabled &&
        liveSettings.resolveFileLinks &&
        liveSettings.openaiApiKey &&
        mayReferenceFile(writtenText)
          ? randomUUID()
          : undefined;
      if (parts.length === 0 && itemId && !sendCommand.send) {
        target.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          sessionId,
          text: "",
          willCorrect: false,
          ...itemIdField,
        });
      }
      // The send rides the utterance's final completion, after every piece
      // and break, so the renderer acts on it with all of the text in place.
      const lastIndex = pieces.length - 1;
      for (let i = 0; i < pieces.length; i++) {
        if (pieces[i]) {
          // What was heard goes along, so the renderer can rerun the rules
          // over the whole dictation at stop without rewriting a term twice.
          const text = written[i] ?? pieces[i];
          target.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
            sessionId,
            text,
            willCorrect: false,
            ...(text !== pieces[i] ? { heard: pieces[i] } : {}),
            ...itemIdField,
            ...(transcriptId ? { transcriptId } : {}),
            ...(sendCommand.send && i === lastIndex ? { send: true } : {}),
          });
        }
        if (i < lastIndex) {
          target.send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
            sessionId,
            rawText: null,
            correctionId: null,
          });
        }
      }
      if (sendCommand.send && !pieces[lastIndex]) {
        target.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          sessionId,
          text: "",
          willCorrect: false,
          ...itemIdField,
          send: true,
        });
      }

      if (correctionSvc && transcriptId) {
        // The renderer finds each description in the draft, so detection
        // reads the text the draft got.
        trackFileLinkJob(session, (signal) =>
          findFileLinks(session, correctionSvc, transcriptId, writtenText, liveSettings, signal)
        );
      }
    };

    // Until it goes out, the renderer keeps whatever preview the item's
    // interim results gave it.
    const holdSend = (
      itemId: string | undefined,
      rawText: string,
      sendCommand: SendCommandResult
    ) => {
      const held: HeldSend = {
        timer: setTimeout(() => releaseHeldSend(session, "send"), sendSettleMs),
        release: (outcome) =>
          emitCompletion(
            itemId,
            rawText,
            outcome === "send"
              ? sendCommand
              : { text: outcome === "literal" ? rawText : sendCommand.text, send: false }
          ),
      };
      session.heldSend = held;
    };

    // Runs ahead of forwarding each provider event, so a held completion
    // reaches the renderer before anything the provider said after it.
    const settleHeldSend = (voiceEvent: VoiceSessionEvent) => {
      const held = session.heldSend;
      if (!held) return;
      switch (voiceEvent.type) {
        case "speech_started":
          clearTimeout(held.timer);
          held.timer = setTimeout(
            () => releaseHeldSend(session, "send"),
            SPOKEN_SEND_SPEECH_CONFIRM_MS
          );
          return;
        case "delta":
        case "complete":
        case "paragraph_boundary":
          releaseHeldSend(session, "literal");
          return;
        case "status":
          // A provider that dies ends the dictation, like a stop.
          if (voiceEvent.status === "error" || voiceEvent.status === "idle") {
            releaseHeldSend(session, "strip");
          } else if (voiceEvent.status === "reconnecting") {
            // Nothing is transcribed while the socket is down, so the window
            // can no longer show whether the speaker went on: keep the words.
            releaseHeldSend(session, "literal");
          }
          return;
      }
    };

    const recordSentTerms = (voiceEvent: VoiceSessionEvent & { type: "terms_sent" }) => {
      if (lastDictationTerms?.sessionId !== session.id) return;
      const sent: VoiceSentTerm[] = [];
      for (const term of voiceEvent.terms) {
        const source = lastTermSources.get(term.trim().toLowerCase());
        if (source) sent.push({ term, source });
      }
      lastDictationTerms = {
        ...lastDictationTerms,
        sent,
        ...(voiceEvent.keytermAttempt ? { keytermAttempt: voiceEvent.keytermAttempt } : {}),
      };
    };

    const forwardEvent = (voiceEvent: VoiceSessionEvent) => {
      if (voiceEvent.type === "terms_sent") {
        recordSentTerms(voiceEvent);
        return;
      }
      const target = session.sender;
      if (target.isDestroyed()) return;
      const sessionId = session.id;

      if (voiceEvent.type === "delta") {
        logDebug("[VoiceInput] → renderer delta", { length: voiceEvent.text.length });
        target.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, {
          sessionId,
          text: voiceEvent.text,
          ...(voiceEvent.itemId ? { itemId: voiceEvent.itemId } : {}),
          ...(voiceEvent.replace ? { replace: true } : {}),
        });
      } else if (voiceEvent.type === "complete" && session.intent === "rewrite") {
        // An instruction, not prompt text: "new line" is part of what was asked.
        logDebug("[VoiceInput] instruction complete → renderer", {
          rawLength: voiceEvent.text.length,
        });
        target.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
          sessionId,
          text: voiceEvent.text.trim(),
          willCorrect: false,
          ...(voiceEvent.itemId ? { itemId: voiceEvent.itemId } : {}),
        });
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();
        // A trailing "send it" that ends the utterance is stripped and handed
        // to the renderer, which owns the send; one the provider cut
        // mid-speech stays literal.
        const sendCommand =
          spokenCommands && voiceEvent.endOfSpeech
            ? extractSendCommand(rawText)
            : { text: rawText, send: false };
        if (sendCommand.send && sendSettleMs > 0 && session.phase === "active") {
          holdSend(voiceEvent.itemId, rawText, sendCommand);
        } else {
          emitCompletion(voiceEvent.itemId, rawText, sendCommand);
        }
      } else if (voiceEvent.type === "paragraph_boundary") {
        if (session.intent === "rewrite") return;
        target.send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
          sessionId,
          rawText: null,
        });
      } else if (voiceEvent.type === "error") {
        if (voiceEvent.error.code === AUDIO_BUFFER_OVERFLOW_CODE) {
          if (session.overflowReported) return;
          session.overflowReported = true;
        }
        target.send(CHANNELS.VOICE_INPUT_ERROR, {
          sessionId,
          error: voiceEvent.error,
        });
      } else if (voiceEvent.type === "status") {
        target.send(CHANNELS.VOICE_INPUT_STATUS, {
          sessionId,
          status: voiceEvent.status,
        });
      }
    };

    session.unsubscribe = svc.onEvent((voiceEvent) => {
      // A retired provider's events, and anything after this session ended.
      if (voiceEvent.sessionId !== session.id || session.ended) return;
      settleHeldSend(voiceEvent);
      // Counted per provider segment, before the split into paragraph pieces.
      if (voiceEvent.type === "complete") {
        if (voiceEvent.text.trim()) session.stats.completedSegments++;
        else session.stats.emptyCompletions++;
      }
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

    // Deepgram needs the terms to open its socket, so it waits for them here,
    // still starting. OpenAI opens its socket now and takes them as they land,
    // since it only sends them once the socket is open. Assembly has its own
    // internal timeouts, so this await is bounded.
    let taggedKeyterms: VoiceSentTerm[] | null = null;
    const termsWaitStartedAt = performance.now();
    if (svc.keytermsNeededToConnect(settings)) {
      taggedKeyterms = await keytermsPromise;
      // A stop, a newer start or the owner going away ended this session while
      // assembly ran. Whatever ended it already released its subscription and
      // watcher, so there is nothing of ours left to undo.
      if (!isLive(session)) return SUPERSEDED;
    }
    const keytermsReadyAt = performance.now();
    // The session this one replaced is still draining the provider, and
    // starting now would destroy it mid-drain. This session's audio keeps
    // going to its own buffer meanwhile.
    const draining = drainingSession?.stopPromise;
    if (draining) {
      await draining.catch(() => {});
      if (!isLive(session)) return SUPERSEDED;
    }
    // This session takes the slot before its provider starts, and its terms are
    // recorded before the provider is handed them, so the provider's report of
    // what it sent always finds them. OpenAI's land after the start, through the
    // promise it waits on; until then nothing has been sent, so `sent` is null.
    // A spoken rewrite instruction is a provider request too, so it takes the
    // slot, marked as one.
    lastTermSources = new Map();
    lastDictationTerms = {
      sessionId: session.id,
      provider: settings.transcriptionProvider,
      assembledCount: 0,
      sent: null,
      startedAt: Date.now(),
      ...(session.intent === "rewrite" ? { rewrite: true as const } : {}),
    };
    const recordAssembledTerms = (tagged: VoiceSentTerm[]): string[] => {
      if (lastDictationTerms?.sessionId === session.id) {
        // First wins: assembly dedups on the untrimmed term, so two entries can
        // share a trimmed key, and the provider keeps the earlier one.
        const sources = new Map<string, VoiceKeytermSource>();
        for (const entry of tagged) {
          const key = entry.term.trim().toLowerCase();
          if (!sources.has(key)) sources.set(key, entry.source);
        }
        lastTermSources = sources;
        lastDictationTerms = { ...lastDictationTerms, assembledCount: tagged.length };
      }
      return tagged.map((entry) => entry.term);
    };
    const keyterms = taggedKeyterms ? recordAssembledTerms(taggedKeyterms) : null;
    const providerStartAt = performance.now();
    // Bound at the handoff: until now a session this one replaced may still be
    // draining, and its file-link detection runs under its own signal.
    correctionService ??= new VoiceCorrectionService();
    sessionController = session.controller;
    correctionService.setSessionSignal(session.controller.signal);
    // Field names avoid "key": the logger blanks any field containing it.
    logInfo("[VoiceInput] Start timing — provider start", {
      sessionId: session.id,
      serviceLoadMs: Math.round(serviceReadyAt - startedAt),
      biasTermsWaitMs: Math.round(keytermsReadyAt - termsWaitStartedAt),
      drainWaitMs: Math.round(providerStartAt - keytermsReadyAt),
      elapsedMs: Math.round(providerStartAt - startedAt),
      heldChunks: session.preStartAudio?.chunks.length ?? 0,
    });
    // Not awaited before the flush: start() installs the provider and enters its
    // pending-start state synchronously, so the held audio lands in the
    // provider's own connect buffer, ahead of any chunk that arrives next.
    session.phase = "active";
    const startPromise = keyterms
      ? svc.start({ ...settings, keyterms }, session.id)
      : svc.start(settings, session.id, { keyterms: keytermsPromise.then(recordAssembledTerms) });
    flushPreStartAudio(session, svc);
    session.markHandedOff();
    const result = await startPromise;
    const providerSettledAt = performance.now();
    logInfo("[VoiceInput] Start timing — provider settled", {
      sessionId: session.id,
      ok: result.ok,
      providerStartMs: Math.round(providerSettledAt - providerStartAt),
      elapsedMs: Math.round(providerSettledAt - startedAt),
    });
    if (!result.ok) return { status: "failed", error: result.error };
    return isLive(session) ? { status: "started" } : SUPERSEDED;
  };

  // Only the view that started a session can stop, flush or feed it.
  const ownedBy = (session: VoiceSession | null, sessionId: unknown, webContentsId: number) =>
    session !== null && session.id === sessionId && session.webContentsId === webContentsId;

  const handleStop = async (
    ctx: IpcContext,
    sessionId: string
  ): Promise<{ rawText: string | null }> => {
    // The live session, or a replaced one still draining, whose owner waits on
    // that drain. Another view's session, or one that has already ended, isn't.
    const session = [liveSession, drainingSession].find((s) =>
      ownedBy(s, sessionId, ctx.webContentsId)
    );
    if (!session) return { rawText: null };
    if (session.stopPromise) return session.stopPromise;
    // Still preparing, with nothing held: ending it makes the start bail at its
    // next check instead of bringing the session up and opening a socket.
    if (session.phase === "starting" && !session.preStartAudio?.chunks.length) {
      endSession(session, "cancelled");
      return { rawText: null };
    }
    return drainSession(session, "stopped");
  };

  const handleGetLiveSession = (ctx: IpcContext): VoiceLiveSessionUpdate =>
    liveSessionUpdateFor(ctx.webContentsId);

  // Another view's dictation key.
  const handleStopLive = (sessionId: string): boolean => requestLiveSessionStop(sessionId);

  // Another view's indicator. The owner's own window brings it forward: a
  // switch asked from any other window would release the owner's cached view
  // to open its workspace there, ending the session it was meant to show.
  const handleRevealLive = (sessionId: string): boolean => {
    const session = liveSession;
    if (!session || session.id !== sessionId || session.ended) return false;
    if (session.sender.isDestroyed()) return false;
    const reveal = { sessionId, workspaceId: session.projectId };
    const win = getWindowForWebContents(session.sender);
    if (win && !win.isDestroyed()) {
      // The view on screen there switches to the owner's workspace.
      const shown = getAppWebContents(win);
      if (shown.id !== session.webContentsId && !shown.isDestroyed()) {
        shown.send(CHANNELS.VOICE_INPUT_REVEAL_REQUESTED, reveal);
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    // The owner focuses the panel it is dictating into.
    session.sender.send(CHANNELS.VOICE_INPUT_REVEAL_REQUESTED, reveal);
    return true;
  };

  // Escape's cancel (#14631): the session ends now, without draining, so
  // nothing it still had in flight reaches the renderer and its file-link work
  // is aborted with it. A session being drained for another view's start is
  // left to that drain, which the newer session is waiting on.
  const handleCancel = (ctx: IpcContext, sessionId: string): void => {
    const session = liveSession;
    if (!session || !ownedBy(session, sessionId, ctx.webContentsId)) return;
    const ownsProvider = session.phase !== "starting";
    endSession(session, "cancelled");
    if (ownsProvider) service?.stop();
  };

  const handleFlushParagraph = (ctx: IpcContext, sessionId: string): { rawText: string | null } => {
    const session = liveSession;
    // Until the session is active, the service's provider belongs to no one.
    if (ownedBy(session, sessionId, ctx.webContentsId) && session?.phase !== "starting") {
      service?.commitParagraphBoundary();
    }
    return { rawText: null };
  };

  const handleAudioChunk = (
    event: Electron.IpcMainEvent,
    sessionId: unknown,
    chunk: ArrayBuffer
  ) => {
    const session = liveSession;
    // Audio for a session that isn't live — another view's, or one that has
    // already ended — must never reach the provider or the held buffer.
    if (!session || !ownedBy(session, sessionId, event.sender.id)) return;
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
      session.stats.droppedPreStart++;
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
  // stops, with the full dictated text; correction runs as a single gpt-6-luna
  // request rather than the old per-segment streaming pipeline.
  const handleCorrect = async (
    ctx: IpcContext,
    request: VoiceInputCorrectPayload
  ): Promise<{ action: "no_change" | "replace"; correctedText: string; failed?: true }> => {
    const settings = getVoiceSettings();
    if (!settings.correctionEnabled || !settings.openaiApiKey || !request.rawText.trim()) {
      return { action: "no_change", correctedText: request.rawText };
    }

    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }

    const projectInfo = getProjectInfo(ctx.projectId);
    const vocabulary = await readVocabulary(
      resolveVocabularyProject(ctx.projectId, request.terminalId, deps.ptyClient)
    );
    const result = await correctionService.correct(
      {
        rawText: request.rawText,
        recentContext: request.recentContext,
        reason: "stop",
      },
      {
        model: settings.correctionModel,
        apiKey: settings.openaiApiKey,
        customDictionary: dictionaryTerms(sessionDictionary(settings.dictionary, vocabulary)),
        knownNames:
          lastSessionNames?.webContentsId === ctx.webContentsId ? lastSessionNames.names : [],
        // Global rules only, matching the live rewriter. Project heard-as forms
        // belong in both places, through sessionDictionary.
        heardAs: collectHeardAsRules(settings.dictionary),
        customInstructions: settings.correctionCustomInstructions,
        language: normalizeVoiceLanguage(settings.language),
        projectName: projectInfo.name,
        projectPath: projectInfo.path,
        organizationId: settings.organizationId,
        projectId: settings.projectId,
      }
    );

    return {
      action: result.action,
      correctedText: result.confirmedText,
      ...(result.failed ? { failed: true as const } : {}),
    };
  };

  // A spoken instruction applied to selected composer text. It runs whatever
  // the cleanup toggle says, since it is something the user asked for.
  const handleRewrite = async (
    ctx: IpcContext,
    request: VoiceInputRewritePayload
  ): Promise<VoiceRewriteOutcome> => {
    const settings = getVoiceSettings();
    if (!settings.openaiApiKey) return { status: "unavailable" };
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }
    const projectInfo = getProjectInfo(ctx.projectId);
    return correctionService.rewrite(request, {
      model: settings.correctionModel,
      apiKey: settings.openaiApiKey,
      customDictionary: dictionaryTerms(settings.dictionary),
      language: normalizeVoiceLanguage(settings.language),
      projectName: projectInfo.name,
      projectPath: projectInfo.path,
      organizationId: settings.organizationId,
      projectId: settings.projectId,
    });
  };

  const handleGetLastTerms = async (): Promise<LastDictationTerms | null> => lastDictationTerms;

  const sessionNamespace = defineIpcNamespace({
    name: "voiceInput",
    ops: {
      start: op(VOICE_INPUT_METHOD_CHANNELS.start, handleStart, { withContext: true }),
      stop: opValidated(VOICE_INPUT_METHOD_CHANNELS.stop, VoiceSessionIdSchema, handleStop, {
        withContext: true,
      }),
      cancel: opValidated(VOICE_INPUT_METHOD_CHANNELS.cancel, VoiceSessionIdSchema, handleCancel, {
        withContext: true,
      }),
      flushParagraph: opValidated(
        VOICE_INPUT_METHOD_CHANNELS.flushParagraph,
        VoiceSessionIdSchema,
        handleFlushParagraph,
        { withContext: true }
      ),
      getLiveSession: op(VOICE_INPUT_METHOD_CHANNELS.getLiveSession, handleGetLiveSession, {
        withContext: true,
      }),
      stopLive: opValidated(
        VOICE_INPUT_METHOD_CHANNELS.stopLive,
        VoiceSessionIdSchema,
        handleStopLive
      ),
      revealLive: opValidated(
        VOICE_INPUT_METHOD_CHANNELS.revealLive,
        VoiceSessionIdSchema,
        handleRevealLive
      ),
      rewrite: opValidated(
        VOICE_INPUT_METHOD_CHANNELS.rewrite,
        VoiceInputRewritePayloadSchema,
        handleRewrite,
        { withContext: true }
      ),
      getLastTerms: op(VOICE_INPUT_METHOD_CHANNELS.getLastTerms, handleGetLastTerms),
    },
  });

  const cleanups: Array<() => void> = [
    sessionNamespace.register(),
    registerPageDictationKey(claimDictationKey),
    typedHandle(CHANNELS.VOICE_INPUT_GET_SETTINGS, handleGetSettings),
    typedHandle(CHANNELS.VOICE_INPUT_SET_SETTINGS, handleSetSettings),
    typedHandle(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION, handleCheckMicPermission),
    typedHandle(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION, handleRequestMicPermission),
    typedHandle(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS, handleOpenMicSettings),
    typedHandle(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, handleValidateApiKey),
    typedHandleWithContextValidated(
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
    if (drainingSession) endSession(drainingSession, "cancelled");
    drainingSession = null;
    service?.destroy();
    service = null;
    servicePromise = null;
    correctionService = null;
    sessionController = null;
    lastDictationTerms = null;
    lastTermSources = new Map();
  };
}
