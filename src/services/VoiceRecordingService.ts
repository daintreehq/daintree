import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import { shouldShowHybridInputBar } from "@/components/Terminal/terminalFocus";
import { useHelpPanelStore, selectActiveSlot } from "@/store/helpPanelStore";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useDictationRangeStore } from "@/store/dictationRangeStore";
import {
  isVoiceMicPending,
  useVoiceRecordingStore,
  type VoiceMicNotice,
  type VoiceRecordingTarget,
} from "@/store/voiceRecordingStore";
import { isActiveVoiceSession, type VoiceRecordingMode } from "@shared/types";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";
import { registerEscapeFallback } from "@/lib/escapeStack";
import { keybindingService } from "@/services/KeybindingService";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { voiceErrorLogFields } from "@shared/utils/voiceLogFields";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { notify } from "@/lib/notify";
import type { NotificationAction } from "@/store/notificationStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  OPENING_CHUNK_WINDOW,
  hasRealSignal,
  isMicLive,
  measurePcm16Chunk,
  summarizeOpeningChunks,
  type PcmChunkStats,
} from "@/services/voiceStartDiagnostics";
import {
  findBuiltInMic,
  isBluetoothMicLabel,
  stripPseudoDevicePrefix,
  type VoiceMicDevice,
} from "@/services/voiceMicDevices";

const LOG_PREFIX = "[VoiceRecording]";

type StartStepLogger = (step: string, details?: Record<string, unknown>) => void;

interface OpeningAudio {
  startRequestId: number;
  chunks: PcmChunkStats[];
  logged: boolean;
}

function formatTargetLabel(target: VoiceRecordingTarget): string {
  const project = target.projectName?.trim();
  const worktree = target.worktreeLabel?.trim();
  const title = target.panelTitle?.trim();

  if (title) return title;
  if (project && worktree) {
    return `${project} / ${worktree}`;
  }
  if (project) return project;
  if (worktree) return worktree;
  return "current panel";
}

function getVoiceInsertMetadata(draft: string): { separator: string; insertStart: number } {
  const separator = draft && !draft.endsWith(" ") && !draft.endsWith("\n") ? " " : "";
  return {
    separator,
    insertStart: draft.length + separator.length,
  };
}

/**
 * Records where a session's committed words just landed in the draft: `text`
 * was written at `base + separator`. Call it straight after the write, once
 * the range store has mapped the session's earlier text through that write.
 */
function trackDictatedText(
  sessionId: string | null | undefined,
  panelId: string,
  projectId: string | undefined,
  base: string,
  separator: string,
  text: string
): void {
  if (!sessionId) return;
  const from = base.length + separator.length;
  const to = from + text.length;
  useDictationRangeStore
    .getState()
    .recordUtterance(
      { sessionId, panelId, projectId },
      { insertion: { from: base.length, to }, words: { from, to } }
    );
}

// A chosen device of "" (system default) or one of Chromium's alias entries
// names no particular mic, so whichever one opens is the one asked for.
function isSpecificDeviceId(deviceId: string): boolean {
  return deviceId !== "" && deviceId !== "default" && deviceId !== "communications";
}

// ~15s of 100ms PCM chunks. Covers a retarget drain plus a slow backend
// connect; past it the oldest audio is dropped rather than failing the session.
const MAX_QUEUED_CHUNKS = 150;

/**
 * How long a send waits for a dictated passage's correction before it goes
 * with whatever text is current (#14611).
 */
export const VOICE_CORRECTION_SEND_WAIT_MS = 2_000;

/** A finished passage's post-stop AI correction, still on its way. */
interface PendingCorrection {
  panelId: string;
  projectId?: string;
  /** Where the passage starts in the draft; moves with edits made before it. */
  from: number;
  rawText: string;
  /** The draft as last seen, to tell where the next edit landed. */
  draft: string;
  /** Applied or dropped; either way it will never touch the draft again. */
  done: boolean;
  /** Resolves when the correction is done. */
  settled: Promise<void>;
  settle: () => void;
}

/**
 * Where a passage of `length` at `from` sits after the draft went from
 * `before` to `after`: moved by an edit wholly before it, unmoved by one after
 * it, and -1 when the edit touched it. The edit is the span between the
 * longest common prefix and suffix.
 */
function mapPassageStart(before: string, after: string, from: number, length: number): number {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (prefix >= from + length) return from;
  if (before.length - suffix <= from) return from + after.length - before.length;
  return -1;
}

interface CaptureAttempt {
  target: VoiceRecordingTarget;
  audioContext: AudioContext;
  keepAliveOscillator: OscillatorNode | null;
  keepAliveGain: GainNode | null;
  stream: MediaStream | null;
  workletNode: AudioWorkletNode | null;
  // PCM captured before the backend session is ready, flushed in order once it
  // is. `null` once chunks forward live, or after the attempt is discarded.
  queue: ArrayBuffer[] | null;
  droppedChunks: number;
  deviceId: string | null;
  // UI-only: device names never go into logs.
  deviceLabel: string | null;
  // The OS pulled the track ("ended"). Latched, so a lost attempt is never
  // promoted and a lost session is torn down once.
  lost: boolean;
}

class VoiceRecordingService {
  private initialized = false;
  private generation = 0;
  private startRequestId = 0;
  // Id of the promoted session, minted by its start() and carried on every
  // chunk, start and stop main sees, so main can tell which session each
  // belongs to. Unlike `startRequestId` it is unique across project views.
  private sessionId: string | null = null;
  private audioContext: AudioContext | null = null;
  // Capture graph built by an in-flight start() and not yet promoted to the
  // session fields below. Held here so a cancel or supersede can release it
  // while getUserMedia is pending (an unanswered permission prompt can leave it
  // pending indefinitely) or while a retarget waits on the previous session's
  // drain with the new microphone already recording into its queue.
  private pendingCapture: CaptureAttempt | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private keepAliveOscillator: OscillatorNode | null = null;
  private keepAliveGain: GainNode | null = null;
  private stream: MediaStream | null = null;
  // The promoted attempt, whose track loss ends the session.
  private sessionCapture: CaptureAttempt | null = null;
  private trackObserverDisposers = new WeakMap<MediaStream, () => void>();
  private isSwitchingMic = false;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private sessionStartedAt = 0;
  private selectedDeviceId = "";
  private recordingMode: VoiceRecordingMode = "toggle";
  // KeyboardEvent.code of the physical key (e.g. "KeyV") that started the
  // current PTT session. `null` when no PTT session is active. Cleared on stop,
  // window blur, or Escape.
  private pttActiveKeyCode: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private isStoppingSession = false;
  private stopPromise: Promise<void> | null = null;
  private levelRaf: number | null = null;
  private pendingLevel = 0;
  // Session-wide audio-level stats, logged on stop so a captured log can show
  // whether the mic actually picked up speech during the recording.
  private sessionPeakRms = 0;
  private sessionRmsSum = 0;
  private sessionChunkCount = 0;
  // Per-chunk stats for the first ~2s, which is where lost opening words hide
  // (Bluetooth profile switches, Chromium zero-filling an underrunning FIFO).
  private openingAudio: OpeningAudio | null = null;
  // Pause-state tracking. The worklet suppresses PCM emission while paused, the
  // elapsed counter freezes, and a 60s auto-stop terminates the session if the
  // user never resumes — prevents idle Realtime keep-alive charges.
  private pauseStartedAt = 0;
  private totalPausedMs = 0;
  private pauseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly PAUSE_AUTO_STOP_MS = 60_000;
  // An open stream is not proof of capture: a Bluetooth mic switching to HFP
  // hands Web Audio zeros for a while (#13105). The UI only claims it is
  // listening once a chunk clears the mic-liveness floor (`isMicLive`, not the
  // diagnostics' speech-level `hasRealSignal`), and flags the mic as silent if
  // nothing does within the grace window of unpaused capture. Neither gates PCM
  // forwarding — the leading audio is still captured and held or sent either
  // way.
  private static readonly MIC_SILENCE_GRACE_MS = 3_000;
  private micSilenceTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Owner of the silence countdown, so resume can re-arm it for the same
  // capture after a pause cancelled it.
  private micSilenceSession: { generation: number; startRequestId: number } | null = null;
  // performance.now() when the live session's capture was attached.
  private micCaptureAttachedAt = 0;
  // Corrections belong to the passage they were started for, not to a global
  // generation: a session starting anywhere, the same panel included, leaves
  // them to land. Only the draft being sent, cleared or edited over drops one.
  private pendingCorrections = new Set<PendingCorrection>();
  private unwatchCorrectionDrafts: (() => void) | null = null;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    logDebug(`${LOG_PREFIX} Initializing service`);

    const voiceInput = window.electron?.voiceInput;
    if (!voiceInput) {
      logWarn(`${LOG_PREFIX} window.electron.voiceInput not available`);
      return;
    }

    this.unsubscribers.push(
      voiceInput.onTranscriptionDelta(({ text: delta, itemId, replace }) => {
        logDebug(`${LOG_PREFIX} Received transcription delta`, { itemId, length: delta.length });
        const voiceState = useVoiceRecordingStore.getState();
        const target = voiceState.activeTarget;
        if (target) {
          const buffer = voiceState.panelBuffers[target.panelId];
          // An empty revision retracts a preview; it never starts an utterance.
          const isFirstDelta = delta !== "" && (!buffer || buffer.liveText === "");
          if (isFirstDelta) {
            const draft = useTerminalInputStore
              .getState()
              .getDraftInput(target.panelId, target.projectId);
            const { insertStart } = getVoiceInsertMetadata(draft);
            useVoiceRecordingStore.getState().setSessionDraftStart(target.panelId, insertStart);
            // Snapshot where dictated text will begin once the final commit runs,
            // including any leading separator inserted between existing draft and
            // the first dictated token. Stable for the lifetime of the utterance.
            // Identified items skip it: the provider releases their completions
            // in commit order, so each one appends to the current draft.
            if (!itemId) {
              useVoiceRecordingStore
                .getState()
                .setDraftLengthAtSegmentStart(target.panelId, insertStart);
            }
            // Track paragraph start for the first utterance in a new paragraph.
            useVoiceRecordingStore.getState().setActiveParagraphStart(target.panelId, insertStart);
          }
          // Interim deltas accumulate in liveText only — the ghost-widget
          // decoration renders them outside the doc model so the editor's
          // history records a single transaction per utterance (#9172).
        }
        useVoiceRecordingStore.getState().appendDelta(delta, itemId, replace);
      })
    );

    this.unsubscribers.push(
      voiceInput.onTranscriptionComplete(({ text, itemId }) => {
        logDebug(`${LOG_PREFIX} Received transcription complete`, { itemId, length: text.length });
        const voiceState = useVoiceRecordingStore.getState();
        const panelId = voiceState.activeTarget?.panelId;
        const projectId = voiceState.activeTarget?.projectId;
        if (panelId) {
          const buffer = voiceState.panelBuffers[panelId];
          const segmentStart = itemId ? -1 : (buffer?.draftLengthAtSegmentStart ?? -1);
          const finalText = text.trim();
          if (finalText) {
            const inputStore = useTerminalInputStore.getState();
            const draft = inputStore.getDraftInput(panelId, projectId);
            // Slice back to where this segment started and replace with final transcript.
            // In the new flow the doc carries no interim text, so the slice is a no-op
            // when nothing has been written — the separator still re-fixes spacing.
            const base = segmentStart >= 0 ? draft.slice(0, segmentStart) : draft;
            const { separator, insertStart } = getVoiceInsertMetadata(base);
            // A Deepgram span can finalise without any interim, so the session's
            // first text may arrive here rather than in a delta.
            useVoiceRecordingStore.getState().setSessionDraftStart(panelId, insertStart);
            if ((buffer?.activeParagraphStart ?? -1) < 0) {
              useVoiceRecordingStore.getState().setActiveParagraphStart(panelId, insertStart);
            }
            inputStore.setDraftInput(panelId, base + separator + finalText, projectId);
            trackDictatedText(
              buffer?.dictationSessionId,
              panelId,
              projectId,
              base,
              separator,
              finalText
            );
            inputStore.bumpExternalDraftRevision();
          }
        }
        useVoiceRecordingStore.getState().completeSegment(text, itemId);
      })
    );

