// eager-import-allow: reads voice-input settings via store.get synchronously in the IPC handler
import { randomUUID } from "node:crypto";
import { ipcMain, systemPreferences } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type {
  VoiceSessionEvent,
  VoiceTranscriptionService,
} from "../../services/VoiceTranscriptionService.js";
import {
  VoiceCorrectionService,
  type VoiceCorrectionSettings,
} from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
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
import type {
  VoiceCorrectionTiming,
  VoiceSessionReport,
} from "../../../shared/types/voiceSessionSummary.js";
import { logDebug, logInfo, logWarn } from "../../utils/logger.js";
import { buildOpenAIHeaders } from "../../../shared/utils/openaiHeaders.js";
import { voiceErrorLogFields } from "../../../shared/utils/voiceLogFields.js";
import {
  UtteranceCommands,
  type UtteranceEmission,
  type UtteranceRelease,
} from "../../services/voiceUtteranceCommands.js";
import { VOICE_DICTATION_AI_MODEL } from "../../../shared/config/voiceCorrection.js";
import { normalizeVoiceLanguage } from "../../../shared/config/voiceLanguages.js";
import {
  assembleTaggedKeyterms,
  NO_PANE_KEYTERM_READS,
  screenDictationNames,
} from "../../services/voiceContextKeyterms.js";
import { readTerminalOutputForCorrection } from "../../services/voiceTerminalContext.js";
import {
  flattenDictationNames,
  gatherDictationNames,
  NO_DICTATION_NAMES,
  type DictationNames,
} from "../../services/voiceContextNames.js";
import {
  getProjectInfo,
  readVocabulary,
  resolveFileLinkCwd,
  resolveKeytermTarget,
  resolveVocabularyProject,
  type PaneCorrectionContext,
  type PaneProjectInfo,
  type PaneStartContext,
} from "../../services/voice/paneContext.js";
import {
  findHostPaneFileCandidates,
  hostPaneOf,
  readHostPaneCorrection,
  readHostPaneProject,
  readHostPaneStart,
  type HostPane,
} from "../../services/voice/hostPaneContext.js";
import { collectHeardAsRules, createHeardAsRewriter } from "../../../shared/utils/voiceHeardAs.js";
import {
  carrySpansThroughEdits,
  shiftSpans,
  sliceSpans,
  splitSpansByLine,
  type VoiceTextEdit,
  type VoiceTextSpan,
} from "../../../shared/utils/voiceUncertainWords.js";
import {
  readVoiceCommandAgent,
  resolveVoiceCommandTarget,
  type VoiceCommandTarget,
} from "../../services/voiceCommandTarget.js";
import {
  planSpokenCommand,
  voiceCommandKeyterms,
} from "../../../shared/utils/voiceAgentCommands.js";
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
import { holdDictationView } from "../../services/voice/dictationViewHold.js";
import { LOCAL_HOST_ID, parseHostScopedKey } from "../../../shared/types/remoteHosts.js";
import {
  getAllAppWebContents,
  getAppWebContents,
  getWindowForWebContents,
} from "../../window/webContentsRegistry.js";

let service: VoiceTranscriptionService | null = null;
let servicePromise: Promise<VoiceTranscriptionService> | null = null;
let correctionService: VoiceCorrectionService | null = null;

// A completion ending in a spoken "send it", waiting to see whether the
// speaker stays quiet. It goes out as a send, as literal words when the
// speaker went on, or stripped with no send when dictation stopped first.
type HeldSendOutcome = "send" | "literal" | "strip";
interface HeldSend {
  timer: ReturnType<typeof setTimeout>;
  readonly release: (outcome: HeldSendOutcome) => void;
}

