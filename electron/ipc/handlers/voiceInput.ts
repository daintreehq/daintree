// eager-import-allow: reads voice-input settings via store.get synchronously in the IPC handler
import { ipcMain, systemPreferences } from "electron";
import { spawn } from "child_process";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { VoiceTranscriptionService } from "../../services/VoiceTranscriptionService.js";
import { VoiceCorrectionService } from "../../services/VoiceCorrectionService.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type {
  VoiceInputSettings,
  VoiceTranscriptionProvider,
} from "../../../shared/types/ipc/api.js";
import { logDebug } from "../../utils/logger.js";
import { buildOpenAIHeaders } from "../../../shared/utils/openaiHeaders.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { applyDictationCommands } from "../../services/voiceDictationCommands.js";
import { VOICE_DICTATION_AI_MODEL } from "../../../shared/config/voiceCorrection.js";
import { assembleKeyterms } from "../../services/voiceContextKeyterms.js";
import { getAppWebContents } from "../../window/webContentsRegistry.js";
import { voiceFileLinkResolver } from "../../services/VoiceFileLinkResolver.js";
import { typedHandle, typedHandleValidated, typedHandleWithContext } from "../utils.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import {
  VoiceInputCorrectPayloadSchema,
  type VoiceInputCorrectPayload,
} from "../../schemas/ipc.js";

let service: VoiceTranscriptionService | null = null;
let servicePromise: Promise<VoiceTranscriptionService> | null = null;
let activeEventUnsubscribe: (() => void) | null = null;
let activeDestroyListener: { sender: Electron.WebContents; fn: () => void } | null = null;
let correctionService: VoiceCorrectionService | null = null;
let sessionController: AbortController | null = null;
let sessionProjectInfo: { name?: string; path?: string } = {};
// Bumped on every start so a slow keyterm-assembly await can detect that a
// newer start (or a stop) has superseded it and bail before calling svc.start.
let voiceStartNonce = 0;

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

