import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { isActiveVoiceSession } from "@shared/types";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { PendingCorrection } from "@/store/voiceRecordingStore";

const LOG_PREFIX = "[VoiceRecording]";
const CORRECTION_MATCH_RADIUS = 32;

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

function collectOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];

  const occurrences: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= haystack.length) {
    const idx = haystack.indexOf(needle, searchFrom);
    if (idx === -1) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  return occurrences;
}

function findCorrectionRange(
  draft: string,
  pending: Pick<PendingCorrection, "segmentStart" | "rawText">
): { start: number; end: number } | null {
  const { segmentStart, rawText } = pending;
  if (!rawText) return null;

  const exactEnd = segmentStart + rawText.length;
  if (
    segmentStart >= 0 &&
    exactEnd <= draft.length &&
    draft.slice(segmentStart, exactEnd) === rawText
  ) {
    return { start: segmentStart, end: exactEnd };
  }

  const occurrences = collectOccurrences(draft, rawText);
  if (occurrences.length === 0) return null;

  const nearby =
    segmentStart >= 0
      ? occurrences.filter((idx) => Math.abs(idx - segmentStart) <= CORRECTION_MATCH_RADIUS)
      : [];
  if (nearby.length === 1) {
    const start = nearby[0]!;
    return { start, end: start + rawText.length };
  }

  if (occurrences.length === 1) {
    const start = occurrences[0]!;
    return { start, end: start + rawText.length };
  }

  return null;
}