// Finding the target's agent and commands shares the keyterm reads' budget at
// start, so leading speech isn't held up. Correction already waits on a model
// call, so it can afford a cold discovery scan.
const COMMAND_TARGET_START_BUDGET_MS = 500;
const COMMAND_TARGET_CORRECTION_BUDGET_MS = 1500;
const COMMAND_KEYTERM_LIMIT = 12;
// How often a running dictation checks its cleanup prompt is still cached.
// The service skips one that went out in the last few minutes.
const CORRECTION_WARM_CHECK_MS = 60_000;
// Recent sessions whose cleanup context stays at hand for the passages their
// renderer sends after the stop.
const CORRECTION_PREP_MEMORY = 4;
// A rewrite reads its project's name here at once; from a host it waits this
// long at most, and goes without.
const HOST_PROJECT_READ_BUDGET_MS = 500;
// The renderer asks for a stopped dictation's cleanup as soon as the stop
// resolves; its view stays held this long for the request to arrive.
const CLEANUP_HANDOFF_MS = 5_000;
// A cleanup request's hold outlasts the longest correction the service waits
// for, so it only ever lapses on a request that never settled.
const CLEANUP_REQUEST_HOLD_MS = 90_000;

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
  // What the starting view calls its workspace, for every other view to name
  // it by: a host's project or scratch has no name on this machine.
  readonly workspaceName: string | null;
  // Dictated into a terminal outside this view (another host's or project's):
  // nothing of the view's own project belongs in the text.
  readonly outsideView: boolean;
  /** The terminal being dictated into, as the renderer named it at start. */
  readonly terminalId: string | undefined;
  /** "rewrite" records an instruction for selected text, forwarded as spoken. */
  readonly intent: "dictation" | "rewrite";
  // The agent the terminal runs and its commands, fixed as the keyterms are:
  // before the provider transcribes anything. Null when the terminal runs no
  // agent with commands.
  commandTarget: VoiceCommandTarget | null;
  // starting: main is still preparing, and the provider isn't this session's.
  // active: its provider has been started (it may still be connecting).
  // stopping: a stop owns its graceful drain.
  phase: "starting" | "active" | "stopping";
  ended: boolean;
  stopPromise: Promise<{ rawText: string | null }> | null;
  readonly controller: AbortController;
  unsubscribe: (() => void) | null;
  unwatchDestroyed: (() => void) | null;
  // Keeps its view out of eviction while it runs (#14773).
  releaseView: (() => void) | null;
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
  // Segments of the utterance whose spoken commands still depend on what
  // comes next (#14801), and how a stop or a lost provider lets them go
  // through the session's own emitter.
  readonly utterance: UtteranceCommands;
  flushUtterance: ((mode: "stop" | "literal") => void) | null;
  // Rechecks that the cleanup prompt is cached while the session runs.
  warmTimer: ReturnType<typeof setInterval> | null;
  // Its cleanup context, when cleanup was on at its start.
  correctionPrep: CorrectionPrep | null;
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

/**
 * Where a session's view runs: the host its workspace is on and the workspace
 * as that host knows it, never the view key, which only this machine reads.
 */
function workspaceOf(session: VoiceSession): { hostId: string; workspaceId: string | null } {
  if (!session.projectId) return { hostId: LOCAL_HOST_ID, workspaceId: null };
  const { hostId, projectId } = parseHostScopedKey(session.projectId);
  return { hostId, workspaceId: projectId };
}