    this.unsubscribers.push(
      voiceInput.onFileTokenResolved(({ description, replacement }) => {
        logDebug(`${LOG_PREFIX} Received file token resolved`, {
          descriptionLength: description.length,
          replacementLength: replacement.length,
        });
        const voiceState = useVoiceRecordingStore.getState();
        const currentTarget = voiceState.activeTarget;
        if (!currentTarget) return;

        const { panelId, projectId } = currentTarget;
        const inputStore = useTerminalInputStore.getState();
        const draft = inputStore.getDraftInput(panelId, projectId);

        // Best-effort replacement: search for the description text in the draft
        const idx = draft.lastIndexOf(description);
        if (idx >= 0) {
          const before = draft.slice(0, idx);
          const after = draft.slice(idx + description.length);
          inputStore.setDraftInput(panelId, before + replacement + after, projectId);
          inputStore.bumpExternalDraftRevision();
        } else {
          logDebug(`${LOG_PREFIX} File token description not found in draft, discarding`, {
            descriptionLength: description.length,
          });
        }
      })
    );

    this.unsubscribers.push(
      voiceInput.onParagraphBoundary(({ rawText }) => {
        logDebug(`${LOG_PREFIX} Received paragraph boundary`, { rawLength: rawText?.length ?? 0 });
        const voiceState = useVoiceRecordingStore.getState();
        const currentTarget = voiceState.activeTarget;
        if (!currentTarget) return;

        const { panelId, projectId } = currentTarget;
        const buffer = voiceState.panelBuffers[panelId];
        if (!buffer) return;

        const inputStore = useTerminalInputStore.getState();
        const draft = inputStore.getDraftInput(panelId, projectId);

        // Insert a newline to visually separate paragraphs and reset paragraph state.
        inputStore.setDraftInput(panelId, draft + "\n", projectId);
        if (buffer.dictationSessionId) {
          useDictationRangeStore
            .getState()
            .recordParagraphBreak(
              { sessionId: buffer.dictationSessionId, panelId, projectId },
              { from: draft.length, to: draft.length + 1 }
            );
        }
        inputStore.bumpExternalDraftRevision();

        voiceState.resetParagraphState(panelId);
      })
    );

    this.unsubscribers.push(
      voiceInput.onError(({ error }) => {
        // During graceful stop, the main process suppresses drain errors.
        // If one leaks through, ignore it to avoid prematurely finalizing.
        if (this.isStoppingSession) {
          logWarn(`${LOG_PREFIX} Ignoring error during stop`, {
            severity: error.severity,
            code: error.code,
          });
          return;
        }
        logError(`${LOG_PREFIX} Received error from backend`, undefined, {
          severity: error.severity,
          code: error.code,
        });
        useVoiceRecordingStore.getState().setLastError(error);

        // Transient errors (rate-limit, transport drop) are recoverable — the
        // main process is already reconnecting. Store the error for tooltip
        // context but keep the session alive; the reconnecting status update
        // arriving on the same channel will update the UI.
        if (error.severity === "transient") {
          return;
        }

        // Fatal error — tear down the session and surface a toast so the user
        // knows action is needed (check API key, network, etc.).
        notify({
          type: "error",
          title: "Dictation stopped",
          action: this.settingsAction(),
          // eslint-disable-next-line no-restricted-syntax -- raw error.message: VoiceInputError is constructed internally with well-formed user copy
          message: error.message,
          context: { eventKind: "connectivity" },
        });
        void this.stop("Dictation stopped because the connection failed.", {
          skipRemoteStop: true,
          nextStatus: "error",
          preserveLiveText: true,
        });
      })
    );

    this.unsubscribers.push(
      voiceInput.onStatus(({ status }) => {
        logDebug(`${LOG_PREFIX} Received status from backend`, {
          status,
          isStoppingSession: this.isStoppingSession,
        });
        if (status !== "idle") {
          const prevStatus = useVoiceRecordingStore.getState().status;
          // Local "paused" is a renderer-only override that gates worklet PCM
          // emission. The backend doesn't know about it and will continue to
          // emit "recording" / "reconnecting" on its own schedule. Letting those
          // overwrite the store would silently exit pause: the worklet stays
          // gated, the elapsed timer stays frozen, and togglePause() routes to
          // pause() again instead of resume(). Genuine teardown signals
          // ("error") still flow through; "idle" is handled below.
          const isBenignBackendTick = status === "recording" || status === "reconnecting";
          if (prevStatus === "paused" && isBenignBackendTick) {
            return;
          }
          useVoiceRecordingStore.getState().setStatus(status);
          // Announce the reconnect once on entry — the backend re-emits
          // "reconnecting" on every retry, so guard against repeat announcements.
          if (status === "reconnecting" && prevStatus !== "reconnecting") {
            useVoiceRecordingStore.getState().announce("Reconnecting dictation…");
          }
        }

        if (this.isStoppingSession) {
          return;
        }

        if (status === "idle" && useVoiceRecordingStore.getState().activeTarget) {
          logDebug(`${LOG_PREFIX} Backend went idle while session active, stopping`);
          void this.stop("Dictation stopped.", {
            skipRemoteStop: true,
            preserveLiveText: true,
          });
        }
      })
    );

    this.unsubscribers.push(
      voiceInput.onSessionEnded(({ sessionId, reason }) => {
        logDebug(`${LOG_PREFIX} Backend session ended`, {
          sessionId,
          reason,
          current: sessionId === this.sessionId,
        });
      })
    );

    this.unsubscribers.push(window.electron.systemSleep.onSuspend(() => void this.handleSuspend()));
    this.unsubscribers.push(
      window.electron.systemSleep.onWake(() => {
        if (useVoiceRecordingStore.getState().activeTarget) {
          void this.stop("Dictation stopped after system sleep.", {
            skipRemoteStop: true,
            preserveLiveText: true,
          });
        }
      })
    );

    const handleSettingsChanged = () => {
      void this.refreshConfiguration();
    };

    window.addEventListener(VOICE_INPUT_SETTINGS_CHANGED_EVENT, handleSettingsChanged);
    this.unsubscribers.push(() =>
      window.removeEventListener(VOICE_INPUT_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
    );

    this.unsubscribers.push(
      usePanelStore.subscribe((state) => {
        const voiceState = useVoiceRecordingStore.getState();
        const activeTarget = voiceState.activeTarget;
        if (!activeTarget) return;

        // If the recording target belongs to a different project than the
        // one currently loaded, the panel's absence is expected.
        const currentProjectId = useProjectStore.getState().currentProject?.id;
        if (activeTarget.projectId && currentProjectId !== activeTarget.projectId) return;

        const found = state.panelsById[activeTarget.panelId];
        const panel = found && found.location !== "trash" ? found : undefined;

        if (!panel) {
          // No microphone has opened yet during arming — fall back to
          // cancelArming() so we don't drive stop() through a non-existent
          // session.
          if (voiceState.status === "arming") {
            this.cancelArming();
            return;
          }
          const panelId = activeTarget.panelId;
          void this.stop("Dictation stopped because its panel was closed.", {
            preserveLiveText: true,
          }).then(() => {
            useVoiceRecordingStore.getState().clearPanelBuffer(panelId);
          });
        }
      })
    );

    // Dictation takes Escape only once every overlay, menu, dialog and focused
    // widget has had its turn; the target composer hands it over itself.
    this.unsubscribers.push(registerEscapeFallback(() => this.handleEscape()));

    // Push-to-talk: a capture-phase keydown listener records the physical key
    // code of the voice shortcut press so the keyup listener can match it. The
    // actual `start()` call happens via the normal action dispatch chain
    // (`toggleFocusedPanel` / `toggleAssistant`), which calls `start()`
    // directly when `recordingMode === "push-to-talk"`. Recording only the
    // code here avoids racing the action dispatcher.
    const handlePttKeyDown = (e: KeyboardEvent) => {
      if (this.recordingMode !== "push-to-talk") return;
      if (e.repeat) return;
      // Every combo that starts recording has to arm the release, or a second
      // override combo would start push-to-talk that its keyup can't stop.
      const matches = [
        ...keybindingService.getEffectiveCombos("voiceInput.toggle"),
        ...keybindingService.getEffectiveCombos("voiceInput.toggleAssistant"),
      ].some((combo) => keybindingService.matchesEvent(e, combo));
      if (!matches) return;
      this.pttActiveKeyCode = e.code;
    };
    window.addEventListener("keydown", handlePttKeyDown, { capture: true });
    this.unsubscribers.push(() =>
      window.removeEventListener("keydown", handlePttKeyDown, { capture: true })
    );

    // Push-to-talk: stop recording on keyup of the trigger key. macOS swallows
    // the trigger keyup if a modifier (Cmd/Meta) is still held, so MetaLeft/
    // MetaRight keyup also ends the session as a safety net. Modifier-only
    // releases (Shift, Alt, Ctrl) do not stop — only the physical trigger key
    // or Meta release.
    const handlePttKeyUp = (e: KeyboardEvent) => {
      if (this.pttActiveKeyCode === null) return;
      const isTriggerRelease = e.code === this.pttActiveKeyCode;
      const isMetaRelease = e.code === "MetaLeft" || e.code === "MetaRight";
      if (!isTriggerRelease && !isMetaRelease) return;
      this.pttActiveKeyCode = null;
      void this.stop("Dictation stopped.", { preserveLiveText: true });
    };
    window.addEventListener("keyup", handlePttKeyUp, { capture: true });
    this.unsubscribers.push(() =>
      window.removeEventListener("keyup", handlePttKeyUp, { capture: true })
    );

    // Push-to-talk: window blur safety net. Chromium does NOT dispatch a
    // synthetic keyup when the window loses focus, so a Cmd+Tab mid-press
    // would otherwise leave the session running indefinitely. Stops the
    // session if a PTT press was active.
    const handlePttBlur = () => {
      if (this.pttActiveKeyCode === null) return;
      this.pttActiveKeyCode = null;
      void this.stop("Dictation stopped.", { preserveLiveText: true });
    };
    window.addEventListener("blur", handlePttBlur);
    this.unsubscribers.push(() => window.removeEventListener("blur", handlePttBlur));

    void this.refreshConfiguration();
  }

  async refreshConfiguration(): Promise<boolean> {
    const settings = await window.electron.voiceInput.getSettings();
    // "Configured" means the selected provider has its own API key — Deepgram
    // uses deepgramApiKey, every other provider uses openaiApiKey.
    const hasProviderKey =
      settings.transcriptionProvider === "deepgram"
        ? !!settings.deepgramApiKey
        : !!settings.openaiApiKey;
    const isConfigured = settings.enabled && hasProviderKey;
    this.selectedDeviceId = settings.deviceId ?? "";
    this.recordingMode = settings.recordingMode ?? "toggle";
    logDebug(`${LOG_PREFIX} refreshConfiguration`, {
      enabled: settings.enabled,
      provider: settings.transcriptionProvider,
      hasProviderKey,
      isConfigured,
      correctionEnabled: settings.correctionEnabled,
      recordingMode: this.recordingMode,
    });
    // Keep correction state in sync for live-segment dimming
    useVoiceRecordingStore
      .getState()
      .setCorrectionEnabled(!!(settings.correctionEnabled && settings.openaiApiKey));
    useVoiceRecordingStore
      .getState()
      .setLearnFromCorrections(settings.learnFromCorrections !== false);
    useVoiceRecordingStore.getState().setConfigured(isConfigured);
    return isConfigured;
  }