function openMicSettings(): void {
  const logOpenFailure = (err: unknown) =>
    logDebug("[VoiceInput] Failed to open mic settings", {
      error: (err as Error)?.message ?? String(err),
    });

  if (process.platform === "darwin") {
    void openExternalUrl(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    ).catch(logOpenFailure);
  } else if (process.platform === "win32") {
    void openExternalUrl("ms-settings:privacy-microphone").catch(logOpenFailure);
  } else {
    // Linux: try gnome-control-center, fall back silently. A missing binary
    // surfaces as an async "error" event, not a throw — without this listener it
    // becomes an uncaughtException and takes the app into fatal recovery.
    try {
      const child = spawn("gnome-control-center", ["sound"], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", logOpenFailure);
      child.unref();
    } catch (err) {
      logOpenFailure(err);
    }
  }
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

  const handleStart = async (ctx: IpcContext) => {
    // Bump the start nonce for EVERY start so a later start of any provider
    // (and the stop handler) supersedes a start still awaiting the service
    // import or keyterm assembly. Captured before the first await so a stop
    // landing during the dynamic import still wins.
    const myNonce = ++voiceStartNonce;
    const svc = await getService();
    // Snapshot transcription settings at session start (model, language, API key).
    // Correction settings are read live from store per-event so mid-session changes apply.
    const settings = getVoiceSettings();

    // Clean up any existing subscription before starting a new session
    cleanupActiveSubscription();

    // Initialize the correction service for this session
    if (!correctionService) {
      correctionService = new VoiceCorrectionService();
    }

    sessionController = new AbortController();
    correctionService.setSessionSignal(sessionController.signal);

    // Capture project info at session start.
    sessionProjectInfo = getProjectInfo();

    // Kick off keyterm assembly concurrently with the subscription/provider
    // setup below so leading speech isn't delayed waiting on git/terminal reads.
    // Both providers consume the result: Deepgram via repeated `keyterm=` params,
    // OpenAI via the transcription prompt. The frozen list is awaited just before
    // svc.start() and travels inside the settings snapshot, so both providers'
    // reconnect paths reuse it unchanged. Assembly is capped internally (~500ms)
    // and failures are non-fatal — we just start without keyterms.
    const keytermsPromise = assembleKeyterms({
      customDictionary: settings.customDictionary,
      projectName: sessionProjectInfo.name,
      projectPath: sessionProjectInfo.path,
      ptyClient: deps.ptyClient,
    });

    const unsubscribe = svc.onEvent((voiceEvent) => {
      const win = deps.mainWindow;
      if (!win || win.isDestroyed()) return;

      if (voiceEvent.type === "delta") {
        logDebug("[VoiceInput] → renderer delta", { length: voiceEvent.text.length });
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_DELTA, voiceEvent.text);
      } else if (voiceEvent.type === "complete") {
        const rawText = voiceEvent.text.trim();
        const liveSettings = getVoiceSettings();

        // OpenAI Realtime emits spoken dictation commands ("new paragraph",
        // "period", etc.) as literal text. applyDictationCommands rewrites
        // them post-hoc to \n\n / "." / \n etc., gated on the session-
        // snapshotted paragraphing strategy.
        const processedText =
          settings.paragraphingStrategy === "spoken-command"
            ? applyDictationCommands(rawText)
            : rawText;

        // Split on \n\n and emit one complete event per non-empty part with a
        // paragraph_boundary between them. .filter(Boolean) ensures command-
        // only utterances (e.g. "new paragraph" alone → "\n\n" → ["", ""])
        // emit nothing.
        const parts = processedText
          .split(/\n\n+/)
          .map((p) => p.trim())
          .filter(Boolean);
        // Lengths only — dictated text is user content, kept out of logs.
        logDebug("[VoiceInput] complete event → renderer", {
          rawLength: rawText.length,
          processedLength: processedText.length,
          paragraphingStrategy: settings.paragraphingStrategy,
          partCount: parts.length,
        });
        for (let i = 0; i < parts.length; i++) {
          getAppWebContents(win).send(CHANNELS.VOICE_INPUT_TRANSCRIPTION_COMPLETE, {
            text: parts[i],
            willCorrect: false,
          });
          if (i < parts.length - 1) {
            getAppWebContents(win).send(CHANNELS.VOICE_INPUT_PARAGRAPH_BOUNDARY, {
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
          const projectPath = sessionProjectInfo.path;
          const apiKey = liveSettings.openaiApiKey;
          if (projectPath && apiKey) {
            // Capture signal + service synchronously so a new session's abort
            // and/or replacement service instance can't be used here.
            const signal = sessionController?.signal;
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
                if (signal?.aborted) return;
                const replacement = resolved ? `@${resolved}` : `@?${description}`;
                if (!win.isDestroyed()) {
                  getAppWebContents(win).send(CHANNELS.VOICE_INPUT_FILE_TOKEN_RESOLVED, {
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
          rawText: null,
        });
      } else if (voiceEvent.type === "error") {
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_ERROR, voiceEvent.error);
      } else if (voiceEvent.type === "status") {
        getAppWebContents(win).send(CHANNELS.VOICE_INPUT_STATUS, voiceEvent.status);
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
    ctx.event.sender.once("destroyed", onDestroyed);
    activeDestroyListener = { sender: ctx.event.sender, fn: onDestroyed };

    // Freeze the assembled keyterms into the session settings snapshot. Assembly
    // has its own internal timeouts, so this await is bounded and never blocks the
    // session start indefinitely.
    let keyterms: string[] = [];
    try {
      keyterms = await keytermsPromise;
    } catch (err) {
      logDebug("[VoiceInput] Keyterm assembly failed, starting without keyterms", {
        message: formatErrorMessage(err, "Unknown error during keyterm assembly"),
      });
    }
    // A newer start (or a stop) superseded this one while we awaited assembly
    // (checked on both the success and failure paths) — bail before wiring up a
    // session that's already stale. A superseding start has already run
    // cleanupActiveSubscription() (tearing down THIS start's subscription) and
    // installed its own session controller/subscription, so we must not touch the
    // shared globals here — only idempotently drop our own subscription handles
    // and listener, identity-guarded so we never clobber the live session.
    if (voiceStartNonce !== myNonce) {
      if (activeEventUnsubscribe === unsubscribe) {
        activeEventUnsubscribe = null;
      }
      unsubscribe();
      ctx.event.sender.removeListener("destroyed", onDestroyed);
      if (activeDestroyListener?.fn === onDestroyed) {
        activeDestroyListener = null;
      }
      return { ok: false, error: "Voice session superseded" };
    }
    const result = await svc.start({ ...settings, keyterms });
    if (!result.ok) {
      // Failed to start — clean up subscription immediately
      if (activeEventUnsubscribe === unsubscribe) {
        activeEventUnsubscribe = null;
      }
      unsubscribe();
      ctx.event.sender.removeListener("destroyed", onDestroyed);
      activeDestroyListener = null;
      // Tear down the session controller so an orphaned signal isn't left
      // attached to correctionService for the next session.
      sessionController?.abort();
      correctionService?.setSessionSignal(null);
      sessionController = null;
    }
    return result;
  };

  const handleStop = async (): Promise<{ rawText: string | null }> => {
    // Supersede any start still awaiting keyterm assembly so it bails instead of
    // bringing up a session we're trying to stop.
    voiceStartNonce++;
    // Snapshot the session controller so concurrent start/stop cannot cross-abort.
    const controller = sessionController;

    if (service) {
      // Drain the transcription service first (waits for pending transcriptions,
      // fires remaining complete events).
      await service.stopGracefully();
    }

    // Abort any in-flight file-link detection / resolution.
    controller?.abort();

    if (sessionController === controller) {
      correctionService?.setSessionSignal(null);
      sessionController = null;
    }

    cleanupActiveSubscription();

    return { rawText: null };
  };

  const handleFlushParagraph = (): { rawText: string | null } => {
    if (service) {
      service.commitParagraphBoundary();
    }
    return { rawText: null };
  };

  const handleAudioChunk = (_event: Electron.IpcMainEvent, chunk: ArrayBuffer) => {
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
        projectName: projectInfo.name,
        projectPath: projectInfo.path,
        organizationId: settings.organizationId,
        projectId: settings.projectId,
      }
    );

    return { action: result.action, correctedText: result.confirmedText };
  };

  const cleanups: Array<() => void> = [
    typedHandle(CHANNELS.VOICE_INPUT_GET_SETTINGS, handleGetSettings),
    typedHandle(CHANNELS.VOICE_INPUT_SET_SETTINGS, handleSetSettings),
    // @ts-expect-error: VoiceStartResult contains forbidden envelope key — pending migration to throw AppError. See #6020.
    typedHandleWithContext(CHANNELS.VOICE_INPUT_START, handleStart),
    typedHandle(CHANNELS.VOICE_INPUT_STOP, handleStop),
    typedHandle(CHANNELS.VOICE_INPUT_CHECK_MIC_PERMISSION, handleCheckMicPermission),
    typedHandle(CHANNELS.VOICE_INPUT_REQUEST_MIC_PERMISSION, handleRequestMicPermission),
    typedHandle(CHANNELS.VOICE_INPUT_OPEN_MIC_SETTINGS, handleOpenMicSettings),
    typedHandle(CHANNELS.VOICE_INPUT_VALIDATE_API_KEY, handleValidateApiKey),
    typedHandleValidated(
      CHANNELS.VOICE_INPUT_CORRECT,
      VoiceInputCorrectPayloadSchema,
      handleCorrect
    ),
    typedHandle(CHANNELS.VOICE_INPUT_FLUSH_PARAGRAPH, handleFlushParagraph),
  ];

  // Fire-and-forget audio-chunk stream stays on ipcMain.on.
  ipcMain.on(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, handleAudioChunk);

  return () => {
    for (const cleanup of cleanups) cleanup();
    ipcMain.removeListener(CHANNELS.VOICE_INPUT_AUDIO_CHUNK, handleAudioChunk);
    cleanupActiveSubscription();
    service?.destroy();
    service = null;
    servicePromise = null;
    correctionService = null;
    sessionController = null;
  };
}