/** The live session as one view sees it: none when that view owns it. */
function liveSessionUpdateFor(webContentsId: number): VoiceLiveSessionUpdate {
  const session = liveSession;
  if (!session || session.ended || session.webContentsId === webContentsId) {
    return { revision: liveSessionRevision, session: null };
  }
  const { hostId, workspaceId } = workspaceOf(session);
  return {
    revision: liveSessionRevision,
    session: {
      sessionId: session.id,
      hostId,
      projectId: workspaceId,
      projectName: session.projectInfo.name ?? session.workspaceName,
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
  session.utterance.clear();
  session.flushUtterance = null;
  if (session.warmTimer) clearInterval(session.warmTimer);
  session.warmTimer = null;
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
  // A stop's cleanup still writes into the view's draft, so the view is handed
  // to a short hold for the request to arrive. Taken before the session's own
  // goes, so no eviction finds the view free in between.
  if (reason === "stopped" && !session.sender.isDestroyed()) {
    holdCleanupHandoff(session.webContentsId);
  }
  session.releaseView?.();
  session.releaseView = null;
  // Abort any in-flight file-link detection / resolution.
  session.controller.abort();
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

/** What one passage's cleanup came back as. */
interface CorrectReply {
  action: "no_change" | "replace";
  correctedText: string;
  failed?: true;
  timing?: VoiceCorrectionTiming;
}

// Handoff holds still running, ended early when the handlers go away.
const cleanupHandoffs = new Set<() => void>();

function holdCleanupHandoff(webContentsId: number): void {
  const release = holdDictationView(webContentsId);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (timer) clearTimeout(timer);
    cleanupHandoffs.delete(end);
    release();
  };
  timer = setTimeout(end, CLEANUP_HANDOFF_MS);
  timer.unref?.();
  cleanupHandoffs.add(end);
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

function projectInfoOf(project: PaneProjectInfo | null | undefined): {
  name?: string;
  path?: string;
} {
  return {
    ...(project?.name ? { name: project.name } : {}),
    ...(project?.path ? { path: project.path } : {}),
  };
}

// The host pane a dictation reads its context from. One typed to a terminal
// outside the view is no pane of the view's host, so it reads none there.
function hostPaneFor(viewProjectKey: string | null, outsideView: boolean): HostPane | null {
  return outsideView ? null : hostPaneOf(viewProjectKey);
}

// The names each recent dictation sent, so its cleanup spells them the same
// way, whatever has started since. Kept whether or not cleanup was on at its
// start, as many as the cleanup context keeps.
interface SessionNames {
  readonly sessionId: string;
  readonly webContentsId: number;
  names: string[];
}

let recentSessionNames: SessionNames[] = [];

function findSessionNames(
  ctx: IpcContext,
  request: VoiceInputCorrectPayload
): SessionNames | undefined {
  if (!request.sessionId) return undefined;
  return recentSessionNames.find(
    (record) => record.sessionId === request.sessionId && record.webContentsId === ctx.webContentsId
  );
}

// A dictation's cleanup context, read while it runs (#14771), so the passages
// sent after the stop go straight to the model. Kept only for a session that
// may be cleaned up, and used only by passages that name it. Like the
// keyterms, it is the vocabulary and commands as they were at the start.
// A host's pane is read on the host, as the keyterms are.
interface CorrectionPrep {
  readonly sessionId: string;
  readonly webContentsId: number;
  readonly projectId: string | null;
  readonly terminalId: string | undefined;
  // Read for a terminal outside the view: none of the view's project or names.
  readonly outsideView: boolean;
  readonly projectInfo: Promise<{ name?: string; path?: string }>;
  readonly vocabulary: Promise<VoiceDictionaryEntry[]>;
  readonly commandTarget: Promise<VoiceCommandTarget | null>;
  // What the terminal showed as the stop landed, read while the stop drains.
  // Read only then: it goes to OpenAI with the passages and nothing earlier.
  terminalOutput: Promise<string | null> | null;
  // A host's pane as the stop landed: the host answers with its terminal's
  // output and the commands it takes by then in one read.
  hostStop: Promise<PaneCorrectionContext | null> | null;
}

let correctionPreps: CorrectionPrep[] = [];

function readHostStop(prep: CorrectionPrep, pane: HostPane): Promise<PaneCorrectionContext | null> {
  prep.hostStop ??= readHostPaneCorrection(pane, prep.terminalId, {
    timeoutMs: COMMAND_TARGET_CORRECTION_BUDGET_MS,
  });
  return prep.hostStop;
}

function findCorrectionPrep(
  ctx: IpcContext,
  request: VoiceInputCorrectPayload
): CorrectionPrep | undefined {
  if (!request.sessionId) return undefined;
  return correctionPreps.find(
    (prep) =>
      prep.sessionId === request.sessionId &&
      prep.webContentsId === ctx.webContentsId &&
      prep.projectId === ctx.projectId &&
      prep.terminalId === request.terminalId &&
      prep.outsideView === (request.outsideView === true)
  );
}

// What the cleanup prompt is built from. The warm-up and the passage both
// come through here, so the prompt cached ahead is the one the passage sends.
function correctionSettingsFor(
  settings: VoiceInputSettings,
  projectInfo: { name?: string; path?: string },
  vocabulary: VoiceDictionaryEntry[],
  commandTarget: VoiceCommandTarget | null,
  knownNames: string[]
): VoiceCorrectionSettings {
  return {
    model: settings.correctionModel,
    apiKey: settings.openaiApiKey,
    customDictionary: dictionaryTerms(sessionDictionary(settings.dictionary, vocabulary)),
    knownNames,
    // Global rules only, matching the live rewriter. Project heard-as forms
    // belong in both places, through sessionDictionary.
    heardAs: collectHeardAsRules(settings.dictionary),
    customInstructions: settings.correctionCustomInstructions,
    language: normalizeVoiceLanguage(settings.language),
    projectName: projectInfo.name,
    projectPath: projectInfo.path,
    organizationId: settings.organizationId,
    projectId: settings.projectId,
    ...(commandTarget ? { commandTarget } : {}),
  };
}

function mayCorrect(settings: VoiceInputSettings): boolean {
  return settings.correctionEnabled && Boolean(settings.openaiApiKey);
}

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
    let paths: Array<string | null>;
    const hostPane = hostPaneFor(session.projectId, session.outsideView);
    if (hostPane) {
      // The host searches its own files; which one was meant is chosen here,
      // with this machine's credentials.
      const candidates = await findHostPaneFileCandidates(
        hostPane,
        session.terminalId,
        descriptions,
        { timeoutMs: FILE_LINK_JOB_TIMEOUT_MS, signal }
      );
      if (!candidates || signal.aborted) return;
      paths = await Promise.all(
        descriptions.map((description, i) =>
          voiceFileLinkResolver.pick({
            description,
            candidates: candidates[i] ?? [],
            ...credentials,
            signal,
          })
        )
      );
    } else {
      const cwd = session.outsideView
        ? null
        : await resolveFileLinkCwd(
            session.projectId,
            session.terminalId,
            session.projectInfo.path ?? null,
            deps.ptyClient
          );
      if (!cwd || signal.aborted) return;
      paths = await Promise.all(
        descriptions.map((description) =>
          voiceFileLinkResolver.resolve({ cwd, description, ...credentials, signal })
        )
      );
    }
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

  // What a prepared session's terminal shows now. The output follows the
  // keyterms' ownership rule: none for a terminal another project owns. A
  // host's pane is read on the host.
  const readStopOutput = (prep: CorrectionPrep): Promise<string | null> => {
    const hostPane = hostPaneFor(prep.projectId, prep.outsideView);
    if (hostPane) {
      return readHostStop(prep, hostPane).then((read) => read?.terminalOutput ?? null);
    }
    const target = resolveKeytermTarget(prep.projectId, prep.terminalId, deps.ptyClient);
    return readTerminalOutputForCorrection(deps.ptyClient, target.terminalId);
  };

  // Drains the provider a session owns, keeping its subscription up so the
  // remaining text reaches its owner, then ends it.
  const drainSession = (
    session: VoiceSession,
    reason: "stopped" | "superseded"
  ): Promise<{ rawText: string | null }> => {
    // The renderer cleans up what was dictated once this resolves, so its
    // socket and the terminal's output are got ready while the drain runs.
    const readyCorrection = (): boolean => {
      if (reason !== "stopped" || session.intent !== "dictation" || session.ended) return false;
      if (!mayCorrect(getVoiceSettings())) return false;
      correctionService ??= new VoiceCorrectionService();
      correctionService.preconnect();
      return true;
    };
    const prep = session.correctionPrep;
    if (readyCorrection() && prep && !prep.terminalOutput) {
      prep.terminalOutput = readStopOutput(prep);
    }
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
        session.flushUtterance?.("literal");
        endSession(session, "failed");
        throw error;
      }
      // Stopping ends what was said: whatever the drain left waiting on more
      // speech lands now, ahead of its file links.
      session.flushUtterance?.("stop");
      // The drain can finish the final utterance, whose references only start
      // resolving then. Each job is bounded, and ending the session another
      // way aborts them.
      await Promise.allSettled(session.fileLinkJobs);
      // A drain long enough to outlast the first probe's socket opens another.
      readyCorrection();
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
      // A host's project is resolved on the host.
      projectInfo: hostPaneOf(ctx.projectId) ? {} : getProjectInfo(ctx.projectId),
      workspaceName: options?.workspaceName ?? null,
      outsideView: options?.outsideView === true,
      terminalId: options?.terminalId,
      intent: options?.intent ?? "dictation",
      commandTarget: null,
      phase: "starting",
      ended: false,
      stopPromise: null,
      controller: new AbortController(),
      unsubscribe: null,
      unwatchDestroyed: null,
      // Taken before the first await, so no eviction can take the view
      // between the start and the session being live (#14773).
      releaseView: holdDictationView(ctx.webContentsId),
      preStartAudio: { chunks: [], bytes: 0, overflowed: false },
      overflowReported: false,
      handedOff,
      markHandedOff,
      fileLinkJobs: new Set(),
      heldSend: null,
      utterance: new UtteranceCommands(),
      flushUtterance: null,
      warmTimer: null,
      correctionPrep: null,
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

  // Reads the cleanup context alongside the keyterms, and keeps the cleanup
  // prompt cached for as long as the dictation runs, so neither waits for the
  // stop. The command lookup gets the correction's budget; its discovery scan
  // is the one the keyterms' lookup already started. A host's pane takes its
  // commands from the host's start answer, and its project from the host.
  const prepareCorrection = (
    session: VoiceSession,
    terminalId: string | undefined,
    vocabulary: Promise<VoiceDictionaryEntry[]>,
    hostStart: Promise<PaneStartContext | null> | null,
    screenedNames: Promise<string[]>
  ) => {
    const hostPane = hostPaneFor(session.projectId, session.outsideView);
    const prep: CorrectionPrep = {
      sessionId: session.id,
      webContentsId: session.webContentsId,
      projectId: session.projectId,
      terminalId,
      outsideView: session.outsideView,
      projectInfo: session.outsideView
        ? Promise.resolve({})
        : hostPane
          ? readHostPaneProject(hostPane, { timeoutMs: COMMAND_TARGET_CORRECTION_BUDGET_MS }).then(
              projectInfoOf
            )
          : Promise.resolve(session.projectInfo),
      vocabulary,
      commandTarget: hostStart
        ? hostStart.then((read) => read?.commandTarget ?? null)
        : resolveVoiceCommandTarget(
            deps.ptyClient,
            resolveKeytermTarget(session.projectId, terminalId, deps.ptyClient).terminalId,
            COMMAND_TARGET_CORRECTION_BUDGET_MS
          ),
      terminalOutput: null,
      hostStop: null,
    };
    session.correctionPrep = prep;
    correctionPreps = [prep, ...correctionPreps].slice(0, CORRECTION_PREP_MEMORY);
    const warm = async () => {
      const [projectInfo, entries, commandTarget, knownNames] = await Promise.all([
        prep.projectInfo,
        prep.vocabulary,
        prep.commandTarget,
        screenedNames,
      ]);
      // Read at every attempt, as each passage reads them: cleanup turned off
      // or the key removed since the start sends nothing.
      const settings = getVoiceSettings();
      if (session.ended || !mayCorrect(settings)) return;
      correctionService ??= new VoiceCorrectionService();
      await correctionService.warm(
        correctionSettingsFor(
          settings,
          projectInfo,
          entries,
          commandTarget,
          prep.outsideView ? [] : knownNames
        )
      );
    };
    const attempt = () => {
      void warm().catch((error: unknown) => {
        logDebug("[VoiceInput] Cleanup warm-up failed", voiceErrorLogFields(error));
      });
    };
    attempt();
    session.warmTimer = setInterval(attempt, CORRECTION_WARM_CHECK_MS);
    session.warmTimer.unref?.();
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
    // A host's pane is read on the host, within the same budget as the reads
    // here, and nothing about it is read on this machine. A host that answers
    // late, or not at all, leaves the dictation without the pane's context
    // rather than holding it up.
    const hostPane = hostPaneFor(session.projectId, session.outsideView);
    const hostContext = hostPane
      ? readHostPaneStart(hostPane, terminalId, {
          timeoutMs: COMMAND_TARGET_START_BUDGET_MS,
          signal: session.controller.signal,
        })
      : null;
    const keytermTarget: ReturnType<typeof resolveKeytermTarget> = hostContext
      ? {}
      : resolveKeytermTarget(session.projectId, terminalId, deps.ptyClient);
    const vocabulary = hostContext
      ? hostContext.then((read) => read?.vocabulary ?? [])
      : readVocabulary(
          session.outsideView
            ? null
            : resolveVocabularyProject(session.projectId, terminalId, deps.ptyClient)
        );
    const projectDictionary = vocabulary.then(dictionaryTerms);
    const names: Promise<DictationNames> = hostContext
      ? hostContext.then((read) => read?.names ?? NO_DICTATION_NAMES)
      : gatherDictationNames({
          projectId: session.projectId,
          terminalId,
          ptyClient: deps.ptyClient,
          worktreeService: deps.worktreeService,
        });
    // The correction gets the same screened names as the keyterms, whenever
    // they arrive. Its own record, so a slow read from an older session can't
    // overwrite this one's.
    const sessionNames: SessionNames = {
      sessionId: session.id,
      webContentsId: session.webContentsId,
      names: [],
    };
    if (session.intent === "dictation") {
      recentSessionNames = [sessionNames, ...recentSessionNames].slice(0, CORRECTION_PREP_MEMORY);
    }
    const screenedNames = names.then((gathered) =>
      flattenDictationNames(screenDictationNames(gathered))
    );
    void screenedNames.then((screened) => {
      sessionNames.names = screened;
    });
    if (session.intent === "dictation" && mayCorrect(settings)) {
      prepareCorrection(session, terminalId, vocabulary, hostContext, screenedNames);
    }
    // Bounded by the same budget as the other reads, and resolved alongside them.
    // The keyterms wait on it, so it is in place before either provider can
    // transcribe a word, without holding up the provider start.
    const commandTargetPromise = (
      hostContext
        ? hostContext.then((read) => read?.commandTarget ?? null)
        : resolveVoiceCommandTarget(
            deps.ptyClient,
            keytermTarget.terminalId,
            COMMAND_TARGET_START_BUDGET_MS
          )
    ).then((target) => {
      session.commandTarget = target;
      return target;
    });
    const customDictionary = dictionaryTerms(settings.dictionary);
    const commandTerms = commandTargetPromise.then((target) =>
      target ? voiceCommandKeyterms(target.vocabulary, COMMAND_KEYTERM_LIMIT) : []
    );
    const keytermsPromise = (
      hostContext
        ? hostContext.then((read) =>
            assembleTaggedKeyterms({
              customDictionary,
              projectDictionary,
              projectName: read?.projectName ?? undefined,
              names,
              commandTerms,
              paneReads: read?.keyterms ?? NO_PANE_KEYTERM_READS,
            })
          )
        : assembleTaggedKeyterms({
            customDictionary,
            projectDictionary,
            ...keytermTarget,
            ptyClient: deps.ptyClient,
            names,
            commandTerms,
          })
    ).catch((err: unknown): VoiceSentTerm[] => {
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

    // Break commands and "send it" were read over the whole utterance, so
    // each completion arrives with its text as it lands (#14801), and
    // `uncertain` spans the words in it the provider was unsure of. They
    // follow the text through every rewrite below by position, and one a
    // rewrite reached is dropped.
    const emitCompletion = (
      itemId: string | undefined,
      processedText: string,
      processedUncertain: readonly VoiceTextSpan[],
      { send, opensUtterance }: { send: boolean; opensUtterance: boolean }
    ) => {
      const target = session.sender;
      if (target.isDestroyed()) return;
      const sessionId = session.id;
      const liveSettings = getVoiceSettings();

      // Split on line breaks and emit one complete event per non-empty part
      // with a paragraph_boundary between each pair of pieces. Empty pieces
      // still get their boundary, so a break at the start or end of an
      // utterance ("fix the bug new line") survives for the next utterance.
      const pieces = processedText.split(/\s*\n\s*/).map((p) => p.trim());
      // A spoken command ("slash review…") opening the utterance, written as
      // the composer would. The renderer uses it only when the utterance
      // starts the prompt; a later piece or completion never opens one. A
      // trailing "send it" is already off the text, so "slash compact send it"
      // opens with the command and still sends.
      const command =
        opensUtterance && session.commandTarget && pieces[0]
          ? planSpokenCommand(pieces[0], session.commandTarget.vocabulary)
          : null;
      const commandText = command?.text ?? null;
      const heardUncertain = splitSpansByLine(processedText, processedUncertain);
      // Only the arguments are copied into the command; the words its name
      // replaced take their flags with them.
      const commandUncertain = command
        ? shiftSpans(
            sliceSpans(heardUncertain[0] ?? [], command.argsFrom, pieces[0]!.length),
            command.argsAt
          )
        : [];
      const parts = pieces.filter(Boolean);
      // Heard-as rules run after the commands, the opening one above
      // included, so a rule never eats a break, a send or a command's name and
      // a term it writes is never taken for one, and over the
      // whole text, so a code fence spanning lines still protects what's
      // inside. Rules never cross or write a line break, so the pieces line up.
      const heardAsEdits: VoiceTextEdit[] = [];
      const writtenText = rewriteHeardAs(processedText, undefined, heardAsEdits);
      const written = writtenText.split(/\s*\n\s*/).map((p) => p.trim());
      const writtenUncertain = splitSpansByLine(
        writtenText,
        carrySpansThroughEdits(processedUncertain, heardAsEdits)
      );
      // Lengths only — dictated text is user content, kept out of logs.
      logDebug("[VoiceInput] complete event → renderer", {
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
        !session.outsideView &&
        liveSettings.openaiApiKey &&
        mayReferenceFile(writtenText)
          ? randomUUID()
          : undefined;
      if (parts.length === 0 && itemId && !send) {
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
          const textUncertain =
            (written[i] !== undefined ? writtenUncertain[i] : heardUncertain[i]) ?? [];
          const pieceUncertain = heardUncertain[i] ?? [];
          target.send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
            sessionId,
            text,
            willCorrect: false,
            ...(text !== pieces[i]
              ? {
                  heard: pieces[i],
                  ...(pieceUncertain.length > 0 ? { heardUncertain: pieceUncertain } : {}),
                }
              : {}),
            ...(textUncertain.length > 0 ? { uncertain: textUncertain } : {}),
            ...itemIdField,
            ...(transcriptId ? { transcriptId } : {}),
            ...(i === 0 && commandText && commandText !== pieces[i]
              ? {
                  commandText,
                  ...(commandUncertain.length > 0 ? { commandUncertain } : {}),
                }
              : {}),
            ...(send && i === lastIndex ? { send: true } : {}),
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
      if (send && !pieces[lastIndex]) {
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

    const emitRelease = (emissions: readonly UtteranceEmission[], send: boolean) => {
      emissions.forEach((emission, i) =>
        emitCompletion(emission.itemId, emission.text, emission.uncertain, {
          send: send && i === emissions.length - 1,
          opensUtterance: emission.opensUtterance === true,
        })
      );
    };

    const commandOptions = () => ({
      spokenCommands,
      vocabulary: session.commandTarget?.vocabulary ?? null,
    });

    session.flushUtterance = (mode) => {
      const release = session.utterance.flush(mode, commandOptions());
      if (release) emitRelease(release.emissions, false);
    };

    // Until it goes out, the renderer keeps whatever preview the items'
    // interim results gave them.
    const holdSend = (release: UtteranceRelease) => {
      const held: HeldSend = {
        timer: setTimeout(() => releaseHeldSend(session, "send"), sendSettleMs),
        release: (outcome) => {
          if (outcome === "literal" && release.literal) emitRelease(release.literal, false);
          else emitRelease(release.emissions, outcome === "send");
        },
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
        case "complete":
          // An empty segment only closes one; it shows no more speech.
          if (voiceEvent.text.trim()) releaseHeldSend(session, "literal");
          return;
        case "delta":
        case "paragraph_boundary":
          releaseHeldSend(session, "literal");
          return;
        case "error":
          // Ahead of the error itself, which ends the renderer's dictation.
          if (voiceEvent.error.severity === "fatal") releaseHeldSend(session, "strip");
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

    // Runs ahead of forwarding each provider event too: a segment held for
    // its commands lands before a status or boundary that follows it, and the
    // utterance read so far is let go, its clause with it.
    const settleUtterance = (voiceEvent: VoiceSessionEvent) => {
      if (voiceEvent.type === "complete" && voiceEvent.incomplete) {
        // Its words may be missing, so no command is read across it.
        session.flushUtterance?.("literal");
      } else if (voiceEvent.type === "paragraph_boundary") {
        session.flushUtterance?.("literal");
      } else if (voiceEvent.type === "error" && voiceEvent.error.severity === "fatal") {
        session.flushUtterance?.("literal");
      } else if (voiceEvent.type === "status") {
        if (voiceEvent.status === "idle" && session.phase === "stopping") {
          session.flushUtterance?.("stop");
        } else if (
          voiceEvent.status === "idle" ||
          voiceEvent.status === "error" ||
          voiceEvent.status === "reconnecting"
        ) {
          // Whether the speaker went on can't be known across the gap.
          session.flushUtterance?.("literal");
        }
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
        // A bare end of speech names no item, and would commit the live text.
        if (!voiceEvent.itemId && !voiceEvent.text.trim()) return;
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
        const lead = voiceEvent.text.length - voiceEvent.text.trimStart().length;
        const uncertain = sliceSpans(voiceEvent.uncertain ?? [], lead, lead + rawText.length);
        if (voiceEvent.incomplete) {
          // Words around it may be missing, so its own land as said and are
          // never read as a command; what was held went ahead of it as words.
          emitCompletion(voiceEvent.itemId, rawText, uncertain, {
            send: false,
            opensUtterance: false,
          });
          return;
        }
        // A trailing "send it" that ends the utterance is stripped and handed
        // to the renderer, which owns the send; one the speaker went on past
        // stays literal.
        const release = session.utterance.push(
          { ...(voiceEvent.itemId ? { itemId: voiceEvent.itemId } : {}), text: rawText, uncertain },
          {
            endOfSpeech: voiceEvent.endOfSpeech === true,
            endsAtPause: voiceEvent.endsAtPause === true,
          },
          commandOptions()
        );
        if (!release) return;
        if (release.send && sendSettleMs > 0 && session.phase === "active") {
          holdSend(release);
        } else {
          emitRelease(release.emissions, release.send);
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
      settleUtterance(voiceEvent);
      // Counted per provider segment, before the split into paragraph pieces.
      // A bare end of speech closes a segment rather than being one.
      if (voiceEvent.type === "complete") {
        if (voiceEvent.text.trim()) session.stats.completedSegments++;
        else if (voiceEvent.itemId || !voiceEvent.endOfSpeech) session.stats.emptyCompletions++;
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
    // Its transcripts look for spoken file references through it.
    correctionService ??= new VoiceCorrectionService();
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
  // to open its workspace there, ending the session it was meant to show. The
  // view on screen there may be on another host than the owner's, so it is
  // told the host as well as the workspace (#14773).
  const handleRevealLive = (sessionId: string): boolean => {
    const session = liveSession;
    if (!session || session.id !== sessionId || session.ended) return false;
    if (session.sender.isDestroyed()) return false;
    const reveal = { sessionId, ...workspaceOf(session) };
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

  // The commands found at the start, unless the terminal has moved on to
  // another agent or to none: one that exited mid-dictation leaves a shell,
  // which takes no commands. Telling needs no discovery scan. A host's pane
  // takes the commands the host found as the stop landed, or, when it didn't
  // answer, those found at the start.
  const currentCommandTarget = async (prep: CorrectionPrep): Promise<VoiceCommandTarget | null> => {
    const hostPane = hostPaneFor(prep.projectId, prep.outsideView);
    if (hostPane) {
      const [target, read] = await Promise.all([prep.commandTarget, readHostStop(prep, hostPane)]);
      return read ? read.commandTarget : target;
    }
    const { terminalId } = resolveKeytermTarget(prep.projectId, prep.terminalId, deps.ptyClient);
    const [target, agentId] = await Promise.all([
      prep.commandTarget,
      readVoiceCommandAgent(deps.ptyClient, terminalId, COMMAND_TARGET_START_BUDGET_MS),
    ]);
    if (agentId === undefined || agentId === (target?.agentId ?? null)) return target;
    return resolveVoiceCommandTarget(
      deps.ptyClient,
      terminalId,
      COMMAND_TARGET_CORRECTION_BUDGET_MS
    );
  };

  // A passage's cleanup context read when it arrives, all at once so none
  // adds a wait to another's.
  const readCorrectionContext = async (
    viewProjectId: string | null,
    requestedTerminalId: string | undefined,
    outsideView: boolean
  ): Promise<{
    projectInfo: { name?: string; path?: string };
    vocabulary: VoiceDictionaryEntry[];
    commandTarget: VoiceCommandTarget | null;
    terminalOutput: string | null;
  }> => {
    const hostPane = hostPaneFor(viewProjectId, outsideView);
    if (hostPane) {
      // Read on the host within the same budget, as at the start.
      const read = await readHostPaneCorrection(hostPane, requestedTerminalId, {
        timeoutMs: COMMAND_TARGET_CORRECTION_BUDGET_MS,
      });
      return {
        projectInfo: projectInfoOf(read?.project),
        vocabulary: read?.vocabulary ?? [],
        commandTarget: read?.commandTarget ?? null,
        terminalOutput: read?.terminalOutput ?? null,
      };
    }
    // The terminal's output follows the keyterms' ownership rule: terminalId
    // is empty for a terminal another project owns.
    const { terminalId } = resolveKeytermTarget(viewProjectId, requestedTerminalId, deps.ptyClient);
    const [vocabulary, commandTarget, terminalOutput] = await Promise.all([
      readVocabulary(
        outsideView
          ? null
          : resolveVocabularyProject(viewProjectId, requestedTerminalId, deps.ptyClient)
      ),
      resolveVoiceCommandTarget(deps.ptyClient, terminalId, COMMAND_TARGET_CORRECTION_BUDGET_MS),
      readTerminalOutputForCorrection(deps.ptyClient, terminalId),
    ]);
    return {
      projectInfo: outsideView ? {} : getProjectInfo(viewProjectId),
      vocabulary,
      commandTarget,
      terminalOutput,
    };
  };

  // Cleanup requests still out, cancelled when the handlers go.
  const openCorrections = new Set<AbortController>();

  // Whole-passage cleanup pass. The renderer calls this once after recording
  // stops, with the full dictated text; correction runs as a single gpt-6-luna
  // request rather than the old per-segment streaming pipeline.
  const handleCorrect = async (
    ctx: IpcContext,
    request: VoiceInputCorrectPayload
  ): Promise<CorrectReply> => {
    const startedAt = performance.now();
    const settings = getVoiceSettings();
    if (!mayCorrect(settings) || !request.rawText.trim()) {
      return { action: "no_change", correctedText: request.rawText };
    }
    // The answer lands in the asking view's draft, so the view is kept until
    // it has (#14773).
    const releaseView = holdDictationView(ctx.webContentsId, CLEANUP_REQUEST_HOLD_MS);
    try {
      return await correctPassage(ctx, request, settings, startedAt);
    } finally {
      releaseView();
    }
  };

  const correctPassage = async (
    ctx: IpcContext,
    request: VoiceInputCorrectPayload,
    settings: VoiceInputSettings,
    startedAt: number
  ): Promise<CorrectReply> => {

    const svc = (correctionService ??= new VoiceCorrectionService());
    // The request is its passage's alone. Only the view that sent it going
    // away cancels it, since the reply would reach no one: no session starting
    // or ending, the passage's own included, ever does.
    const lifetime = new AbortController();
    openCorrections.add(lifetime);
    const sender = ctx.event?.sender;
    const unwatchSender = sender ? onWebContentsDestroyed(sender, () => lifetime.abort()) : null;
    try {
      const outsideView = request.outsideView === true;
      // Read while the dictation ran, for a passage that names its session. One
      // that doesn't, or a session cleanup was off for at its start, reads now.
      const prep = findCorrectionPrep(ctx, request);
      // Found before any wait, so a session that starts meanwhile can't push
      // this one's names out.
      const names = findSessionNames(ctx, request);
      let projectInfo: { name?: string; path?: string };
      let vocabulary: VoiceDictionaryEntry[];
      let commandTarget: VoiceCommandTarget | null;
      let terminalOutput: string | null;
      if (prep) {
        [projectInfo, vocabulary, commandTarget, terminalOutput] = await Promise.all([
          prep.projectInfo,
          prep.vocabulary,
          currentCommandTarget(prep),
          prep.terminalOutput ?? readStopOutput(prep),
        ]);
      } else {
        ({ projectInfo, vocabulary, commandTarget, terminalOutput } = await readCorrectionContext(
          ctx.projectId,
          request.terminalId,
          outsideView
        ));
      }
      if (lifetime.signal.aborted) {
        return { action: "no_change", correctedText: request.rawText, failed: true };
      }
      const result = await svc.correct(
        {
          rawText: request.rawText,
          recentContext: request.recentContext,
          ...(terminalOutput ? { terminalOutput } : {}),
          reason: "stop",
          startsPrompt: request.startsPrompt === true,
          ...(request.uncertain ? { uncertain: request.uncertain } : {}),
        },
        correctionSettingsFor(
          settings,
          projectInfo,
          vocabulary,
          commandTarget,
          outsideView ? [] : (names?.names ?? [])
        ),
        lifetime.signal
      );
      // Main's share of the wait, for the session summary: up to the request
      // going out, and the round trip, when there was one.
      const sentAt = result.roundTrip?.sentAt ?? performance.now();

      return {
        action: result.action,
        correctedText: result.confirmedText,
        ...(result.failed ? { failed: true as const } : {}),
        timing: {
          prepMs: Math.max(0, sentAt - startedAt),
          requestMs: result.roundTrip ? result.roundTrip.ms : null,
        },
      };
    } finally {
      unwatchSender?.();
      openCorrections.delete(lifetime);
    }
  };

  // A spoken instruction applied to selected composer text. It runs whatever
  // the cleanup toggle says, since it is something the user asked for.
  const handleRewrite = async (
    ctx: IpcContext,
    request: VoiceInputRewritePayload
  ): Promise<VoiceRewriteOutcome> => {
    const settings = getVoiceSettings();
    if (!settings.openaiApiKey) return { status: "unavailable" };
    const releaseView = holdDictationView(ctx.webContentsId, CLEANUP_REQUEST_HOLD_MS);
    try {
      return await rewriteSelection(ctx, request, settings);
    } finally {
      releaseView();
    }
  };

  const rewriteSelection = async (
    ctx: IpcContext,
    request: VoiceInputRewritePayload,
    settings: VoiceInputSettings
  ): Promise<VoiceRewriteOutcome> => {
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }
    const hostPane = hostPaneOf(ctx.projectId);
    const projectInfo = hostPane
      ? projectInfoOf(
          await readHostPaneProject(hostPane, { timeoutMs: HOST_PROJECT_READ_BUDGET_MS })
        )
      : getProjectInfo(ctx.projectId);
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
    for (const end of [...cleanupHandoffs]) end();
    drainingSession = null;
    service?.destroy();
    service = null;
    servicePromise = null;
    correctionService = null;
    for (const lifetime of openCorrections) lifetime.abort();
    openCorrections.clear();
    lastDictationTerms = null;
    lastTermSources = new Map();
    correctionPreps = [];
    recentSessionNames = [];
  };
}