function resolveQueuedCorrectionStart(draft: string, rawText: string): number {
  if (!rawText) return -1;
  if (draft.endsWith(rawText)) {
    return draft.length - rawText.length;
  }

  const lastMatch = draft.lastIndexOf(rawText);
  if (lastMatch >= 0) {
    return lastMatch;
  }

  const occurrences = collectOccurrences(draft, rawText);
  return occurrences.length === 1 ? occurrences[0]! : -1;
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
  private unsubscribers: Array<() => void> = [];
  private isStoppingSession = false;
  private stopPromise: Promise<void> | null = null;
  private levelRaf: number | null = null;
  private pendingLevel = 0;

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
            // Snapshot where dictated text actually begins, including any separator
            // inserted between existing draft text and the first dictated token.
            useVoiceRecordingStore
              .getState()
              .setDraftLengthAtSegmentStart(target.panelId, insertStart);
            // Track paragraph start for the first utterance in a new paragraph.
            useVoiceRecordingStore.getState().setActiveParagraphStart(target.panelId, insertStart);
            // First delta of a new utterance — use appendVoiceText for separator logic.
            useTerminalInputStore
              .getState()
              .appendVoiceText(target.panelId, delta, target.projectId);
          } else {
            // Subsequent deltas — append raw to keep length in sync with liveText.
            const store = useTerminalInputStore.getState();
            const existing = store.getDraftInput(target.panelId, target.projectId);
            store.setDraftInput(target.panelId, existing + delta, target.projectId);
            store.bumpVoiceDraftRevision();
          }
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
          if (segmentStart >= 0 || text.trim()) {
            const inputStore = useTerminalInputStore.getState();
            const draft = inputStore.getDraftInput(panelId, projectId);
            // Slice back to where this segment started and replace with final transcript.
            const base = segmentStart >= 0 ? draft.slice(0, segmentStart) : draft;
            const { separator, insertStart } = getVoiceInsertMetadata(base);
            if ((buffer?.activeParagraphStart ?? -1) < 0 && text.trim()) {
              useVoiceRecordingStore.getState().setActiveParagraphStart(panelId, insertStart);
            }
            const finalText = text.trim();
            inputStore.setDraftInput(panelId, base + separator + finalText, projectId);
            inputStore.bumpVoiceDraftRevision();
          }
        }
        useVoiceRecordingStore.getState().completeSegment(text);
      })
    );

    this.unsubscribers.push(
      voiceInput.onCorrectionQueued(({ correctionId, rawText }) => {
        logDebug(`${LOG_PREFIX} Received correction queued`, {
          correctionId,
          length: rawText.length,
        });

        const voiceState = useVoiceRecordingStore.getState();
        const currentTarget = voiceState.activeTarget;
        if (!currentTarget || !rawText) return;

        const { panelId, projectId } = currentTarget;
        const buffer = voiceState.panelBuffers[panelId];
        if (buffer?.pendingCorrections.some((pending) => pending.id === correctionId)) {
          return;
        }
        const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
        const preferredStart = buffer?.sessionDraftStart ?? -1;
        const correctionStart =
          preferredStart >= 0 &&
          draft.slice(preferredStart, preferredStart + rawText.length) === rawText
            ? preferredStart
            : resolveQueuedCorrectionStart(draft, rawText);
        if (correctionStart < 0) {
          logDebug(`${LOG_PREFIX} Skipping pending correction registration — text not found`, {
            correctionId,
          });
          return;
        }

        useVoiceRecordingStore
          .getState()
          .addPendingCorrection(panelId, correctionId, correctionStart, rawText);
      })
    );

    this.unsubscribers.push(
      voiceInput.onCorrectionReplace(({ correctionId, correctedText }) => {
        logDebug(`${LOG_PREFIX} Received correction replace`, { correctionId });
        const voiceState = useVoiceRecordingStore.getState();

        // Find the panel that owns this correction ID.
        let panelId: string | undefined;
        let projectId: string | undefined;
        let pending: PendingCorrection | undefined;

        for (const [id, buffer] of Object.entries(voiceState.panelBuffers)) {
          const found = buffer.pendingCorrections.find((p) => p.id === correctionId);
          if (found) {
            panelId = id;
            projectId = buffer.projectId;
            pending = found;
            break;
          }
        }

        if (!panelId || !pending) return;

        if (correctedText !== pending.rawText) {
          const inputStore = useTerminalInputStore.getState();
          const draft = inputStore.getDraftInput(panelId, projectId);
          const matchedRange = findCorrectionRange(draft, pending);

          // Apply the correction only if the raw text still exists in an unambiguous
          // location. If the user edited that region, skip rather than guessing.
          if (matchedRange) {
            const before = draft.slice(0, matchedRange.start);
            const after = draft.slice(matchedRange.end);
            inputStore.setDraftInput(panelId, before + correctedText + after, projectId);
            inputStore.bumpVoiceDraftRevision();

            const lengthDelta = correctedText.length - pending.rawText.length;
            if (lengthDelta !== 0) {
              useVoiceRecordingStore
                .getState()
                .rebasePendingCorrections(panelId, pending.segmentStart, lengthDelta);
            }
          } else {
            logDebug(`${LOG_PREFIX} Skipping correction — text at tracked position has changed`, {
              correctionId,
              segmentStart: pending.segmentStart,
            });
          }
        }

        useVoiceRecordingStore.getState().resolvePendingCorrection(panelId, correctionId);
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
          inputStore.bumpVoiceDraftRevision();
        } else {
          logDebug(`${LOG_PREFIX} File token description not found in draft, discarding`, {
            description,
            replacement,
          });
        }
      })
    );

    this.unsubscribers.push(
      voiceInput.onParagraphBoundary(({ rawText, correctionId }) => {
        logDebug(`${LOG_PREFIX} Received paragraph boundary from Deepgram`, {
          rawText,
          correctionId,
        });
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
        inputStore.bumpVoiceDraftRevision();

        voiceState.resetParagraphState(panelId);
      })
    );

    this.unsubscribers.push(
      voiceInput.onError((error) => {
        // During graceful stop, the main process suppresses drain errors.
        // If one leaks through, ignore it to avoid prematurely finalizing.
        if (this.isStoppingSession) {
          logWarn(`${LOG_PREFIX} Ignoring error during stop`, { error });
          return;
        }
        logError(`${LOG_PREFIX} Received error from backend`, { error });
        useVoiceRecordingStore.getState().setError(error);
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
          useVoiceRecordingStore.getState().setStatus(status);
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
        const activeTarget = useVoiceRecordingStore.getState().activeTarget;
        if (!activeTarget) return;

        // If the recording target belongs to a different project than the
        // one currently loaded, the panel's absence is expected.
        const currentProjectId = useProjectStore.getState().currentProject?.id;
        if (activeTarget.projectId && currentProjectId !== activeTarget.projectId) return;

        const found = state.panelsById[activeTarget.panelId];
        const panel = found && found.location !== "trash" ? found : undefined;

        if (!panel) {
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
      if (state.status !== "connecting" && state.status !== "recording") return;
      e.preventDefault();
      e.stopPropagation();
      void this.stop("Dictation cancelled.", { preserveLiveText: true });
    };
    window.addEventListener("keydown", handleEscapeKey, { capture: true });
    this.unsubscribers.push(() =>
      window.removeEventListener("keydown", handleEscapeKey, { capture: true })
    );

    void this.refreshConfiguration();
  }

  async refreshConfiguration(): Promise<boolean> {
    const settings = await window.electron.voiceInput.getSettings();
    const isConfigured = settings.enabled && !!settings.deepgramApiKey;
    logDebug(`${LOG_PREFIX} refreshConfiguration`, {
      enabled: settings.enabled,
      hasApiKey: !!settings.deepgramApiKey,
      isConfigured,
      correctionEnabled: settings.correctionEnabled,
    });
    // Keep correction state in sync for live-segment dimming
    useVoiceRecordingStore
      .getState()
      .setCorrectionEnabled(!!(settings.correctionEnabled && settings.correctionApiKey));
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

    if (isActiveTarget && isActive) {
      await this.stop("Dictation stopped.", { preserveLiveText: true });
      return;
    }

    await this.start(target);
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
        useVoiceRecordingStore.getState().setError("Voice input is not configured.");
        useVoiceRecordingStore
          .getState()
          .announce("Voice dictation is not configured. Open Voice settings to continue.");
      }
      return;
    }

    // Check and request OS-level microphone permission (macOS requires this
    // from the main process before getUserMedia will succeed in the renderer).
    logDebug(`${LOG_PREFIX} Checking microphone permission`);
    const micStatus = await window.electron.voiceInput.checkMicPermission();
    if (this.isStartRequestStale(startRequestId)) {
      return;
    }
    logDebug(`${LOG_PREFIX} Microphone permission status`, { micStatus });

    if (micStatus === "denied" || micStatus === "restricted") {
      const message = "Microphone permission denied. Enable it in System Settings and try again.";
      logError(`${LOG_PREFIX} Microphone permission denied at OS level`, { micStatus });
      useVoiceRecordingStore.getState().setError(message);
      useVoiceRecordingStore.getState().announce(message);
      safeFireAndForget(window.electron.voiceInput.openMicSettings(), {
        context: "Opening OS microphone settings",
      });
      return;
    }

    if (micStatus === "not-determined") {
      logDebug(`${LOG_PREFIX} Requesting OS microphone permission`);
      const granted = await window.electron.voiceInput.requestMicPermission();
      if (this.isStartRequestStale(startRequestId)) {
        return;
      }
      logDebug(`${LOG_PREFIX} OS microphone permission result`, { granted });
      if (!granted) {
        const message = "Microphone permission denied. Enable it in System Settings and try again.";
        useVoiceRecordingStore.getState().setError(message);
        useVoiceRecordingStore.getState().announce(message);
        return;
      }
    }

    // Acquire microphone stream — permission should be granted at this point.
    logDebug(`${LOG_PREFIX} Requesting microphone access`);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      logDebug(`${LOG_PREFIX} Microphone access granted`, {
        tracks: stream.getAudioTracks().length,
      });
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission denied. Enable it in System Settings and try again."
          : "Could not access the microphone.";
      logError(`${LOG_PREFIX} getUserMedia failed`, {
        name: error instanceof DOMException ? error.name : "unknown",
        message,
      });
      useVoiceRecordingStore.getState().setError(message);
      useVoiceRecordingStore.getState().announce(message);
      return;
    }

    if (this.isStartRequestStale(startRequestId)) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return;
    }

    if (useVoiceRecordingStore.getState().activeTarget) {
      logDebug(`${LOG_PREFIX} Stopping existing session before starting new one`);
      await this.stop(undefined, {
        preserveLiveText: true,
        announce: false,
        preservePendingStart: true,
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
    useVoiceRecordingStore.getState().beginSession(target);

    this.stream = stream;

    // Start audio capture IMMEDIATELY — don't wait for WebSocket.
    // Chunks are buffered in the main process until the connection is ready.
    logDebug(`${LOG_PREFIX} Creating AudioContext (24kHz) — eager capture`);
    const audioContext = new AudioContext({ sampleRate: 24000 });
    this.audioContext = audioContext;
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
      useVoiceRecordingStore.getState().setError("Failed to load the audio processor.");
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

    let chunkCount = 0;
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.generation !== generation) return;
      chunkCount++;
      if (chunkCount <= 3 || chunkCount % 100 === 0) {
        logDebug(`${LOG_PREFIX} Audio chunk #${chunkCount}`, { bytes: event.data.byteLength });
      }

      // Compute RMS audio level from PCM16 samples for the UI glow.
      const samples = new Int16Array(event.data);
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const n = samples[i]! / 32768;
        sumSq += n * n;
      }
      const rms = Math.sqrt(sumSq / samples.length);
      this.pendingLevel = Math.min(1, rms * 6);
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

    // Connect to Deepgram in parallel — audio is already flowing.
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
      useVoiceRecordingStore.getState().setError(result.error);
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

      if (!options.preservePendingStart) {
        this.startRequestId++;
      }

      const storeState = useVoiceRecordingStore.getState();
      const hasSession =
        storeState.activeTarget !== null || isActiveVoiceSession(storeState.status);

      logDebug(`${LOG_PREFIX} stop() called`, {
        announcement,
        hasSession,
        skipRemoteStop,
        nextStatus,
        currentStatus: storeState.status,
        hasActiveTarget: !!storeState.activeTarget,
      });

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
        await window.electron.voiceInput.stop().catch(() => null);
      }

      if (hasSession) {
        // Flush any remaining delta text (liveText) to the draft store before
        // finishSession clears it — this handles the case where recording stops
        // mid-utterance with un-committed delta text in the editor.
        if (preserveLiveText) {
          const currentTarget = useVoiceRecordingStore.getState().activeTarget;
          if (currentTarget) {
            const { panelId } = currentTarget;
            const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
            const remaining = buffer?.liveText?.trim();
            if (remaining) {
              useTerminalInputStore.getState().bumpVoiceDraftRevision();
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
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  async toggleFocusedPanel(): Promise<void> {
    this.initialize();
    const target = this.getFocusedPanelTarget();
    if (!target) {
      useVoiceRecordingStore.getState().setError("No focused terminal is available for dictation.");
      useVoiceRecordingStore
        .getState()
        .announce("Focus a terminal input before starting dictation.");
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
    useVoiceRecordingStore.getState().setElapsedSeconds(0);
    this.elapsedTimer = setInterval(() => {
      useVoiceRecordingStore
        .getState()
        .setElapsedSeconds(Math.floor((Date.now() - this.sessionStartedAt) / 1000));
    }, 1000);
  }

  private clearElapsedTimer(): void {
    if (!this.elapsedTimer) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }

  private clearTimers(): void {
    this.clearElapsedTimer();
    useVoiceRecordingStore.getState().setElapsedSeconds(0);
  }

  destroy(): void {
    this.startRequestId++;
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