  async toggle(target: VoiceRecordingTarget): Promise<void> {
    this.initialize();
    const state = useVoiceRecordingStore.getState();
    const isActiveTarget = state.activeTarget?.panelId === target.panelId;
    const isActive = isActiveVoiceSession(state.status);

    logDebug(`${LOG_PREFIX} toggle`, {
      panelId: target.panelId,
      isActiveTarget,
      isActive,
      status: state.status,
    });

    // A second press during the arming window aborts back to idle. No session
    // exists yet, so there is nothing for stop() to drain — cancelArming()
    // releases whatever the in-flight start() has opened and makes it bail at
    // its next staleness check, discarding any audio it already queued.
    if (isActiveTarget && state.status === "arming") {
      this.cancelArming();
      return;
    }

    if (isActiveTarget && isActive) {
      await this.stop("Dictation stopped.", { preserveLiveText: true });
      return;
    }

    // Refresh recent-targets MRU on confirmed routing (before any await so the
    // entry reflects the user's intent even if start() bails later — recent
    // targets are a navigation aid, not a session log).
    useVoiceRecordingStore.getState().recordRecentTarget(target);

    // Synchronous pre-audio cue. setArming() resolves under 1ms (Zustand set);
    // the first await inside start() then carries us to "connecting" within
    // ~50–200ms, by which point beginSession() has overwritten this state.
    useVoiceRecordingStore.getState().setArming(target);
    await this.start(target);
  }

  /**
   * Escape that reached dictation, from the global fallback or from the target
   * composer (`panelId`). Returns whether it acted, so a finishing or idle
   * session leaves the key to whatever is next in line.
   */
  handleEscape(panelId?: string): boolean {
    const state = useVoiceRecordingStore.getState();
    if (panelId !== undefined && state.activeTarget?.panelId !== panelId) return false;
    // Arming is the pre-audio confirmation window. No session has begun
    // yet, so route abort through cancelArming() instead of stop() —
    // stop() would log "no active session" warnings and skip the cleanup
    // path that resets activeTarget back to null.
    if (state.status === "arming") {
      this.cancelArming();
      return true;
    }
    if (
      state.status !== "connecting" &&
      state.status !== "recording" &&
      state.status !== "paused" &&
      state.status !== "reconnecting"
    ) {
      return false;
    }
    void this.stop("Dictation stopped.", { preserveLiveText: true });
    return true;
  }

  /**
   * Abort an in-flight arming window before a session begins. Bumping
   * startRequestId invalidates any pending start() so it bails at its next
   * staleness check; finishSession() returns the store to idle without
   * touching panel buffers (no transcript exists yet).
   */
  private cancelArming(): void {
    // A push-to-talk press that aborted arming must not have its keyup send a
    // stop for a session that never began.
    this.pttActiveKeyCode = null;
    this.invalidatePendingStart();
    useVoiceRecordingStore.getState().finishSession({ nextStatus: "idle" });
  }

  /**
   * Make any in-flight start() stale and release the capture graph it built
   * ahead of its session, so a start stuck on a pending permission prompt or a
   * retarget drain doesn't hold the microphone or an output stream open after
   * the user has moved on.
   */
  private invalidatePendingStart(): void {
    this.startRequestId++;
    this.releasePendingCapture();
  }

  private releasePendingCapture(): void {
    const pending = this.pendingCapture;
    if (!pending) return;
    this.pendingCapture = null;
    pending.queue = null;
    void this.cleanupCaptureResources(pending).catch(() => {});
  }

  private enqueueCapturedChunk(capture: CaptureAttempt, chunk: ArrayBuffer): void {
    const queue = capture.queue;
    if (!queue) return;
    queue.push(chunk);
    if (queue.length > MAX_QUEUED_CHUNKS) {
      queue.shift();
      if (++capture.droppedChunks === 1) {
        logWarn(`${LOG_PREFIX} Startup audio queue full, dropping oldest audio`);
      }
    }
  }

  private settingsAction(): NotificationAction {
    return {
      label: "Open voice settings",
      actionId: "app.settings.openTab",
      actionArgs: { tab: "voice" },
      onClick: () => this.openVoiceSettings(),
    };
  }

  private micSettingsAction(): NotificationAction {
    return {
      label: "Open microphone settings",
      onClick: () => {
        safeFireAndForget(window.electron.voiceInput.openMicSettings(), {
          context: "Opening OS microphone settings",
        });
      },
    };
  }

  private retryAction(retry: () => void): NotificationAction {
    return { label: "Retry", onClick: retry };
  }

  /** Every start failure surfaces here: one toast, one recovery action that fits the cause. */
  private reportStartFailure(title: string, message: string, action?: NotificationAction): void {
    const payload = { type: "error" as const, title, message };
    if (action) {
      notify({ ...payload, action });
      return;
    }
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify(payload);
  }

  private openVoiceSettings(): void {
    safeFireAndForget(
      import("@/services/ActionService").then(({ actionService }) =>
        actionService.dispatch("app.settings.openTab", { tab: "voice" }, { source: "user" })
      ),
      { context: "Opening voice settings" }
    );
  }

  /**
   * Roll the store off the "arming" status when a `start()` call has set
   * an error and is about to return. Without this, the store would stay
   * `{ status: "arming", activeTarget: T }` indefinitely — the toolbar and
   * panel border would keep showing the pre-recording cue with no mic to
   * back it up. A failed retarget also ends the session it was replacing:
   * the store is about to report an error with no target, and that session's
   * microphone must not keep recording behind it.
   */
  private async failArming(): Promise<void> {
    if (this.stream) {
      await this.stop(undefined, {
        nextStatus: "error",
        announce: false,
        preservePendingStart: true,
      });
      return;
    }
    // A stop still draining would otherwise finish afterwards and overwrite
    // the error with "idle".
    if (this.stopPromise) await this.stopPromise;
    useVoiceRecordingStore.getState().finishSession({ nextStatus: "error" });
  }

