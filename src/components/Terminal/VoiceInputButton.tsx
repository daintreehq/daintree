import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceInputStatus } from "@shared/types";
import { actionService } from "@/services/ActionService";

const AUTO_STOP_MS = 60_000;

interface VoiceInputButtonProps {
  onTranscriptionDelta: (delta: string) => void;
  onTranscriptionComplete: (text: string) => void;
  onRecordingStateChange?: (isRecording: boolean) => void;
  disabled?: boolean;
  isConfigured?: boolean;
}

export function VoiceInputButton({
  onTranscriptionDelta,
  onTranscriptionComplete,
  onRecordingStateChange,
  disabled = false,
  isConfigured = false,
}: VoiceInputButtonProps) {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  // Generation token: each start() call increments this; stop/stale callbacks check it.
  const generationRef = useRef(0);

  const isRecording = status === "recording";

  useEffect(() => {
    onRecordingStateChange?.(isRecording);
  }, [isRecording, onRecordingStateChange]);

  const stopRecording = useCallback(async () => {
    // Increment generation so any in-flight startRecording async steps become no-ops.
    generationRef.current++;

    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }

    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (audioContextRef.current) {
      await audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    await window.electron?.voiceInput?.stop();
    setElapsedSeconds(0);
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMessage(null);

    const generation = ++generationRef.current;

    // First start the WebSocket session
    const result = await window.electron?.voiceInput?.start();
    if (generationRef.current !== generation) return; // Cancelled by a concurrent stop/start
    if (!result?.ok) {
      setErrorMessage(result?.error ?? "Failed to start voice session");
      setStatus("error");
      return;
    }

    // Request microphone access
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      if (generationRef.current !== generation) return;
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission denied. Enable it in System Preferences → Privacy → Microphone."
          : "Could not access microphone";
      setErrorMessage(message);
      setStatus("error");
      await window.electron?.voiceInput?.stop();
      return;
    }

    if (generationRef.current !== generation) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;

    const audioContext = new AudioContext({ sampleRate: 48000 });
    audioContextRef.current = audioContext;

    // Resume AudioContext (required by autoplay policy in Chromium)
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    if (generationRef.current !== generation) {
      await audioContext.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    try {
      await audioContext.audioWorklet.addModule("/pcm-processor.js");
    } catch {
      if (generationRef.current !== generation) return;
      setErrorMessage("Failed to load audio processor");
      setStatus("error");
      stream.getTracks().forEach((t) => t.stop());
      await audioContext.close().catch(() => {});
      await window.electron?.voiceInput?.stop();
      return;
    }

    if (generationRef.current !== generation) {
      await audioContext.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    workletNodeRef.current = workletNode;

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (generationRef.current !== generation) return;
      window.electron?.voiceInput?.sendAudioChunk(event.data);
    };

    source.connect(workletNode);
    // Don't connect workletNode to destination — capture only, no playback

    startTimeRef.current = Date.now();
    setElapsedSeconds(0);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    autoStopTimerRef.current = setTimeout(() => {
      stopRecording();
    }, AUTO_STOP_MS);
  }, [stopRecording]);

  const handleClick = useCallback(async () => {
    if (disabled) return;
    // An active session always wins — let the user stop recording even if config was revoked.
    if (isRecording) {
      await stopRecording();
      return;
    }
    if (!isConfigured) {
      // Re-check live: the Settings dialog is same-window so focus never fires after save.
      const fresh = await window.electron?.voiceInput?.getSettings();
      if (fresh?.enabled && !!fresh.apiKey) {
        await startRecording();
        return;
      }
      void actionService.dispatch("app.settings.openTab", { tab: "voice" }, { source: "user" });
      return;
    }
    await startRecording();
  }, [disabled, isConfigured, isRecording, startRecording, stopRecording]);

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    const unsubStatus = window.electron?.voiceInput?.onStatus((s) => {
      // Gate status updates by checking if they apply to the current session
      setStatus(s);
    });
    if (unsubStatus) unsubs.push(unsubStatus);

    const unsubDelta = window.electron?.voiceInput?.onTranscriptionDelta((delta) => {
      onTranscriptionDelta(delta);
    });
    if (unsubDelta) unsubs.push(unsubDelta);

    const unsubComplete = window.electron?.voiceInput?.onTranscriptionComplete((text) => {
      onTranscriptionComplete(text);
    });
    if (unsubComplete) unsubs.push(unsubComplete);

    const unsubError = window.electron?.voiceInput?.onError((err) => {
      setErrorMessage(err);
      stopRecording();
    });
    if (unsubError) unsubs.push(unsubError);

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [onTranscriptionDelta, onTranscriptionComplete, stopRecording]);

  // Stop recording when disabled (e.g., terminal switch)
  useEffect(() => {
    if (disabled && isRecording) {
      stopRecording();
    }
  }, [disabled, isRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      onRecordingStateChange?.(false);
      stopRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || status === "connecting"}
        title={
          !isConfigured
            ? "Configure voice input"
            : status === "error"
              ? (errorMessage ?? "Voice input error")
              : isRecording
                ? "Stop recording"
                : "Start voice input"
        }
        className={cn(
          "flex items-center justify-center rounded p-1 transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
          isRecording
            ? "text-red-400 hover:text-red-300"
            : status === "connecting"
              ? "text-canopy-text/40"
              : status === "error"
                ? "text-yellow-400 hover:text-yellow-300"
                : "text-canopy-text/40 hover:text-canopy-text/70",
          disabled && "pointer-events-none opacity-40"
        )}
        aria-label={
          !isConfigured
            ? "Set up voice input"
            : isRecording
              ? "Stop voice recording"
              : "Start voice recording"
        }
        aria-pressed={isConfigured ? isRecording : undefined}
      >
        {status === "connecting" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isRecording ? (
          <div className="relative">
            <Mic className="h-3.5 w-3.5" />
            <span className="absolute -right-1 -top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
          </div>
        ) : (
          <MicOff className="h-3.5 w-3.5" />
        )}
      </button>

      {isRecording && (
        <span className="ml-1 font-mono text-[10px] tabular-nums text-red-400/80">
          {formatDuration(elapsedSeconds)}
        </span>
      )}
    </div>
  );
}
