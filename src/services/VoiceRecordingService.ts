import { useProjectStore } from "@/store/projectStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore, type VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { VOICE_INPUT_SETTINGS_CHANGED_EVENT } from "@/lib/voiceInputSettingsEvents";
import { logDebug, logWarn, logError } from "@/utils/logger";

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

class VoiceRecordingService {
  private initialized = false;
  private generation = 0;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private keepAliveOscillator: OscillatorNode | null = null;
  private keepAliveGain: GainNode | null = null;
  private stream: MediaStream | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private sessionStartedAt = 0;
  private unsubscribers: Array<() => void> = [];
  private isStoppingSession = false;
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
            // Snapshot draft length before we start appending deltas for this segment.
            const draftLen = useTerminalInputStore
              .getState()
              .getDraftInput(target.panelId, target.projectId).length;
            useVoiceRecordingStore
              .getState()
              .setDraftLengthAtSegmentStart(target.panelId, draftLen);
            // Track paragraph start for the first utterance in a new paragraph.
            useVoiceRecordingStore.getState().setActiveParagraphStart(target.panelId, draftLen);
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
            const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
            const finalText = text.trim();
            inputStore.setDraftInput(panelId, base + separator + finalText, projectId);
            inputStore.bumpVoiceDraftRevision();
            // Correction is batched at paragraph level — no per-utterance pending entry.
          }
        }
        useVoiceRecordingStore.getState().completeSegment(text);
      })
    );

    this.unsubscribers.push(
      voiceInput.onCorrectionReplace(({ rawText, correctedText }) => {
        logDebug(`${LOG_PREFIX} Received correction replace`, {
          rawText,
          correctedText,
          changed: rawText !== correctedText,
        });
        const voiceState = useVoiceRecordingStore.getState();
        // Find the panel that has this pending correction.
        // Check active target first, then fall back to scanning all buffers.
        let panelId = voiceState.activeTarget?.panelId;
        let projectId = voiceState.activeTarget?.projectId;

        if (panelId) {
          const buffer = voiceState.panelBuffers[panelId];
          if (!buffer?.pendingCorrections.some((p) => p.rawText === rawText)) {
            panelId = undefined;
          }
        }

        if (!panelId) {
          for (const [id, buffer] of Object.entries(voiceState.panelBuffers)) {
            if (buffer.pendingCorrections.some((p) => p.rawText === rawText)) {
              panelId = id;
              projectId = buffer.projectId;
              break;
            }
          }
        }

        if (!panelId) return;

        if (rawText !== correctedText) {
          const inputStore = useTerminalInputStore.getState();
          const draft = inputStore.getDraftInput(panelId, projectId);
          // Find the raw text in the draft by scanning from the expected offset.
          const pending = voiceState.panelBuffers[panelId]?.pendingCorrections.find(
            (p) => p.rawText === rawText
          );
          if (pending) {
            // Locate the raw text — it may have shifted due to earlier corrections.
            const idx = draft.indexOf(rawText, Math.max(0, pending.segmentStart - 20));
            if (idx >= 0) {
              const before = draft.slice(0, idx);
              const after = draft.slice(idx + rawText.length);
              inputStore.setDraftInput(panelId, before + correctedText + after, projectId);
              inputStore.bumpVoiceDraftRevision();
            }
          }
        }

        useVoiceRecordingStore.getState().resolvePendingCorrection(panelId, rawText);
      })
    );

    this.unsubscribers.push(
      voiceInput.onParagraphBoundary(({ rawText }) => {
        logDebug(`${LOG_PREFIX} Received paragraph boundary from Deepgram`, { rawText });
        const voiceState = useVoiceRecordingStore.getState();
        const currentTarget = voiceState.activeTarget;
        if (!currentTarget) return;

        const { panelId, projectId } = currentTarget;
        const buffer = voiceState.panelBuffers[panelId];
        if (!buffer) return;

        // Use the rawText from the main process (what it actually flushed),
        // which is authoritative — avoids reconstructing from renderer-local state.
        const paragraphStart = buffer.activeParagraphStart ?? -1;
        if (rawText && paragraphStart >= 0 && voiceState.correctionEnabled) {
          voiceState.addPendingCorrection(panelId, paragraphStart, rawText);
        }

        // Insert a newline to visually separate paragraphs and reset paragraph state.
        const inputStore = useTerminalInputStore.getState();
        const draft = inputStore.getDraftInput(panelId, projectId);
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
      useTerminalStore.subscribe((state) => {
        const activeTarget = useVoiceRecordingStore.getState().activeTarget;
        if (!activeTarget) return;

        // Don't stop recording during a project switch — terminals are
        // temporarily cleared and will be rehydrated in the new project.
        if (useProjectStore.getState().isSwitching) return;

        // If the recording target belongs to a different project than the
        // one currently loaded, the panel's absence is expected.
        const currentProjectId = useProjectStore.getState().currentProject?.id;
        if (activeTarget.projectId && currentProjectId !== activeTarget.projectId) return;

        const panel = state.terminals.find(
          (terminal) => terminal.id === activeTarget.panelId && terminal.location !== "trash"
        );

        if (!panel) {
          void this.stop("Dictation stopped because its panel was closed.", {
            preserveLiveText: true,
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
    const isActive =
      state.status === "connecting" || state.status === "recording" || state.status === "finishing";

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
    logDebug(`${LOG_PREFIX} start() called`, {
      panelId: target.panelId,
      generation: this.generation,
    });

    const isConfigured = await this.refreshConfiguration().catch(() => false);
    if (!isConfigured) {
      logWarn(`${LOG_PREFIX} Not configured, aborting start`);
      useVoiceRecordingStore.getState().setError("Voice input is not configured.");
      useVoiceRecordingStore
        .getState()
        .announce("Voice dictation is not configured. Open Voice settings to continue.");
      return;
    }

    // Check and request OS-level microphone permission (macOS requires this
    // from the main process before getUserMedia will succeed in the renderer).
    logDebug(`${LOG_PREFIX} Checking microphone permission`);
    const micStatus = await window.electron.voiceInput.checkMicPermission();
    logDebug(`${LOG_PREFIX} Microphone permission status`, { micStatus });

    if (micStatus === "denied" || micStatus === "restricted") {
      const message = "Microphone permission denied. Enable it in System Settings and try again.";
      logError(`${LOG_PREFIX} Microphone permission denied at OS level`, { micStatus });
      useVoiceRecordingStore.getState().setError(message);
      useVoiceRecordingStore.getState().announce(message);
      void window.electron.voiceInput.openMicSettings();
      return;
    }

    if (micStatus === "not-determined") {
      logDebug(`${LOG_PREFIX} Requesting OS microphone permission`);
      const granted = await window.electron.voiceInput.requestMicPermission();
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

    if (useVoiceRecordingStore.getState().activeTarget) {
      logDebug(`${LOG_PREFIX} Stopping existing session before starting new one`);
      await this.stop(undefined, { preserveLiveText: true, announce: false });
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

    if (audioContext.state === "suspended") {
      logDebug(`${LOG_PREFIX} AudioContext suspended, resuming`);
      await audioContext.resume();
    }

    if (this.generation !== generation) {
      logWarn(`${LOG_PREFIX} Generation mismatch after AudioContext setup`);
      await this.cleanupAudioCapture();
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
    this.keepAliveOscillator = keepAliveOscillator;
    this.keepAliveGain = keepAliveGain;

    logDebug(`${LOG_PREFIX} Loading pcm-processor worklet`);
    try {
      await audioContext.audioWorklet.addModule("/pcm-processor.js");
      logDebug(`${LOG_PREFIX} pcm-processor worklet loaded`);
    } catch (err) {
      if (this.generation !== generation) return;
      logError(`${LOG_PREFIX} Failed to load pcm-processor worklet`, err);
      useVoiceRecordingStore.getState().setError("Failed to load the audio processor.");
      await this.stop(undefined, { nextStatus: "error", announce: false });
      useVoiceRecordingStore.getState().announce("Voice dictation failed to initialize.");
      return;
    }

    if (this.generation !== generation) {
      logWarn(`${LOG_PREFIX} Generation mismatch after worklet load`);
      await this.cleanupAudioCapture();
      return;
    }

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
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
        const n = samples[i] / 32768;
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

    if (this.generation !== generation) {
      logWarn(`${LOG_PREFIX} Generation mismatch after IPC start`);
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

    if (this.generation !== generation) {
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
    } = {}
  ): Promise<void> {
    this.initialize();
    const { skipRemoteStop = false, preserveLiveText = true, nextStatus = "idle" } = options;
    const shouldAnnounce = options.announce ?? true;

    const storeState = useVoiceRecordingStore.getState();
    const hasSession =
      storeState.activeTarget !== null ||
      storeState.status === "connecting" ||
      storeState.status === "recording" ||
      storeState.status === "finishing";

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
      const stopResult = await window.electron.voiceInput.stop().catch(() => null);

      // If the backend flushed a paragraph, register a pending correction so the
      // UI shows it as gray until CORRECTION_REPLACE arrives (which may be after
      // finishSession clears activeTarget — the fallback scan in onCorrectionReplace
      // handles that case).
      if (stopResult?.rawText) {
        const currentTarget = useVoiceRecordingStore.getState().activeTarget;
        // Only add pending correction when correction is enabled — otherwise
        // no CORRECTION_REPLACE will arrive and the text stays dimmed permanently.
        if (currentTarget && useVoiceRecordingStore.getState().correctionEnabled) {
          const buffer = useVoiceRecordingStore.getState().panelBuffers[currentTarget.panelId];
          const paragraphStart = buffer?.activeParagraphStart ?? -1;
          if (paragraphStart >= 0) {
            useVoiceRecordingStore
              .getState()
              .addPendingCorrection(currentTarget.panelId, paragraphStart, stopResult.rawText);
          }
        }
      }
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
          const remaining = buffer?.liveText.trim();
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

    const panel = useTerminalStore
      .getState()
      .terminals.find(
        (terminal) => terminal.id === target.panelId && terminal.location !== "trash"
      );
    if (!panel) {
      return false;
    }

    useTerminalStore.getState().activateTerminal(panel.id);
    return true;
  }

  private getFocusedPanelTarget(): VoiceRecordingTarget | null {
    const terminalState = useTerminalStore.getState();
    const panelId = terminalState.focusedId;
    if (!panelId) return null;

    const panel = terminalState.terminals.find(
      (terminal) => terminal.id === panelId && terminal.location !== "trash"
    );
    if (!panel) return null;

    const currentProject = useProjectStore.getState().currentProject;
    const worktree = panel.worktreeId
      ? useWorktreeDataStore.getState().worktrees.get(panel.worktreeId)
      : undefined;

    return {
      panelId: panel.id,
      panelTitle: panel.title,
      projectId: currentProject?.id,
      projectName: currentProject?.name,
      worktreeId: panel.worktreeId,
      worktreeLabel: worktree?.branch || worktree?.name,
    };
  }

  private async waitForPanel(panelId: string, timeoutMs = 5000): Promise<void> {
    const existing = useTerminalStore
      .getState()
      .terminals.some((terminal) => terminal.id === panelId && terminal.location !== "trash");
    if (existing) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve();
      }, timeoutMs);

      const unsubscribe = useTerminalStore.subscribe((state) => {
        const found = state.terminals.some(
          (terminal) => terminal.id === panelId && terminal.location !== "trash"
        );
        if (!found || settled) return;
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
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.initialized = false;
  }

  private async cleanupAudioCapture(): Promise<void> {
    if (this.levelRaf !== null) {
      cancelAnimationFrame(this.levelRaf);
      this.levelRaf = null;
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    if (this.keepAliveOscillator) {
      this.keepAliveOscillator.stop();
      this.keepAliveOscillator.disconnect();
      this.keepAliveOscillator = null;
    }

    if (this.keepAliveGain) {
      this.keepAliveGain.disconnect();
      this.keepAliveGain = null;
    }

    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
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