  async start(target: VoiceRecordingTarget): Promise<void> {
    this.initialize();
    this.releasePendingCapture();
    const startRequestId = ++this.startRequestId;
    const sessionId = crypto.randomUUID();
    // toggle() reaches here with no await after the hotkey/click, so start()
    // entry stands in for the gesture. Renderer-local clock only — main's
    // timings use their own origin.
    const startedAt = performance.now();
    const logStep: StartStepLogger = (step, details) => {
      try {
        logInfo(`${LOG_PREFIX} Start step`, {
          startRequestId,
          sessionId,
          step,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...details,
        });
      } catch {
        // Diagnostics must never abort start() or drop a chunk.
      }
    };
    logDebug(`${LOG_PREFIX} start() called`, {
      panelId: target.panelId,
      generation: this.generation,
      startRequestId,
    });
    logStep("start");

    // The settings read and the permission-status read are independent IPCs,
    // so both go out together rather than paying two round trips in series.
    // The permission result is settled into a value so an early return on the
    // settings side never leaves a rejection unhandled.
    const micStatusPromise = window.electron.voiceInput.checkMicPermission().then(
      (status) => {
        logStep("permission_check", { micStatus: status });
        return { ok: true as const, status };
      },
      (error: unknown) => ({ ok: false as const, error })
    );
    const isConfigured = await this.refreshConfiguration().catch(() => false);
    logStep("settings", { configured: isConfigured });
    if (!isConfigured || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Not configured, aborting start`);
      if (!this.isStartRequestStale(startRequestId)) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "renderer_error",
          message: "Voice input is not configured.",
        });
        useVoiceRecordingStore
          .getState()
          .announce("Voice dictation is not configured. Open Voice settings to continue.");
        await this.failArming();
        this.openVoiceSettings();
      }
      return;
    }

    // Check and request OS-level microphone permission (macOS requires this
    // from the main process before getUserMedia will succeed in the renderer).
    // A rejection (main-process crash, channel teardown) must not leak past
    // start() and leave the store armed forever.
    const micStatusResult = await micStatusPromise;
    if (!micStatusResult.ok) {
      logError(
        `${LOG_PREFIX} checkMicPermission IPC rejected`,
        undefined,
        voiceErrorLogFields(micStatusResult.error)
      );
      if (!this.isStartRequestStale(startRequestId)) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "mic_permission_check_failed",
          message: "Could not check microphone permission. Try again.",
        });
        this.reportStartFailure(
          "Dictation didn't start",
          "Could not check microphone permission.",
          this.retryAction(() => void this.start(target))
        );
        await this.failArming();
      }
      return;
    }
    if (this.isStartRequestStale(startRequestId)) {
      return;
    }
    const micStatus = micStatusResult.status;
    logDebug(`${LOG_PREFIX} Microphone permission status`, { micStatus });

    if (micStatus === "denied" || micStatus === "restricted") {
      const message = "Microphone permission denied. Enable it in System Settings and try again.";
      logError(`${LOG_PREFIX} Microphone permission denied at OS level`, { micStatus });
      useVoiceRecordingStore
        .getState()
        .setLastError({ severity: "fatal", code: "mic_permission_denied", message });
      useVoiceRecordingStore.getState().announce(message);
      this.reportStartFailure("Microphone blocked", message, this.micSettingsAction());
      await this.failArming();
      return;
    }

    if (micStatus === "not-determined") {
      logDebug(`${LOG_PREFIX} Running native microphone permission preflight`);
      // Only macOS can answer this natively; Windows/Linux resolve `true` to mean
      // "clear to attempt capture", so a `false` here is a genuine macOS denial.
      let canAttemptCapture: boolean;
      try {
        canAttemptCapture = await window.electron.voiceInput.requestMicPermission();
      } catch (err) {
        logError(
          `${LOG_PREFIX} requestMicPermission IPC rejected`,
          undefined,
          voiceErrorLogFields(err)
        );
        if (!this.isStartRequestStale(startRequestId)) {
          useVoiceRecordingStore.getState().setLastError({
            severity: "fatal",
            code: "mic_permission_request_failed",
            message: "Could not request microphone permission. Try again.",
          });
          this.reportStartFailure(
            "Dictation didn't start",
            "Could not request microphone permission.",
            this.retryAction(() => void this.start(target))
          );
          await this.failArming();
        }
        return;
      }
      if (this.isStartRequestStale(startRequestId)) {
        return;
      }
      logDebug(`${LOG_PREFIX} Native microphone preflight result`, { canAttemptCapture });
      logStep("permission_request", { canAttemptCapture });
      if (!canAttemptCapture) {
        const message = "Microphone permission denied. Enable it in System Settings and try again.";
        useVoiceRecordingStore
          .getState()
          .setLastError({ severity: "fatal", code: "mic_permission_denied", message });
        useVoiceRecordingStore.getState().announce(message);
        this.reportStartFailure("Microphone blocked", message, this.micSettingsAction());
        await this.failArming();
        return;
      }
    }

    // Build the AudioContext BEFORE opening the microphone. Its constructor
    // resolves the output device with a synchronous IPC, and Chromium only
    // caches that answer for a few seconds. Constructed after getUserMedia, a
    // cache miss queues behind the audio service bringing up the just-opened
    // input stream and freezes the renderer for ~650ms on macOS — with the
    // recording indicator already committed but unpainted. Done first, the
    // lookup lands on an idle audio service and costs a few milliseconds.
    logDebug(`${LOG_PREFIX} Creating AudioContext (24kHz) — eager capture`);
    const audioContext = new AudioContext({ sampleRate: 24000 });
    logStep("audio_context_create", {
      state: audioContext.state,
      sampleRate: audioContext.sampleRate,
    });
    this.observeAudioContextState(audioContext, logStep);
    const capture: CaptureAttempt = {
      target,
      audioContext,
      keepAliveOscillator: null,
      keepAliveGain: null,
      stream: null,
      workletNode: null,
      queue: [],
      droppedChunks: 0,
      deviceId: null,
      deviceLabel: null,
      lost: false,
    };
    this.pendingCapture = capture;
    // Owned by the attempt until promotion, so a previous session's stop can't
    // flush this attempt's window as its own.
    const openingAudio: OpeningAudio = { startRequestId, chunks: [], logged: false };
    // An attempt no longer pending was already released by a cancel or
    // supersede; the stream is stopped directly in case it arrived afterwards.
    const abandonCapture = (stream?: MediaStream) => {
      if (this.pendingCapture === capture) this.releasePendingCapture();
      this.flushOpeningAudio(openingAudio);
      if (stream) this.stopStreamTracks(stream);
    };

    // Build the rest of the graph while the microphone is still opening, so it
    // is ready to attach the moment the stream arrives. Observed immediately so
    // a bail before it is awaited can't surface as an unhandled rejection.
    const graphReady = (async () => {
      // Keep the AudioContext in "running" state while backgrounded. Chromium
      // suspends capture-only contexts (no output to destination) when the
      // window loses focus. Connecting a silent oscillator to the destination
      // tricks the engine into treating the context as audible so
      // AudioWorkletNode keeps firing.
      const keepAliveGain = audioContext.createGain();
      capture.keepAliveGain = keepAliveGain;
      keepAliveGain.gain.value = 0;
      const keepAliveOscillator = audioContext.createOscillator();
      keepAliveOscillator.connect(keepAliveGain);
      keepAliveGain.connect(audioContext.destination);
      keepAliveOscillator.start();
      // Recorded only once started: cleanup calls stop(), which throws on an
      // oscillator that never started.
      capture.keepAliveOscillator = keepAliveOscillator;

      logDebug(`${LOG_PREFIX} Loading pcm-processor worklet`);
      await Promise.all([
        audioContext.state === "suspended"
          ? audioContext
              .resume()
              .then(() => logStep("audio_context_resume", { state: audioContext.state }))
          : undefined,
        audioContext.audioWorklet
          .addModule("/pcm-processor.js")
          .then(() => logStep("worklet_load")),
      ]);
    })().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    );

    // Acquire microphone stream. On macOS the preflight above already settled
    // permission; on Windows/Linux this call IS the permission gate, so a denial
    // arrives here as NotAllowedError rather than from the preflight.
    logDebug(`${LOG_PREFIX} Requesting microphone access`);
    let stream: MediaStream;
    // Snapshot: a settings change while the mic opens mustn't read as a fallback.
    const requestedDeviceId = this.selectedDeviceId;
    try {
      const constraints: MediaStreamConstraints = requestedDeviceId
        ? { audio: { deviceId: { ideal: requestedDeviceId } }, video: false }
        : { audio: true, video: false };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      abandonCapture();
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission denied. Enable it in System Settings and try again."
          : "Could not access the microphone.";
      logError(`${LOG_PREFIX} getUserMedia failed`, undefined, {
        ...voiceErrorLogFields(error),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      if (!this.isStartRequestStale(startRequestId)) {
        const micCode =
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "mic_permission_denied"
            : "mic_access_failed";
        useVoiceRecordingStore
          .getState()
          .setLastError({ severity: "fatal", code: micCode, message });
        useVoiceRecordingStore.getState().announce(message);
        this.reportStartFailure(
          micCode === "mic_permission_denied" ? "Microphone blocked" : "Microphone unavailable",
          micCode === "mic_permission_denied"
            ? message
            : "Could not access the microphone. It may be in use by another app.",
          micCode === "mic_permission_denied"
            ? this.micSettingsAction()
            : this.retryAction(() => void this.start(target))
        );
        await this.failArming();
      }
      return;
    }
    if (this.pendingCapture === capture) capture.stream = stream;

    // Log which mic and capture settings the OS handed us — a wrong/dead device
    // or unexpected sample rate is a real failure mode. Kept out of the
    // getUserMedia try block and fully guarded: diagnostics must never be able
    // to abort start().
    try {
      const audioTracks = stream.getAudioTracks();
      logInfo(`${LOG_PREFIX} Microphone access granted`, {
        trackCount: audioTracks.length,
        devices: audioTracks.map((track) => {
          const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
          return {
            hasLabel: Boolean(track.label),
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
            // `deviceId` is load-bearing for this subsystem — it's how we tell
            // "system default" from a specific device (see issue #7902).
            deviceId: settings.deviceId,
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl,
          };
        }),
      });
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not read microphone track settings`, voiceErrorLogFields(err));
    }
    // Which mic opened, for the pane: Chromium falls back silently when the
    // chosen one is gone, because it is requested as `ideal`.
    let usingFallbackMic = false;
    try {
      const track = stream.getAudioTracks()[0];
      capture.deviceLabel = track?.label ? stripPseudoDevicePrefix(track.label) || null : null;
      const actualId = track?.getSettings?.().deviceId;
      capture.deviceId = actualId || null;
      if (isSpecificDeviceId(requestedDeviceId) && actualId && actualId !== requestedDeviceId) {
        usingFallbackMic = true;
        logWarn(`${LOG_PREFIX} Microphone device mismatch`, {
          requested: requestedDeviceId,
          actual: actualId,
        });
      }
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not read microphone device`, voiceErrorLogFields(err));
    }
    logStep("get_user_media");
    this.observeTrackState(stream, logStep, () => this.handleTrackEnded(capture));

    if (this.isStartRequestStale(startRequestId)) {
      abandonCapture(stream);
      return;
    }

    const failMicLost = async () => {
      abandonCapture(stream);
      logWarn(`${LOG_PREFIX} Microphone lost before the session began`);
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "mic_lost",
        message: "The microphone was disconnected.",
      });
      useVoiceRecordingStore
        .getState()
        .setMicNotice({ kind: "lost", target, deviceLabel: capture.deviceLabel });
      useVoiceRecordingStore
        .getState()
        .announce("Dictation didn't start because the microphone was disconnected.");
      await this.failArming();
    };
    const isCaptureLost = () =>
      capture.lost ||
      (typeof stream.getAudioTracks === "function" &&
        stream.getAudioTracks().some((track) => track.readyState === "ended"));

    const graphResult = await graphReady;
    if (this.isStartRequestStale(startRequestId)) {
      abandonCapture(stream);
      return;
    }
    if (isCaptureLost()) {
      await failMicLost();
      return;
    }
    const failCaptureSetup = async (error: unknown) => {
      abandonCapture(stream);
      logError(
        `${LOG_PREFIX} Failed to set up the audio graph`,
        undefined,
        voiceErrorLogFields(error)
      );
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "Failed to load the audio processor.",
      });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to initialize.");
      this.reportStartFailure(
        "Dictation didn't start",
        "Failed to load the audio processor.",
        this.retryAction(() => void this.start(target))
      );
      await this.failArming();
    };
    if (!graphResult.ok) {
      await failCaptureSetup(graphResult.error);
      return;
    }
    logDebug(`${LOG_PREFIX} pcm-processor worklet loaded`);

    // Attach capture now, ahead of any retarget drain and the backend start.
    // Until the session is promoted, chunks only land in this attempt's queue:
    // they must not reach the previous session's send path or its meters.
    let workletNode: AudioWorkletNode;
    let sessionGeneration: number | null = null;
    let arrivedChunks = 0;
    let firstNonZeroChunk = 0;
    let firstSignalChunk = 0;
    let firstLiveChunk = 0;
    const observeArrivingChunk = (data: ArrayBuffer): PcmChunkStats | null => {
      try {
        arrivedChunks++;
        const stats = measurePcm16Chunk(new Int16Array(data));
        if (arrivedChunks === 1) {
          logStep("first_chunk", { samples: stats.samples, held: capture.queue !== null });
        }
        // Steady chunks don't prove a live mic: exact zeros come from a muted
        // track or Chromium zero-filling an underrunning input FIFO. Separate
        // "any sample moved" from "above the signal floor".
        if (!firstNonZeroChunk && stats.zeroFraction < 1 && stats.samples > 0) {
          firstNonZeroChunk = arrivedChunks;
          logStep("first_nonzero_chunk", {
            chunk: arrivedChunks,
            peak: Number(stats.peak.toFixed(4)),
          });
        }
        if (!firstSignalChunk && hasRealSignal(stats)) {
          firstSignalChunk = arrivedChunks;
          logStep("first_signal_chunk", {
            chunk: arrivedChunks,
            peak: Number(stats.peak.toFixed(4)),
          });
        }
        if (!firstLiveChunk && isMicLive(stats)) firstLiveChunk = arrivedChunks;
        if (!openingAudio.logged) {
          openingAudio.chunks.push(stats);
          if (openingAudio.chunks.length >= OPENING_CHUNK_WINDOW) {
            this.flushOpeningAudio(openingAudio);
          }
        }
        return stats;
      } catch {
        // Diagnostics must never drop a chunk.
        return null;
      }
    };
    try {
      const source = audioContext.createMediaStreamSource(stream);
      workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
      capture.workletNode = workletNode;
      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (sessionGeneration !== null && this.generation !== sessionGeneration) return;
        // Measured on arrival, held or not, so the timings show when audio
        // actually reached the renderer. Read before sendAudioChunk() hands
        // the buffer to IPC.
        const stats = observeArrivingChunk(event.data);
        if (sessionGeneration === null) {
          this.enqueueCapturedChunk(capture, event.data);
          return;
        }
        this.meterAudioChunk(event.data, stats ?? undefined);
        // Held chunks count too: the user may be speaking before the backend
        // is connected, and the cue should follow the mic, not the socket.
        if (
          stats &&
          isMicLive(stats) &&
          !this.isStartRequestStale(startRequestId) &&
          isVoiceMicPending(useVoiceRecordingStore.getState())
        ) {
          this.markMicLive(target, arrivedChunks);
        }
        if (capture.queue) {
          this.enqueueCapturedChunk(capture, event.data);
        } else {
          window.electron.voiceInput.sendAudioChunk(sessionId, event.data);
        }
      };
      source.connect(workletNode);
    } catch (error) {
      await failCaptureSetup(error);
      return;
    }
    logDebug(`${LOG_PREFIX} Eager audio capture started`);
    logStep("source_attach");
    const captureAttachedAt = performance.now();
    let micSilenceGraceMs = VoiceRecordingService.MIC_SILENCE_GRACE_MS;

    // Only an actually-started session (open mic stream) needs to be torn
    // down here. `this.stream` is the canonical "audio is open" flag and is
    // independent of store status — using store.activeTarget here would
    // false-positive during the arming window (we seeded it ourselves) and
    // status alone would miss a cross-panel switch where the new "arming"
    // status has already overwritten the prior session's "recording". A stop
    // already draining is joined too, so the new session never begins under it.
    if (this.stream || this.stopPromise) {
      logDebug(`${LOG_PREFIX} Stopping existing session before starting new one`);
      await this.stop(undefined, {
        preserveLiveText: true,
        announce: false,
        preservePendingStart: true,
        skipCorrection: true,
      });
      logStep("previous_session_stop");
      if (this.isStartRequestStale(startRequestId)) {
        abandonCapture(stream);
        return;
      }
      if (isCaptureLost()) {
        await failMicLost();
        return;
      }
      // The new mic has been capturing through the drain, so that time counts
      // against its grace window.
      micSilenceGraceMs = Math.max(0, micSilenceGraceMs - (performance.now() - captureAttachedAt));
    }

    const generation = ++this.generation;
    logDebug(`${LOG_PREFIX} Beginning session`, { generation });
    this.pauseStartedAt = 0;
    this.totalPausedMs = 0;
    this.clearPauseTimeout();
    useVoiceRecordingStore.getState().beginSession(target);
    // beginSession resets the panel's buffer; a passage still being corrected
    // there keeps its underline.
    if (this.hasPendingCorrection(target.panelId)) this.syncCorrectionRange(target.panelId);

    // Promote the attempt to the session. From here stop() owns its teardown.
    if (this.pendingCapture === capture) this.pendingCapture = null;
    capture.stream = stream;
    this.sessionCapture = capture;
    this.stream = stream;
    this.audioContext = audioContext;
    this.keepAliveOscillator = capture.keepAliveOscillator;
    this.keepAliveGain = capture.keepAliveGain;
    this.workletNode = workletNode;
    this.sessionId = sessionId;
    sessionGeneration = generation;
    logInfo(`${LOG_PREFIX} AudioContext created`, {
      requestedSampleRate: 24000,
      actualSampleRate: audioContext.sampleRate,
      state: audioContext.state,
      baseLatency: audioContext.baseLatency,
    });
    if (!openingAudio.logged) this.openingAudio = openingAudio;

    this.sessionPeakRms = 0;
    this.sessionRmsSum = 0;
    this.sessionChunkCount = 0;
    for (const chunk of capture.queue ?? []) {
      this.meterAudioChunk(chunk);
    }

    // The "Dictation started" announcement waits for real audio (markMicLive);
    // announcing here would tell the user to speak into a mic still delivering
    // zeros.
    useVoiceRecordingStore.getState().setMicDeviceLabel(capture.deviceLabel);
    if (usingFallbackMic) {
      useVoiceRecordingStore
        .getState()
        .setMicNotice({ kind: "fallback", target, deviceLabel: capture.deviceLabel });
    }

    this.sessionStartedAt = Date.now();
    this.startElapsedTimer();
    this.micCaptureAttachedAt = captureAttachedAt;
    // Real audio that arrived while a previous session drained already counts.
    if (firstLiveChunk) {
      this.markMicLive(target, firstLiveChunk);
    } else {
      this.startMicSilenceTimer(generation, startRequestId, micSilenceGraceMs);
    }

    // Connect in parallel — audio keeps queueing until the backend is ready.
    // Chunks can't go out earlier: main only swaps in this session's provider
    // once its own async setup finishes, so anything sent before start()
    // resolves could land on the previous provider or be dropped.
    logDebug(`${LOG_PREFIX} Calling voiceInput.start() IPC`);
    const result = await window.electron.voiceInput
      .start(sessionId, { terminalId: target.panelId })
      .then(
        (outcome) =>
          outcome.status === "started"
            ? { ok: true as const }
            : {
                ok: false as const,
                error: outcome.status === "failed" ? outcome.error : "Voice session superseded",
              },
        (error: unknown) => ({
          ok: false as const,
          error: formatErrorMessage(error, "Voice input failed to start."),
        })
      );
    logDebug(`${LOG_PREFIX} voiceInput.start() returned`, { ok: result.ok });
    logStep("backend_start", { ok: result.ok });

    if (this.generation !== generation || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Generation mismatch after IPC start`);
      this.clearMicSilenceTimerFor(generation, startRequestId);
      capture.queue = null;
      this.flushOpeningAudio(openingAudio);
      await this.cleanupCaptureResources({
        audioContext,
        keepAliveGain: capture.keepAliveGain,
        keepAliveOscillator: capture.keepAliveOscillator,
        stream,
        workletNode,
      });
      return;
    }

    if (!result.ok) {
      logError(`${LOG_PREFIX} Backend start failed`);
      capture.queue = null;
      this.flushOpeningAudio(openingAudio);
      await this.cleanupAudioCapture();
      // A newer start may have taken over while the teardown awaited.
      if (this.generation !== generation || this.isStartRequestStale(startRequestId)) return;
      useVoiceRecordingStore
        .getState()
        .setLastError({ severity: "fatal", code: "backend_start_failed", message: result.error });
      useVoiceRecordingStore.getState().finishSession({ nextStatus: "error" });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to start.");
      this.reportStartFailure("Dictation didn't start", result.error, this.settingsAction());
      return;
    }

    // Flush synchronously, oldest first, so no live chunk can interleave.
    const queued = capture.queue ?? [];
    capture.queue = null;
    for (const chunk of queued) {
      window.electron.voiceInput.sendAudioChunk(sessionId, chunk);
    }
    logDebug(`${LOG_PREFIX} Flushed startup audio`, {
      chunks: queued.length,
      droppedChunks: capture.droppedChunks,
    });
    logStep("startup_audio_flush", {
      chunks: queued.length,
      droppedChunks: capture.droppedChunks,
    });

    // Backend is connected — status transitions to "recording" via the onStatus listener.
    logDebug(`${LOG_PREFIX} Recording started successfully`);
  }

  private meterAudioChunk(
    data: ArrayBuffer,
    stats: PcmChunkStats = measurePcm16Chunk(new Int16Array(data))
  ): void {
    this.sessionChunkCount++;
    const chunkCount = this.sessionChunkCount;

    // RMS audio level from PCM16 samples for the UI glow.
    const rms = stats.rms;
    this.sessionPeakRms = Math.max(this.sessionPeakRms, rms);
    this.sessionRmsSum += rms;
    this.pendingLevel = Math.min(1, rms * 6);

    if (chunkCount <= 3 || chunkCount % 100 === 0) {
      // Include RMS stats so a captured log can distinguish "mic was silent"
      // (peak/avg near 0) from "user spoke but no transcription came back".
      logDebug(`${LOG_PREFIX} Audio chunk #${chunkCount}`, {
        bytes: data.byteLength,
        rms: Number(rms.toFixed(4)),
        peakRms: Number(this.sessionPeakRms.toFixed(4)),
        avgRms: Number((this.sessionRmsSum / chunkCount).toFixed(4)),
      });
    }

    if (this.levelRaf === null) {
      this.levelRaf = requestAnimationFrame(() => {
        this.levelRaf = null;
        useVoiceRecordingStore.getState().setAudioLevel(this.pendingLevel);
      });
    }
  }

  async stop(
    announcement = "Dictation stopped.",
    options: {
      skipRemoteStop?: boolean;
      preserveLiveText?: boolean;
      nextStatus?: "idle" | "error";
      announce?: boolean;
      preservePendingStart?: boolean;
      /** Skip the post-stop whole-passage AI cleanup pass (e.g. when stopping to start a new session). */
      skipCorrection?: boolean;
    } = {}
  ): Promise<void> {
    if (this.stopPromise) {
      // Joining a stop already in flight — typically a retarget's teardown,
      // which runs with preservePendingStart so its own start can follow. An
      // explicit stop has to cancel that pending start too, or the recording
      // resumes on the new target once the drain finishes.
      if (!options.preservePendingStart) {
        this.invalidatePendingStart();
        this.pttActiveKeyCode = null;
      }
      await this.stopPromise;
      return;
    }

    this.stopPromise = (async () => {
      this.initialize();
      const { skipRemoteStop = false, preserveLiveText = true, nextStatus = "idle" } = options;
      const shouldAnnounce = options.announce ?? true;

      // Clear any PTT key tracking — the keyup safety net should not fire stop
      // again on a session that's already winding down.
      this.pttActiveKeyCode = null;

      if (!options.preservePendingStart) {
        this.invalidatePendingStart();
      }

      const stopSessionId = this.sessionId;
      const storeState = useVoiceRecordingStore.getState();
      const hasSession =
        storeState.activeTarget !== null || isActiveVoiceSession(storeState.status);
      // Captured before finishSession() clears activeTarget — used to kick off
      // the post-stop correction pass once the session has wound down.
      const stoppedTarget = storeState.activeTarget;
      const correctionEnabled = storeState.correctionEnabled;

      logDebug(`${LOG_PREFIX} stop() called`, {
        announcement,
        hasSession,
        skipRemoteStop,
        nextStatus,
        currentStatus: storeState.status,
        hasActiveTarget: !!storeState.activeTarget,
      });

      // A session shorter than the opening window still reports what it had.
      if (this.openingAudio) this.flushOpeningAudio(this.openingAudio);

      // Session audio summary — a near-zero peak means the mic captured no
      // speech, which explains an empty transcript without it being a bug.
      if (this.sessionChunkCount > 0) {
        logInfo(`${LOG_PREFIX} Session audio summary`, {
          chunks: this.sessionChunkCount,
          peakRms: Number(this.sessionPeakRms.toFixed(4)),
          avgRms: Number((this.sessionRmsSum / this.sessionChunkCount).toFixed(4)),
          likelySilent: this.sessionPeakRms < 0.01,
        });
      } else {
        logWarn(`${LOG_PREFIX} Session produced zero audio chunks`);
      }

      // Stop audio capture immediately — no new audio after this point.
      // DON'T increment generation yet so in-flight worklet messages still
      // get forwarded to the main process before the drain.
      this.clearTimers();
      await this.cleanupAudioCapture();
      this.generation++;

      if (!skipRemoteStop) {
        // Graceful stop: the IPC handler drains pending transcriptions and flushes
        // the paragraph buffer before resolving. Keep activeTarget alive so late
        // transcription and correction events are still applied to the correct panel.
        logDebug(`${LOG_PREFIX} Sending remote stop (graceful drain)`);
        this.isStoppingSession = true;
        useVoiceRecordingStore.getState().setStatus("finishing");
        // No promoted session means main never heard of one from this view.
        if (stopSessionId) {
          await window.electron.voiceInput.stop(stopSessionId).catch(() => null);
        }
      }

      if (hasSession) {
        // Flush any remaining interim text (liveText) into the draft as a final
        // commit before finishSession clears it. In the ghost-widget flow the
        // doc carries no interim text, so without this flush a mid-utterance
        // stop would silently drop the partial transcription.
        if (preserveLiveText) {
          const currentTarget = useVoiceRecordingStore.getState().activeTarget;
          if (currentTarget) {
            const { panelId, projectId } = currentTarget;
            const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
            const remaining = buffer?.liveText?.trim();
            const segmentStart = buffer?.draftLengthAtSegmentStart ?? -1;
            if (remaining) {
              const inputStore = useTerminalInputStore.getState();
              const draft = inputStore.getDraftInput(panelId, projectId);
              const base = segmentStart >= 0 ? draft.slice(0, segmentStart) : draft;
              const { separator } = getVoiceInsertMetadata(base);
              inputStore.setDraftInput(panelId, base + separator + remaining, projectId);
              trackDictatedText(
                buffer?.dictationSessionId,
                panelId,
                projectId,
                base,
                separator,
                remaining
              );
              inputStore.bumpExternalDraftRevision();
            }
          }
        }
        useVoiceRecordingStore.getState().finishSession({ preserveLiveText, nextStatus });
        if (shouldAnnounce) {
          useVoiceRecordingStore.getState().announce(announcement);
        }
      } else if (nextStatus === "idle") {
        useVoiceRecordingStore.getState().setStatus("idle");
      }

      this.isStoppingSession = false;
      if (this.sessionId === stopSessionId) this.sessionId = null;

      // Whole-passage AI cleanup runs after a deliberate, graceful stop only —
      // not on error, cancel-to-restart, or backend-driven teardown. stop()
      // doesn't await it: the decoration shows progress, and a send waits for
      // it through waitForPendingCorrections(). It is registered before stop()
      // resolves, so a caller that awaited stop() can always see it.
      if (!skipRemoteStop && nextStatus === "idle" && !options.skipCorrection && stoppedTarget) {
        if (correctionEnabled) {
          this.runCorrection(stoppedTarget);
        } else {
          // No AI correction pass will run, so capture the raw dictated text as
          // the learning baseline directly. The draft retains the full dictated
          // span (finishSession leaves sessionDraftStart intact) so manual
          // corrections can still be detected at send time (#9749).
          const { panelId, projectId } = stoppedTarget;
          const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
          const sessionStart = buffer?.sessionDraftStart ?? -1;
          if (sessionStart >= 0) {
            const raw = useTerminalInputStore
              .getState()
              .getDraftInput(panelId, projectId)
              .slice(sessionStart);
            useVoiceRecordingStore
              .getState()
              .setSessionCorrectedText(panelId, raw.trim() ? raw : null);
          }
        }
      }
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /**
   * Whole-passage AI cleanup pass. Runs once after a graceful stop: marks the
   * dictated range with the `cm-voice-pending-ai` decoration, sends the full
   * dictated text to gpt-6-luna, and swaps in the cleaned result if the
   * passage is still intact. Best-effort — any failure leaves the raw text.
   * Registered synchronously, before the request goes out.
   */
  private runCorrection(target: VoiceRecordingTarget): void {
    const { panelId, projectId } = target;
    const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
    const sessionStart = buffer?.sessionDraftStart ?? -1;
    if (sessionStart < 0) return;

    const inputStore = useTerminalInputStore.getState();
    const draftBefore = inputStore.getDraftInput(panelId, projectId);
    const rawText = draftBefore.slice(sessionStart);
    if (!rawText.trim()) return;

    // Seed the learning baseline with the raw transcription synchronously, before
    // the async correction call, so the panel keeps a usable baseline even if
    // the correction never lands (#9749).
    useVoiceRecordingStore.getState().setSessionCorrectedText(panelId, rawText);

    logDebug(`${LOG_PREFIX} Running whole-passage correction`, {
      panelId,
      rawLength: rawText.length,
    });

    let settle!: () => void;
    const correction: PendingCorrection = {
      panelId,
      projectId,
      from: sessionStart,
      rawText,
      draft: draftBefore,
      done: false,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    this.pendingCorrections.add(correction);
    this.watchCorrectionDrafts();

    // Show the dotted-underline "correcting" decoration over the dictated range.
    this.syncCorrectionRange(panelId);
    inputStore.bumpExternalDraftRevision();

    void this.requestCorrection(correction);
  }

  private async requestCorrection(correction: PendingCorrection): Promise<void> {
    let correctedText = correction.rawText;
    try {
      const result = await window.electron.voiceInput.correct({ rawText: correction.rawText });
      if (result.action === "replace" && result.correctedText.trim()) {
        correctedText = result.correctedText;
      }
    } catch (error) {
      logWarn(
        `${LOG_PREFIX} Correction request failed, keeping raw text`,
        voiceErrorLogFields(error)
      );
    }

    if (correction.done) {
      logDebug(`${LOG_PREFIX} Correction result stale (draft sent or edited), discarding`);
      return;
    }
    this.retireCorrection(correction);

    const { panelId, projectId, from, rawText } = correction;
    const inputStore = useTerminalInputStore.getState();
    if (correctedText !== rawText) {
      const draftNow = inputStore.getDraftInput(panelId, projectId);
      // The draft watcher drops a passage the moment anything touches it, so a
      // live one is still exactly where it was tracked.
      if (draftNow.slice(from, from + rawText.length) === rawText) {
        const end = from + rawText.length;
        // A session restarted on this panel is dictating after the passage;
        // its offsets move with the passage's new length.
        useVoiceRecordingStore
          .getState()
          .shiftDraftOffsets(panelId, end, correctedText.length - rawText.length);
        inputStore.setDraftInput(
          panelId,
          draftNow.slice(0, from) + correctedText + draftNow.slice(end),
          projectId
        );
        logDebug(`${LOG_PREFIX} Applied correction`, {
          panelId,
          rawLength: rawText.length,
          correctedLength: correctedText.length,
        });
      } else {
        logDebug(`${LOG_PREFIX} Skipping correction — dictated text changed during cleanup`);
        correctedText = rawText;
      }
    }

    // Record the settled dictated text as the learning baseline. Manual edits
    // the user makes before sending are diffed against this to detect words
    // worth suggesting for the custom dictionary (#9749). Only over the seed
    // this pass wrote: a send consumes it, and a newer session on the panel
    // replaces it with its own.
    const voiceStore = useVoiceRecordingStore.getState();
    if (voiceStore.panelBuffers[panelId]?.sessionCorrectedText === rawText) {
      voiceStore.setSessionCorrectedText(panelId, correctedText);
    }

    this.syncCorrectionRange(panelId);
    inputStore.bumpExternalDraftRevision();
  }

  hasPendingCorrection(panelId: string): boolean {
    for (const correction of this.pendingCorrections) {
      if (correction.panelId === panelId) return true;
    }
    return false;
  }

  /**
   * Resolves true once every correction pending for the panel has landed or
   * been dropped, or false if `timeoutMs` runs out first.
   */
  async waitForPendingCorrections(panelId: string, timeoutMs: number): Promise<boolean> {
    const settled: Promise<void>[] = [];
    for (const correction of this.pendingCorrections) {
      if (correction.panelId === panelId) settled.push(correction.settled);
    }
    if (settled.length === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([Promise.all(settled).then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drops every correction still pending for the panel, for a send that is
   * taking the draft as it stands. A result that arrives later never lands.
   */
  discardPendingCorrections(panelId: string): void {
    let dropped = false;
    for (const correction of [...this.pendingCorrections]) {
      if (correction.panelId !== panelId) continue;
      this.retireCorrection(correction);
      dropped = true;
    }
    if (dropped) this.syncCorrectionRange(panelId);
  }

  private retireCorrection(correction: PendingCorrection): void {
    if (correction.done) return;
    correction.done = true;
    this.pendingCorrections.delete(correction);
    correction.settle();
    if (this.pendingCorrections.size === 0) {
      this.unwatchCorrectionDrafts?.();
      this.unwatchCorrectionDrafts = null;
    }
  }

  /**
   * Follows each pending passage through draft edits while any is pending. An
   * edit before a passage moves it; an edit that touches it, or a send or clear
   * that takes it away, drops its correction for good, so a result arriving
   * later can never land on whatever the draft holds by then.
   */
  private watchCorrectionDrafts(): void {
    if (this.unwatchCorrectionDrafts) return;
    this.unwatchCorrectionDrafts = useTerminalInputStore.subscribe((state, prev) => {
      if (state.draftInputs === prev.draftInputs) return;
      const touched = new Set<string>();
      for (const correction of [...this.pendingCorrections]) {
        const draft = state.getDraftInput(correction.panelId, correction.projectId);
        if (draft === correction.draft) continue;
        const from = mapPassageStart(
          correction.draft,
          draft,
          correction.from,
          correction.rawText.length
        );
        correction.draft = draft;
        touched.add(correction.panelId);
        if (
          from < 0 ||
          draft.slice(from, from + correction.rawText.length) !== correction.rawText
        ) {
          this.retireCorrection(correction);
          continue;
        }
        correction.from = from;
      }
      for (const panelId of touched) this.syncCorrectionRange(panelId);
    });
  }

  /** Points the panel's "correcting" decoration at its pending passages. */
  private syncCorrectionRange(panelId: string): void {
    let range: { from: number; to: number } | null = null;
    for (const correction of this.pendingCorrections) {
      if (correction.panelId !== panelId) continue;
      const to = correction.from + correction.rawText.length;
      range = range
        ? { from: Math.min(range.from, correction.from), to: Math.max(range.to, to) }
        : { from: correction.from, to };
    }
    const voiceStore = useVoiceRecordingStore.getState();
    // A closed panel's buffer is gone; a late result mustn't bring it back.
    if (!voiceStore.panelBuffers[panelId]) return;
    voiceStore.setCorrectionRange(panelId, range);
  }

  async toggleFocusedPanel(): Promise<void> {
    this.initialize();

    // The shortcut is a global stop: a running session ends wherever it is,
    // before focus or the lock is consulted, so the press can never move the
    // recording to whichever panel happens to own focus (#12832).
    const stopping = this.stopAnySession();
    if (stopping) {
      await stopping;
      return;
    }

    // Locked target overrides focus routing entirely — synchronous read before
    // any await so the value reflects the user's pin at the moment the hotkey
    // fired (mirrors the assistant-focus pattern below for #6959). When the
    // locked panel has been trashed or removed, clear the stale lock and fall
    // through to normal focus-based resolution rather than failing silently.
    const lockedTarget = useVoiceRecordingStore.getState().lockedTarget;
    if (lockedTarget) {
      const lockedPanel = usePanelStore.getState().panelsById[lockedTarget.panelId];
      if (lockedPanel && lockedPanel.location !== "trash") {
        await this.toggle(lockedTarget);
        return;
      }
      useVoiceRecordingStore.getState().clearLockedTarget(lockedTarget.panelId);
    }

    // Assistant focus is tracked by macroFocusStore, not panelStore.focusedId,
    // so check it synchronously (before any await — #6959) and route dictation
    // to the assistant when its input owns focus. Otherwise the last-active grid
    // terminal would steal the dictation (#8887).
    if (isAssistantFocused()) {
      const assistantTarget = this.getAssistantTarget();
      if (!assistantTarget) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "renderer_error",
          message: "Daintree Assistant is starting — try again in a moment.",
        });
        useVoiceRecordingStore
          .getState()
          .announce("Daintree Assistant is starting. Try dictation again in a moment.");
        this.reportStartFailure(
          "Dictation didn't start",
          "Daintree Assistant is still starting.",
          this.retryAction(() => void this.toggleFocusedPanel())
        );
        return;
      }
      await this.startOrToggle(assistantTarget);
      return;
    }

    const target = this.getFocusedPanelTarget();
    if (!target) {
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "No focused terminal is available for dictation.",
      });
      useVoiceRecordingStore
        .getState()
        .announce("Focus an agent terminal before starting dictation.");
      this.reportStartFailure(
        "Dictation unavailable",
        "Focus an agent terminal to dictate into its input."
      );
      return;
    }

    await this.startOrToggle(target);
  }

  /**
   * End whatever dictation is in progress, regardless of target. Returns null
   * when idle — synchronously, so the caller's focus and lock reads still
   * happen before any await. A pre-audio arming window with no mic open only
   * needs cancelArming(); if a stream is still open (a panel button
   * retargeting mid-session re-enters arming before tearing the old session
   * down), a full stop() is needed to release it.
   */
  private stopAnySession(): Promise<void> | null {
    const { status } = useVoiceRecordingStore.getState();
    if (status === "arming" && !this.stream) {
      this.cancelArming();
      return Promise.resolve();
    }
    if (status === "arming" || isActiveVoiceSession(status)) {
      return this.stop("Dictation stopped.", { preserveLiveText: true });
    }
    return null;
  }

  /**
   * Toggle dictation directly into the Daintree Assistant input, regardless of
   * which panel currently owns focus (#8887). Opens the assistant if it's
   * closed; if no assistant session has launched yet (`terminalId` is null) it
   * surfaces a toast rather than silently doing nothing.
   */
  async toggleAssistant(): Promise<void> {
    this.initialize();

    const helpState = useHelpPanelStore.getState();
    if (!helpState.isOpen) {
      helpState.setOpen(true);
      helpState.requestFocus();
    }

    // setOpen only flips the visibility flag — the assistant terminal is spawned
    // on render, so terminalId may still be null here. Don't re-read it; guide
    // the user to retry once the session exists.
    const assistantTarget = this.getAssistantTarget();
    if (!assistantTarget) {
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "Start the Daintree Assistant before dictating.",
      });
      useVoiceRecordingStore.getState().announce("Start the Daintree Assistant before dictating.");
      this.reportStartFailure(
        "Dictation didn't start",
        "Start the Daintree Assistant before dictating.",
        this.retryAction(() => void this.toggleAssistant())
      );
      return;
    }

    await this.startOrToggle(assistantTarget);
  }

  // In push-to-talk mode the keyboard shortcut starts recording; the keyup
  // listener stops it. But the same action is also reachable from the command
  // palette, the menu, and agent automation — none of which produce a keyup.
  // Falling back to stop-on-second-invoke for an active session of the same
  // target keeps those entry points usable without affecting the held-key
  // flow (a held-key second press is suppressed by the e.repeat guard, and a
  // release-then-press cycle has already cleared the active session).
  // In toggle mode the shortcut behaves as before. Toolbar callers should
  // keep using `toggle()` directly — they have no keyup analog and must not
  // be affected by the recording-mode setting.
  private async startOrToggle(target: VoiceRecordingTarget): Promise<void> {
    if (this.recordingMode === "push-to-talk") {
      const state = useVoiceRecordingStore.getState();
      const isActiveTarget = state.activeTarget?.panelId === target.panelId;
      if (isActiveTarget && isActiveVoiceSession(state.status)) {
        await this.stop("Dictation stopped.", { preserveLiveText: true });
        return;
      }
      await this.start(target);
      return;
    }
    await this.toggle(target);
  }

  async focusActiveTarget(): Promise<boolean> {
    this.initialize();
    const target = useVoiceRecordingStore.getState().activeTarget;
    if (!target) return false;

    const currentProjectId = useProjectStore.getState().currentProject?.id;
    if (target.projectId && currentProjectId !== target.projectId) {
      await useProjectStore.getState().switchProject(target.projectId);
    }

    if (target.worktreeId) {
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      if (activeWorktreeId !== target.worktreeId) {
        useWorktreeSelectionStore.getState().selectWorktree(target.worktreeId);
      }
    }

    await this.waitForPanel(target.panelId);

    const foundPanel = usePanelStore.getState().panelsById[target.panelId];
    if (!foundPanel || foundPanel.location === "trash") {
      return false;
    }
    const panel = foundPanel;

    usePanelStore.getState().activateTerminal(panel.id);
    return true;
  }

  // Mirrors shouldShowHybridInputBar: dictation lands in the composer, so a
  // panel that renders none would take the text into a draft nobody can see.
  private hasComposer(panel: PanelInstance): boolean {
    if (!isPtyPanel(panel)) return false;
    const chrome = deriveTerminalChrome({
      kind: "terminal",
      launchAgentId: panel.launchAgentId,
      runtimeIdentity: panel.runtimeIdentity,
      detectedAgentId: panel.detectedAgentId,
      detectedProcessId: panel.detectedProcessId,
    });
    const armed = useFleetArmingStore.getState().armedIds;
    return shouldShowHybridInputBar({
      hasAgentIdentity: isBuiltInAgentId(chrome.agentId),
      hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
      isFleetArmed: armed.has(panel.id),
      fleetSize: armed.size,
    });
  }

  private getFocusedPanelTarget(): VoiceRecordingTarget | null {
    const terminalState = usePanelStore.getState();
    const panelId = terminalState.focusedId;
    if (!panelId) return null;

    const foundPanel = terminalState.panelsById[panelId];
    if (!foundPanel || foundPanel.location === "trash") return null;
    // A pane held for recovery (#12434) has no input surface to dictate into.
    if (isPtyPanel(foundPanel) && foundPanel.restoreRecovery) return null;
    if (!this.hasComposer(foundPanel)) return null;
    const panel = foundPanel;

    const currentProject = useProjectStore.getState().currentProject;
    const worktree = panel.worktreeId
      ? getCurrentViewStore().getState().worktrees.get(panel.worktreeId)
      : undefined;

    return {
      panelId: panel.id,
      panelTitle: panel.title,
      projectId: currentProject?.id,
      projectName: currentProject?.name,
      worktreeId: panel.worktreeId,
      worktreeLabel: worktree?.isMainWorktree ? worktree?.name : worktree?.branch || worktree?.name,
    };
  }

  private getAssistantTarget(): VoiceRecordingTarget | null {
    // The ACTIVE lane (#12108): dictation is aimed at the session on screen,
    // not at whichever one happens to be running in the background.
    const terminalId = selectActiveSlot(useHelpPanelStore.getState()).terminalId;
    if (!terminalId) return null;

    // Guard the brief window where the assistant terminal has been trashed (or
    // not yet committed to panelStore) but helpPanelStore.terminalId is still
    // set — mirrors getFocusedPanelTarget(). A missing/trashed panel means the
    // assistant is starting or tearing down, so dictation must not target it.
    const panelEntry = usePanelStore.getState().panelsById[terminalId];
    if (!panelEntry || panelEntry.location === "trash") return null;

    const currentProject = useProjectStore.getState().currentProject;
    return {
      panelId: terminalId,
      panelTitle: "Daintree Assistant",
      projectId: currentProject?.id,
      projectName: currentProject?.name,
    };
  }

  private async waitForPanel(panelId: string, timeoutMs = 5000): Promise<void> {
    const existingPanel = usePanelStore.getState().panelsById[panelId];
    if (existingPanel && existingPanel.location !== "trash") return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve();
      }, timeoutMs);

      const unsubscribe = usePanelStore.subscribe((state) => {
        const found = state.panelsById[panelId];
        if (!found || found.location === "trash" || settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      });
    });
  }

  private async handleSuspend(): Promise<void> {
    if (!useVoiceRecordingStore.getState().activeTarget) return;
    await this.stop("Dictation stopped because the system is going to sleep.", {
      preserveLiveText: true,
    });
  }

  private startElapsedTimer(): void {
    this.clearElapsedTimer();
    useVoiceRecordingStore.getState().setElapsedSeconds(this.computeElapsedSeconds());
    this.elapsedTimer = setInterval(() => {
      useVoiceRecordingStore.getState().setElapsedSeconds(this.computeElapsedSeconds());
    }, 1000);
  }

  private computeElapsedSeconds(): number {
    const wallMs = Date.now() - this.sessionStartedAt;
    return Math.max(0, Math.floor((wallMs - this.totalPausedMs) / 1000));
  }

  private clearElapsedTimer(): void {
    if (!this.elapsedTimer) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }

  private clearPauseTimeout(): void {
    if (this.pauseTimeoutId === null) return;
    clearTimeout(this.pauseTimeoutId);
    this.pauseTimeoutId = null;
  }

  private markMicLive(target: VoiceRecordingTarget, chunkCount: number): void {
    this.clearMicSilenceTimer();
    const state = useVoiceRecordingStore.getState();
    logInfo(`${LOG_PREFIX} Microphone delivering audio`, {
      chunk: chunkCount,
      msSinceCaptureAttach: Math.round(performance.now() - this.micCaptureAttachedAt),
      wasSilent: state.micSignal === "silent",
    });
    state.setMicSignal("live");
    if (state.micNotice?.kind === "silent") state.setMicNotice(null);
    // One announcement, so the fallback mic isn't replaced before it's read.
    const fallbackMic =
      state.micNotice?.kind === "fallback"
        ? (state.micNotice.deviceLabel ?? "another microphone")
        : null;
    state.announce(
      fallbackMic
        ? `Dictation started in ${formatTargetLabel(target)}, using ${fallbackMic}.`
        : `Dictation started in ${formatTargetLabel(target)}.`
    );
  }

  private startMicSilenceTimer(
    generation: number,
    startRequestId: number,
    delayMs: number = VoiceRecordingService.MIC_SILENCE_GRACE_MS
  ): void {
    this.clearMicSilenceTimer();
    this.micSilenceSession = { generation, startRequestId };
    this.micSilenceTimeoutId = setTimeout(() => {
      this.micSilenceTimeoutId = null;
      if (this.generation !== generation || this.isStartRequestStale(startRequestId)) return;
      const state = useVoiceRecordingStore.getState();
      // Paused (or finishing) before the mic came up: the worklet isn't
      // forwarding, so the absence of audio says nothing about the mic.
      if (state.micSignal !== "pending" || !isVoiceMicPending(state)) return;
      logWarn(`${LOG_PREFIX} No audio from microphone after grace window`, {
        graceMs: VoiceRecordingService.MIC_SILENCE_GRACE_MS,
        chunkCount: this.sessionChunkCount,
        peakRms: Number(this.sessionPeakRms.toFixed(4)),
      });
      state.setMicSignal("silent");
      const deviceLabel = this.sessionCapture?.deviceLabel ?? null;
      state.announce(
        deviceLabel ? `No audio from ${deviceLabel} yet.` : "No audio from the microphone yet."
      );
      void this.raiseSilentMicNotice(generation);
    }, delayMs);
  }

  /**
   * Shows the silent-mic warning in the pane, offering the built-in mic when
   * there is one other than the silent mic. The device list is dropped if the
   * session moved on, or the mic came alive, while it was read.
   */
  private async raiseSilentMicNotice(generation: number): Promise<void> {
    const capture = this.sessionCapture;
    const target = useVoiceRecordingStore.getState().activeTarget;
    if (!capture || !target) return;
    const { deviceId, deviceLabel } = capture;
    let builtIn: VoiceMicDevice | null = null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const candidate = findBuiltInMic(devices.filter((device) => device.kind === "audioinput"));
      if (candidate && candidate.deviceId !== deviceId && candidate.label !== deviceLabel) {
        builtIn = candidate;
      }
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not list microphones`, voiceErrorLogFields(err));
    }
    const state = useVoiceRecordingStore.getState();
    if (
      this.generation !== generation ||
      this.sessionCapture !== capture ||
      state.micSignal !== "silent" ||
      state.micNotice?.kind === "lost"
    ) {
      return;
    }
    state.setMicNotice({
      kind: "silent",
      target,
      deviceLabel,
      bluetooth: isBluetoothMicLabel(deviceLabel),
      builtIn,
    });
  }

  /**
   * The silent-mic notice's way forward: make the built-in mic the dictation
   * mic, then restart the session it was raised for on it. The restart is a
   * retarget onto the same pane, so the new mic records while the silent
   * session drains. A paused session, or one held open by a push-to-talk key,
   * only has the choice saved: restarting would resume it, or outlive the
   * key's release.
   */
  async switchToMicFromNotice(notice: VoiceMicNotice): Promise<void> {
    if (notice.kind !== "silent" || !notice.builtIn || this.isSwitchingMic) return;
    if (useVoiceRecordingStore.getState().micNotice !== notice) return;
    const builtIn = notice.builtIn;
    const generation = this.generation;
    this.isSwitchingMic = true;
    try {
      try {
        await window.electron.voiceInput.setSettings({ deviceId: builtIn.deviceId });
      } catch (err) {
        logWarn(`${LOG_PREFIX} Could not save the microphone choice`, voiceErrorLogFields(err));
        useVoiceRecordingStore.getState().announce("Couldn't switch the microphone.");
        return;
      }
      this.selectedDeviceId = builtIn.deviceId;
      const state = useVoiceRecordingStore.getState();
      // The choice is saved either way; only the session the notice belongs
      // to is restarted, and only while it is still running.
      if (
        this.generation !== generation ||
        this.stopPromise ||
        state.activeTarget?.panelId !== notice.target.panelId ||
        !isActiveVoiceSession(state.status)
      ) {
        return;
      }
      if (state.status === "paused" || this.pttActiveKeyCode !== null) {
        state.dismissMicNotice(notice);
        state.announce(`${builtIn.label} will be used from the next dictation.`);
        return;
      }
      logInfo(`${LOG_PREFIX} Restarting dictation on the built-in microphone`);
      await this.start(state.activeTarget);
    } finally {
      this.isSwitchingMic = false;
    }
  }

  private clearMicSilenceTimer(): void {
    if (this.micSilenceTimeoutId === null) return;
    clearTimeout(this.micSilenceTimeoutId);
    this.micSilenceTimeoutId = null;
  }

  // A superseded start must not cancel a newer session's countdown.
  private clearMicSilenceTimerFor(generation: number, startRequestId: number): void {
    const owner = this.micSilenceSession;
    if (!owner || owner.generation !== generation || owner.startRequestId !== startRequestId) {
      return;
    }
    this.clearMicSilenceTimer();
    this.micSilenceSession = null;
  }

  private clearTimers(): void {
    this.clearElapsedTimer();
    this.clearPauseTimeout();
    this.clearMicSilenceTimer();
    useVoiceRecordingStore.getState().setElapsedSeconds(0);
  }

  /**
   * Suspend audio capture without tearing down the OpenAI Realtime session.
   * The PCM worklet stops forwarding chunks, the elapsed counter freezes, and
   * a 60-second auto-stop timer prevents the session from idling forever.
   * No-op unless the current status is "recording" — paused-on-paused, resume
   * on idle, and pause during connect/reconnect/finish are all ignored.
   */
  pause(): void {
    this.initialize();
    const state = useVoiceRecordingStore.getState();
    if (state.status !== "recording") {
      logDebug(`${LOG_PREFIX} pause() ignored`, { status: state.status });
      return;
    }
    logDebug(`${LOG_PREFIX} Pausing dictation`);
    this.workletNode?.port.postMessage({ type: "setPaused", value: true });
    this.pauseStartedAt = Date.now();
    this.clearElapsedTimer();
    // The worklet stops forwarding while paused, so no audio says nothing
    // about the mic — the grace window only counts unpaused capture.
    this.clearMicSilenceTimer();
    state.setStatus("paused");
    state.announce("Dictation paused.");
    this.clearPauseTimeout();
    this.pauseTimeoutId = setTimeout(() => {
      this.pauseTimeoutId = null;
      // Re-read status inside the callback — the session may have ended,
      // been resumed, or even restarted on another panel between pause and
      // timeout (#5087 pattern: never close over store state in timers).
      const current = useVoiceRecordingStore.getState();
      if (current.status !== "paused") return;
      logInfo(`${LOG_PREFIX} Auto-stopping after 60s pause`);
      void this.stop("Dictation stopped after 60-second pause.", {
        preserveLiveText: true,
      });
    }, VoiceRecordingService.PAUSE_AUTO_STOP_MS);
  }

  /**
   * Resume audio capture after a pause. Re-enables the worklet PCM pipeline,
   * accumulates the paused duration into the elapsed-time offset so the
   * displayed counter reflects only speaking time, and clears the auto-stop
   * timer. No-op unless the current status is "paused".
   */
  resume(): void {
    this.initialize();
    const state = useVoiceRecordingStore.getState();
    if (state.status !== "paused") {
      logDebug(`${LOG_PREFIX} resume() ignored`, { status: state.status });
      return;
    }
    logDebug(`${LOG_PREFIX} Resuming dictation`);
    this.clearPauseTimeout();
    if (this.pauseStartedAt > 0) {
      this.totalPausedMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = 0;
    }
    this.workletNode?.port.postMessage({ type: "setPaused", value: false });
    state.setStatus("recording");
    this.startElapsedTimer();
    // Resuming before the mic ever went live must not invite the user to speak
    // into zeros; the first real chunk announces the start instead.
    if (state.micSignal === "live") {
      state.announce("Dictation resumed.");
    } else {
      const silenceSession = this.micSilenceSession;
      if (
        state.micSignal === "pending" &&
        silenceSession &&
        silenceSession.generation === this.generation
      ) {
        this.startMicSilenceTimer(silenceSession.generation, silenceSession.startRequestId);
      }
    }
  }

  /**
   * Toggle between recording and paused. No-op when no session is active or
   * the session is in a transitional phase (connecting, reconnecting, finishing).
   */
  togglePause(): void {
    const status = useVoiceRecordingStore.getState().status;
    if (status === "recording") {
      this.pause();
    } else if (status === "paused") {
      this.resume();
    } else {
      logDebug(`${LOG_PREFIX} togglePause() ignored`, { status });
    }
  }

  destroy(): void {
    this.invalidatePendingStart();
    // Vite HMR disposes and re-evaluates this module; the old singleton's
    // timers must be cleared or they fire against the new singleton's state.
    this.clearPauseTimeout();
    this.clearElapsedTimer();
    this.clearMicSilenceTimer();
    // Release anyone waiting on a correction; none of them may land now.
    for (const correction of [...this.pendingCorrections]) {
      this.retireCorrection(correction);
    }
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.initialized = false;
  }

  // Idempotent and identity-scoped: a late flush of an old attempt never
  // clears a newer session's window.
  private flushOpeningAudio(openingAudio: OpeningAudio): void {
    if (this.openingAudio === openingAudio) this.openingAudio = null;
    if (openingAudio.logged) return;
    openingAudio.logged = true;
    if (openingAudio.chunks.length === 0) return;
    try {
      logInfo(`${LOG_PREFIX} Opening audio`, {
        startRequestId: openingAudio.startRequestId,
        ...summarizeOpeningChunks(openingAudio.chunks),
      });
    } catch {
      // Diagnostics must never abort a stop or drop a chunk.
    }
  }

  // Listeners live as long as the context/track this start owns; both are
  // closed or stopped and dropped on teardown, and the final "closed"
  // transition is itself worth logging. Diagnostics must never abort start().
  private observeAudioContextState(audioContext: AudioContext, logStep: StartStepLogger): void {
    try {
      if (typeof audioContext.addEventListener !== "function") return;
      audioContext.addEventListener("statechange", () => {
        logStep("audio_context_statechange", { state: audioContext.state });
      });
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not observe AudioContext state`, voiceErrorLogFields(err));
    }
  }

  // A local track.stop() fires no "ended", so an "ended" here means the
  // device or OS pulled the track. Mute and unmute stay diagnostic: neither
  // proves the device is gone. Listeners are removed before the tracks are
  // stopped (stopStreamTracks).
  private observeTrackState(
    stream: MediaStream,
    logStep: StartStepLogger,
    onEnded: () => void
  ): void {
    const removers: Array<() => void> = [];
    try {
      const tracks = typeof stream.getAudioTracks === "function" ? stream.getAudioTracks() : [];
      tracks.forEach((track, trackIndex) => {
        if (typeof track.addEventListener !== "function") return;
        for (const event of ["mute", "unmute", "ended"] as const) {
          const listener = () => {
            try {
              logStep(`track_${event}`, {
                trackIndex,
                muted: track.muted,
                readyState: track.readyState,
              });
            } catch {
              // Diagnostics must never stop a lost mic from ending the session.
            }
            if (event === "ended") onEnded();
          };
          track.addEventListener(event, listener);
          removers.push(() => track.removeEventListener?.(event, listener));
        }
      });
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not observe microphone track state`, voiceErrorLogFields(err));
    }
    this.trackObserverDisposers.set(stream, () => {
      for (const remove of removers) remove();
    });
  }

  private stopStreamTracks(stream: MediaStream): void {
    const dispose = this.trackObserverDisposers.get(stream);
    if (dispose) {
      this.trackObserverDisposers.delete(stream);
      try {
        dispose();
      } catch {
        // Listener removal is best-effort; the tracks still have to stop.
      }
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  /**
   * The input device went away. A session on it ends the way a stop does —
   * audio already sent is drained and transcribed, live text is kept — and
   * the pane says why. An attempt not yet promoted is only marked: start()
   * checks before promoting it.
   */
  private handleTrackEnded(capture: CaptureAttempt): void {
    if (capture.lost) return;
    capture.lost = true;
    // A stop already owns the teardown, or this capture was superseded.
    if (this.sessionCapture !== capture || this.stopPromise || !this.initialized) return;
    const store = useVoiceRecordingStore.getState();
    logWarn(`${LOG_PREFIX} Microphone lost mid-session`, { status: store.status });
    // Published before the stop so it can't land on a session started after it.
    store.setMicNotice({
      kind: "lost",
      target: store.activeTarget ?? capture.target,
      deviceLabel: capture.deviceLabel,
    });
    void this.stop("Dictation stopped because the microphone was lost.", {
      preserveLiveText: true,
    });
  }

  private async cleanupAudioCapture(): Promise<void> {
    await this.cleanupCaptureResources({
      audioContext: this.audioContext,
      keepAliveGain: this.keepAliveGain,
      keepAliveOscillator: this.keepAliveOscillator,
      stream: this.stream,
      workletNode: this.workletNode,
    });
  }

  private isStartRequestStale(startRequestId: number): boolean {
    return !this.initialized || startRequestId !== this.startRequestId;
  }

  private async cleanupCaptureResources(resources: {
    audioContext?: AudioContext | null;
    keepAliveGain?: GainNode | null;
    keepAliveOscillator?: OscillatorNode | null;
    stream?: MediaStream | null;
    workletNode?: AudioWorkletNode | null;
  }): Promise<void> {
    if (
      resources.workletNode &&
      this.levelRaf !== null &&
      this.workletNode === resources.workletNode
    ) {
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
    }

    if (resources.workletNode && this.workletNode === resources.workletNode) {
      this.clearMicSilenceTimer();
    }

    if (resources.workletNode) {
      resources.workletNode.port.onmessage = null;
      resources.workletNode.disconnect();
      if (this.workletNode === resources.workletNode) {
        this.workletNode = null;
      }
    }

    if (resources.keepAliveOscillator) {
      resources.keepAliveOscillator.stop();
      resources.keepAliveOscillator.disconnect();
      if (this.keepAliveOscillator === resources.keepAliveOscillator) {
        this.keepAliveOscillator = null;
      }
    }

    if (resources.keepAliveGain) {
      resources.keepAliveGain.disconnect();
      if (this.keepAliveGain === resources.keepAliveGain) {
        this.keepAliveGain = null;
      }
    }

    // Tracks stop before the context closes: close() can be slow, and the OS
    // microphone indicator must go out the moment capture is released.
    if (resources.stream) {
      this.stopStreamTracks(resources.stream);
      if (this.stream === resources.stream) {
        this.stream = null;
      }
      if (this.sessionCapture?.stream === resources.stream) {
        this.sessionCapture = null;
      }
    }

    if (resources.audioContext) {
      await resources.audioContext.close().catch(() => {});
      if (this.audioContext === resources.audioContext) {
        this.audioContext = null;
      }
    }
  }
}

export const voiceRecordingService = new VoiceRecordingService();

// In development, Vite HMR re-evaluates this module and creates a new
// singleton. Without cleanup, the old singleton's ipcRenderer.on listeners
// stay alive and forward every event twice, causing text duplication.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    voiceRecordingService.destroy();
  });
}
