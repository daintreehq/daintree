import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { isActiveVoiceSession, type VoiceInputError, type VoiceRecordingMode } from "@shared/types";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";
import { keybindingService } from "@/services/KeybindingService";
import { logDebug, logInfo, logWarn, logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { notify } from "@/lib/notify";

const LOG_PREFIX = "[VoiceRecording]";

function formatTargetLabel(target: VoiceRecordingTarget): string {
  const project = target.projectName?.trim();
  const worktree = target.worktreeLabel?.trim();

  if (project && worktree) {
    return `${project} / ${worktree}`;
  }
  if (project) return project;
  if (worktree) return worktree;
  return target.panelTitle?.trim() || "current panel";
}

function getVoiceInsertMetadata(draft: string): { separator: string; insertStart: number } {
  const separator = draft && !draft.endsWith(" ") && !draft.endsWith("\n") ? " " : "";
  return {
    separator,
    insertStart: draft.length + separator.length,
  };
}

class VoiceRecordingService {
  private initialized = false;
  private generation = 0;
  private startRequestId = 0;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private keepAliveOscillator: OscillatorNode | null = null;
  private keepAliveGain: GainNode | null = null;
  private stream: MediaStream | null = null;
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
  // Pause-state tracking. The worklet suppresses PCM emission while paused, the
  // elapsed counter freezes, and a 60s auto-stop terminates the session if the
  // user never resumes — prevents idle Realtime keep-alive charges.
  private pauseStartedAt = 0;
  private totalPausedMs = 0;
  private pauseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private static readonly PAUSE_AUTO_STOP_MS = 60_000;

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
      voiceInput.onTranscriptionDelta((delta) => {
        logDebug(`${LOG_PREFIX} Received transcription delta`, { length: delta.length });
        const voiceState = useVoiceRecordingStore.getState();
        const target = voiceState.activeTarget;
        if (target) {
          const buffer = voiceState.panelBuffers[target.panelId];
          const isFirstDelta = !buffer || buffer.liveText === "";
          if (isFirstDelta) {
            const draft = useTerminalInputStore
              .getState()
              .getDraftInput(target.panelId, target.projectId);
            const { insertStart } = getVoiceInsertMetadata(draft);
            useVoiceRecordingStore.getState().setSessionDraftStart(target.panelId, insertStart);
            // Snapshot where dictated text will begin once the final commit runs,
            // including any leading separator inserted between existing draft and
            // the first dictated token. Stable for the lifetime of the utterance.
            useVoiceRecordingStore
              .getState()
              .setDraftLengthAtSegmentStart(target.panelId, insertStart);
            // Track paragraph start for the first utterance in a new paragraph.
            useVoiceRecordingStore.getState().setActiveParagraphStart(target.panelId, insertStart);
          }
          // Interim deltas accumulate in liveText only — the ghost-widget
          // decoration renders them outside the doc model so the editor's
          // history records a single transaction per utterance (#9172).
        }
        useVoiceRecordingStore.getState().appendDelta(delta);
      })
    );

    this.unsubscribers.push(
      voiceInput.onTranscriptionComplete(({ text }) => {
        logDebug(`${LOG_PREFIX} Received transcription complete`, { text });
        const voiceState = useVoiceRecordingStore.getState();
        const panelId = voiceState.activeTarget?.panelId;
        const projectId = voiceState.activeTarget?.projectId;
        if (panelId) {
          const buffer = voiceState.panelBuffers[panelId];
          const segmentStart = buffer?.draftLengthAtSegmentStart ?? -1;
          const finalText = text.trim();
          if (finalText) {
            const inputStore = useTerminalInputStore.getState();
            const draft = inputStore.getDraftInput(panelId, projectId);
            // Slice back to where this segment started and replace with final transcript.
            // In the new flow the doc carries no interim text, so the slice is a no-op
            // when nothing has been written — the separator still re-fixes spacing.
            const base = segmentStart >= 0 ? draft.slice(0, segmentStart) : draft;
            const { separator, insertStart } = getVoiceInsertMetadata(base);
            if ((buffer?.activeParagraphStart ?? -1) < 0) {
              useVoiceRecordingStore.getState().setActiveParagraphStart(panelId, insertStart);
            }
            inputStore.setDraftInput(panelId, base + separator + finalText, projectId);
            inputStore.bumpExternalDraftRevision();
          }
        }
        useVoiceRecordingStore.getState().completeSegment(text);
      })
    );

    this.unsubscribers.push(
      voiceInput.onFileTokenResolved(({ description, replacement }) => {
        logDebug(`${LOG_PREFIX} Received file token resolved`, { description, replacement });
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
            description,
            replacement,
          });
        }
      })
    );

    this.unsubscribers.push(
      voiceInput.onParagraphBoundary(({ rawText }) => {
        logDebug(`${LOG_PREFIX} Received paragraph boundary`, { rawText });
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
        inputStore.bumpExternalDraftRevision();

        voiceState.resetParagraphState(panelId);
      })
    );

    this.unsubscribers.push(
      voiceInput.onError((error: VoiceInputError) => {
        // During graceful stop, the main process suppresses drain errors.
        // If one leaks through, ignore it to avoid prematurely finalizing.
        if (this.isStoppingSession) {
          logWarn(`${LOG_PREFIX} Ignoring error during stop`, { error });
          return;
        }
        logError(`${LOG_PREFIX} Received error from backend`, {
          severity: error.severity,
          code: error.code,
          message: error.message,
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
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Dictation stopped",
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
      voiceInput.onStatus((status) => {
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

    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const state = useVoiceRecordingStore.getState();
      if (
        state.status !== "arming" &&
        state.status !== "connecting" &&
        state.status !== "recording" &&
        state.status !== "paused" &&
        state.status !== "reconnecting"
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      // Arming is the pre-audio confirmation window. No session has begun
      // yet, so route abort through cancelArming() instead of stop() —
      // stop() would log "no active session" warnings and skip the cleanup
      // path that resets activeTarget back to null.
      if (state.status === "arming") {
        this.cancelArming();
        return;
      }
      this.pttActiveKeyCode = null;
      void this.stop("Dictation cancelled.", { preserveLiveText: true });
    };
    window.addEventListener("keydown", handleEscapeKey, { capture: true });
    this.unsubscribers.push(() =>
      window.removeEventListener("keydown", handleEscapeKey, { capture: true })
    );

    // Push-to-talk: a capture-phase keydown listener records the physical key
    // code of the voice shortcut press so the keyup listener can match it. The
    // actual `start()` call happens via the normal action dispatch chain
    // (`toggleFocusedPanel` / `toggleAssistant`), which calls `start()`
    // directly when `recordingMode === "push-to-talk"`. Recording only the
    // code here avoids racing the action dispatcher.
    const handlePttKeyDown = (e: KeyboardEvent) => {
      if (this.recordingMode !== "push-to-talk") return;
      if (e.repeat) return;
      const focusedCombo = keybindingService.getEffectiveCombo("voiceInput.toggle");
      const assistantCombo = keybindingService.getEffectiveCombo("voiceInput.toggleAssistant");
      const matches =
        (focusedCombo && keybindingService.matchesEvent(e, focusedCombo)) ||
        (assistantCombo && keybindingService.matchesEvent(e, assistantCombo));
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

    // A second press during the pre-audio arming window aborts back to idle.
    // No microphone has been opened yet, so there is nothing for stop() to
    // unwind — incrementing startRequestId via cancelArming() is enough to
    // make the in-flight start() bail at its next staleness check.
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
   * Abort an in-flight arming window before audio init begins. Bumping
   * startRequestId invalidates any pending start() so it bails at its next
   * staleness check; finishSession() returns the store to idle without
   * touching panel buffers (no transcript exists yet).
   */
  private cancelArming(): void {
    this.startRequestId++;
    useVoiceRecordingStore.getState().finishSession({ nextStatus: "idle" });
  }

  /**
   * Roll the store off the "arming" status when a `start()` call has set
   * an error and is about to return. Without this, the store would stay
   * `{ status: "arming", activeTarget: T }` indefinitely — the toolbar and
   * panel border would keep showing the pre-recording cue with no mic to
   * back it up.
   */
  private failArming(): void {
    useVoiceRecordingStore.getState().finishSession({ nextStatus: "error" });
  }

  async start(target: VoiceRecordingTarget): Promise<void> {
    this.initialize();
    const startRequestId = ++this.startRequestId;
    logDebug(`${LOG_PREFIX} start() called`, {
      panelId: target.panelId,
      generation: this.generation,
      startRequestId,
    });

    const isConfigured = await this.refreshConfiguration().catch(() => false);
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
        this.failArming();
      }
      return;
    }

    // Check and request OS-level microphone permission (macOS requires this
    // from the main process before getUserMedia will succeed in the renderer).
    // The IPC call is wrapped so a rejection (main-process crash, channel
    // teardown) doesn't leak past start() and leave the store armed forever.
    logDebug(`${LOG_PREFIX} Checking microphone permission`);
    let micStatus: Awaited<ReturnType<typeof window.electron.voiceInput.checkMicPermission>>;
    try {
      micStatus = await window.electron.voiceInput.checkMicPermission();
    } catch (err) {
      logError(`${LOG_PREFIX} checkMicPermission IPC rejected`, err);
      if (!this.isStartRequestStale(startRequestId)) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "fatal",
          code: "mic_permission_check_failed",
          message: "Could not check microphone permission. Try again.",
        });
        this.failArming();
      }
      return;
    }
    if (this.isStartRequestStale(startRequestId)) {
      return;
    }
    logDebug(`${LOG_PREFIX} Microphone permission status`, { micStatus });

    if (micStatus === "denied" || micStatus === "restricted") {
      const message = "Microphone permission denied. Enable it in System Settings and try again.";
      logError(`${LOG_PREFIX} Microphone permission denied at OS level`, { micStatus });
      useVoiceRecordingStore
        .getState()
        .setLastError({ severity: "fatal", code: "mic_permission_denied", message });
      useVoiceRecordingStore.getState().announce(message);
      this.failArming();
      safeFireAndForget(window.electron.voiceInput.openMicSettings(), {
        context: "Opening OS microphone settings",
      });
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
        logError(`${LOG_PREFIX} requestMicPermission IPC rejected`, err);
        if (!this.isStartRequestStale(startRequestId)) {
          useVoiceRecordingStore.getState().setLastError({
            severity: "fatal",
            code: "mic_permission_request_failed",
            message: "Could not request microphone permission. Try again.",
          });
          this.failArming();
        }
        return;
      }
      if (this.isStartRequestStale(startRequestId)) {
        return;
      }
      logDebug(`${LOG_PREFIX} Native microphone preflight result`, { canAttemptCapture });
      if (!canAttemptCapture) {
        const message = "Microphone permission denied. Enable it in System Settings and try again.";
        useVoiceRecordingStore
          .getState()
          .setLastError({ severity: "fatal", code: "mic_permission_denied", message });
        useVoiceRecordingStore.getState().announce(message);
        this.failArming();
        return;
      }
    }

    // Acquire microphone stream. On macOS the preflight above already settled
    // permission; on Windows/Linux this call IS the permission gate, so a denial
    // arrives here as NotAllowedError rather than from the preflight.
    logDebug(`${LOG_PREFIX} Requesting microphone access`);
    let stream: MediaStream;
    try {
      const constraints: MediaStreamConstraints = this.selectedDeviceId
        ? { audio: { deviceId: { ideal: this.selectedDeviceId } }, video: false }
        : { audio: true, video: false };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission denied. Enable it in System Settings and try again."
          : "Could not access the microphone.";
      logError(`${LOG_PREFIX} getUserMedia failed`, {
        name: error instanceof DOMException ? error.name : "unknown",
        message,
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
        this.failArming();
      }
      return;
    }

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
            label: track.label || "(no label)",
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
      if (this.selectedDeviceId) {
        const actualId = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
        if (actualId && actualId !== this.selectedDeviceId) {
          logWarn(`${LOG_PREFIX} Microphone device mismatch`, {
            requested: this.selectedDeviceId,
            actual: actualId,
          });
        }
      }
    } catch (err) {
      logDebug(`${LOG_PREFIX} Could not read microphone track settings`, { err });
    }

    if (this.isStartRequestStale(startRequestId)) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }

    // Only an actually-started session (open mic stream) needs to be torn
    // down here. `this.stream` is the canonical "audio is open" flag and is
    // independent of store status — using store.activeTarget here would
    // false-positive during the arming window (we seeded it ourselves) and
    // status alone would miss a cross-panel switch where the new "arming"
    // status has already overwritten the prior session's "recording".
    if (this.stream) {
      logDebug(`${LOG_PREFIX} Stopping existing session before starting new one`);
      await this.stop(undefined, {
        preserveLiveText: true,
        announce: false,
        preservePendingStart: true,
        skipCorrection: true,
      });
      if (this.isStartRequestStale(startRequestId)) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
    }

    const generation = ++this.generation;
    logDebug(`${LOG_PREFIX} Beginning session`, { generation });
    this.pauseStartedAt = 0;
    this.totalPausedMs = 0;
    this.clearPauseTimeout();
    useVoiceRecordingStore.getState().beginSession(target);

    this.stream = stream;

    // Start audio capture IMMEDIATELY — don't wait for WebSocket.
    // Chunks are buffered in the main process until the connection is ready.
    logDebug(`${LOG_PREFIX} Creating AudioContext (24kHz) — eager capture`);
    const audioContext = new AudioContext({ sampleRate: 24000 });
    this.audioContext = audioContext;
    logInfo(`${LOG_PREFIX} AudioContext created`, {
      requestedSampleRate: 24000,
      actualSampleRate: audioContext.sampleRate,
      state: audioContext.state,
      baseLatency: audioContext.baseLatency,
    });
    const captureResources: {
      keepAliveOscillator?: OscillatorNode | null;
      keepAliveGain?: GainNode | null;
      workletNode?: AudioWorkletNode | null;
    } = {};

    if (audioContext.state === "suspended") {
      logDebug(`${LOG_PREFIX} AudioContext suspended, resuming`);
      await audioContext.resume();
    }

    if (this.generation !== generation || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Generation mismatch after AudioContext setup`);
      await this.cleanupCaptureResources({
        audioContext,
        keepAliveGain: captureResources.keepAliveGain,
        keepAliveOscillator: captureResources.keepAliveOscillator,
        stream,
      });
      return;
    }

    // Keep the AudioContext in "running" state while backgrounded. Chromium
    // suspends capture-only contexts (no output to destination) when the window
    // loses focus. Connecting a silent oscillator to the destination tricks the
    // engine into treating the context as audible so AudioWorkletNode keeps firing.
    const keepAliveGain = audioContext.createGain();
    keepAliveGain.gain.value = 0;
    const keepAliveOscillator = audioContext.createOscillator();
    keepAliveOscillator.connect(keepAliveGain);
    keepAliveGain.connect(audioContext.destination);
    keepAliveOscillator.start();
    captureResources.keepAliveGain = keepAliveGain;
    captureResources.keepAliveOscillator = keepAliveOscillator;
    this.keepAliveOscillator = keepAliveOscillator;
    this.keepAliveGain = keepAliveGain;

    logDebug(`${LOG_PREFIX} Loading pcm-processor worklet`);
    try {
      await audioContext.audioWorklet.addModule("/pcm-processor.js");
      logDebug(`${LOG_PREFIX} pcm-processor worklet loaded`);
    } catch (err) {
      if (this.generation !== generation || this.isStartRequestStale(startRequestId)) return;
      logError(`${LOG_PREFIX} Failed to load pcm-processor worklet`, err);
      useVoiceRecordingStore.getState().setLastError({
        severity: "fatal",
        code: "renderer_error",
        message: "Failed to load the audio processor.",
      });
      await this.stop(undefined, { nextStatus: "error", announce: false });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to initialize.");
      return;
    }

    if (this.generation !== generation || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Generation mismatch after worklet load`);
      await this.cleanupCaptureResources({
        audioContext,
        keepAliveGain: captureResources.keepAliveGain,
        keepAliveOscillator: captureResources.keepAliveOscillator,
        stream,
      });
      return;
    }

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    captureResources.workletNode = workletNode;
    this.workletNode = workletNode;

    this.sessionPeakRms = 0;
    this.sessionRmsSum = 0;
    this.sessionChunkCount = 0;
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.generation !== generation) return;
      this.sessionChunkCount++;
      const chunkCount = this.sessionChunkCount;

      // Compute RMS audio level from PCM16 samples for the UI glow.
      const samples = new Int16Array(event.data);
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const n = samples[i]! / 32768;
        sumSq += n * n;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      this.sessionPeakRms = Math.max(this.sessionPeakRms, rms);
      this.sessionRmsSum += rms;
      this.pendingLevel = Math.min(1, rms * 6);

      if (chunkCount <= 3 || chunkCount % 100 === 0) {
        // Include RMS stats so a captured log can distinguish "mic was silent"
        // (peak/avg near 0) from "user spoke but no transcription came back".
        logDebug(`${LOG_PREFIX} Audio chunk #${chunkCount}`, {
          bytes: event.data.byteLength,
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

      // Chunks sent during "connecting" are buffered in the main process.
      window.electron.voiceInput.sendAudioChunk(event.data);
    };

    source.connect(workletNode);

    // Start the timer and announce immediately — user is already speaking.
    this.sessionStartedAt = Date.now();
    this.startElapsedTimer();
    logDebug(`${LOG_PREFIX} Eager audio capture started, connecting to backend...`);
    useVoiceRecordingStore
      .getState()
      .announce(`Dictation started in ${formatTargetLabel(target)}.`);

    // Connect in parallel — audio is already flowing.
    logDebug(`${LOG_PREFIX} Calling voiceInput.start() IPC`);
    const result = await window.electron.voiceInput.start();
    logDebug(`${LOG_PREFIX} voiceInput.start() returned`, {
      ok: result.ok,
      error: !result.ok ? result.error : undefined,
    });

    if (this.generation !== generation || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Generation mismatch after IPC start`);
      await this.cleanupCaptureResources({
        audioContext,
        keepAliveGain: captureResources.keepAliveGain,
        keepAliveOscillator: captureResources.keepAliveOscillator,
        stream,
        workletNode: captureResources.workletNode,
      });
      return;
    }

    if (!result.ok) {
      logError(`${LOG_PREFIX} Backend start failed`, { error: result.error });
      useVoiceRecordingStore
        .getState()
        .setLastError({ severity: "fatal", code: "backend_start_failed", message: result.error });
      await this.cleanupAudioCapture();
      useVoiceRecordingStore.getState().finishSession({ nextStatus: "error" });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to start.");
      return;
    }

    if (this.generation !== generation || this.isStartRequestStale(startRequestId)) {
      logWarn(`${LOG_PREFIX} Generation mismatch after IPC start (late check)`);
      return;
    }

    // Backend is connected — status transitions to "recording" via the onStatus listener.
    logDebug(`${LOG_PREFIX} Recording started successfully`);
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
        this.startRequestId++;
      }

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
      const stopGeneration = this.generation;

      if (!skipRemoteStop) {
        // Graceful stop: the IPC handler drains pending transcriptions and flushes
        // the paragraph buffer before resolving. Keep activeTarget alive so late
        // transcription and correction events are still applied to the correct panel.
        logDebug(`${LOG_PREFIX} Sending remote stop (graceful drain)`);
        this.isStoppingSession = true;
        useVoiceRecordingStore.getState().setStatus("finishing");
        await window.electron.voiceInput.stop().catch(() => null);
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

      // Whole-passage AI cleanup runs after a deliberate, graceful stop only —
      // not on error, cancel-to-restart, or backend-driven teardown. Fire and
      // forget: the decoration shows progress, and stop() returns immediately.
      if (!skipRemoteStop && nextStatus === "idle" && !options.skipCorrection && stoppedTarget) {
        if (correctionEnabled) {
          void this.runCorrection(stoppedTarget, stopGeneration);
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
   * dictated text to gpt-5.6-luna, and swaps in the cleaned result if the region
   * is still where we left it. Best-effort — any failure leaves the raw text.
   */
  private async runCorrection(target: VoiceRecordingTarget, stopGeneration: number): Promise<void> {
    const { panelId, projectId } = target;
    const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
    const sessionStart = buffer?.sessionDraftStart ?? -1;
    if (sessionStart < 0) return;

    const inputStore = useTerminalInputStore.getState();
    const draftBefore = inputStore.getDraftInput(panelId, projectId);
    const rawText = draftBefore.slice(sessionStart);
    if (!rawText.trim()) return;

    // Seed the learning baseline with the raw transcription synchronously, before
    // the async correction call. If a new session starts on a DIFFERENT panel
    // while this runs, the end-of-function stale check skips the corrected
    // overwrite — but this panel still keeps a usable baseline (#9749).
    useVoiceRecordingStore.getState().setSessionCorrectedText(panelId, rawText);

    logDebug(`${LOG_PREFIX} Running whole-passage correction`, {
      panelId,
      rawLength: rawText.length,
    });

    // Show the dotted-underline "correcting" decoration over the dictated range.
    useVoiceRecordingStore
      .getState()
      .setCorrectionRange(panelId, { from: sessionStart, to: draftBefore.length });
    inputStore.bumpExternalDraftRevision();

    let correctedText = rawText;
    try {
      const result = await window.electron.voiceInput.correct({ rawText });
      if (result.action === "replace" && result.correctedText.trim()) {
        correctedText = result.correctedText;
      }
    } catch (error) {
      logWarn(`${LOG_PREFIX} Correction request failed, keeping raw text`, { error });
    } finally {
      useVoiceRecordingStore.getState().setCorrectionRange(panelId, null);
    }

    // A new session started for this panel while correction was in flight —
    // don't clobber it.
    if (this.generation !== stopGeneration) {
      logDebug(`${LOG_PREFIX} Correction result stale (new session), discarding`);
      inputStore.bumpExternalDraftRevision();
      return;
    }

    if (correctedText !== rawText) {
      const draftNow = inputStore.getDraftInput(panelId, projectId);
      // Apply only if the dictated region is still intact and unambiguous —
      // skip rather than guess if the user edited it mid-correction.
      let start = -1;
      if (draftNow.slice(sessionStart, sessionStart + rawText.length) === rawText) {
        start = sessionStart;
      } else {
        const lastIdx = draftNow.lastIndexOf(rawText);
        if (lastIdx >= 0 && draftNow.indexOf(rawText) === lastIdx) {
          start = lastIdx;
        }
      }
      if (start >= 0) {
        const before = draftNow.slice(0, start);
        const after = draftNow.slice(start + rawText.length);
        inputStore.setDraftInput(panelId, before + correctedText + after, projectId);
        logDebug(`${LOG_PREFIX} Applied correction`, {
          panelId,
          rawLength: rawText.length,
          correctedLength: correctedText.length,
        });
      } else {
        logDebug(`${LOG_PREFIX} Skipping correction — dictated text changed during cleanup`);
      }
    }

    // Record the settled dictated text as the learning baseline. Manual edits
    // the user makes before sending are diffed against this to detect words
    // worth suggesting for the custom dictionary (#9749).
    useVoiceRecordingStore.getState().setSessionCorrectedText(panelId, correctedText);

    inputStore.bumpExternalDraftRevision();
  }

  async toggleFocusedPanel(): Promise<void> {
    this.initialize();

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
        .announce("Focus a terminal input before starting dictation.");
      return;
    }

    await this.startOrToggle(target);
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

  private getFocusedPanelTarget(): VoiceRecordingTarget | null {
    const terminalState = usePanelStore.getState();
    const panelId = terminalState.focusedId;
    if (!panelId) return null;

    const foundPanel = terminalState.panelsById[panelId];
    if (!foundPanel || foundPanel.location === "trash") return null;
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
    const terminalId = useHelpPanelStore.getState().terminalId;
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

  private clearTimers(): void {
    this.clearElapsedTimer();
    this.clearPauseTimeout();
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
    state.announce("Dictation resumed.");
    this.startElapsedTimer();
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
    this.startRequestId++;
    // Vite HMR disposes and re-evaluates this module; the old singleton's
    // timers must be cleared or they fire against the new singleton's state.
    this.clearPauseTimeout();
    this.clearElapsedTimer();
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.initialized = false;
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

    if (resources.audioContext) {
      await resources.audioContext.close().catch(() => {});
      if (this.audioContext === resources.audioContext) {
        this.audioContext = null;
      }
    }

    if (resources.stream) {
      for (const track of resources.stream.getTracks()) {
        track.stop();
      }
      if (this.stream === resources.stream) {
        this.stream = null;
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
