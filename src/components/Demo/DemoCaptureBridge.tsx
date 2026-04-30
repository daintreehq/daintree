import { useEffect, useRef } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface ActiveRecording {
  captureId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  frameCount: number;
  pendingChunks: number;
  stopped: boolean;
  stopSignalSent: boolean;
  stopRequestId: string | null;
  stopError: string | null;
}

function getDemoApi() {
  return window.electron.demo!;
}

export function DemoCaptureBridge() {
  const activeRef = useRef<ActiveRecording | null>(null);

  useEffect(() => {
    const api = getDemoApi();

    // Send DEMO_CAPTURE_STOP only once all pending chunks have drained AND the
    // recorder has stopped. ondataavailable is async (awaits arrayBuffer), so
    // naive dispatch inside onstop races ahead of the final chunk's IPC send.
    const maybeSendStop = (active: ActiveRecording) => {
      if (!active.stopped || active.stopSignalSent || active.pendingChunks > 0) return;
      active.stopSignalSent = true;
      api.sendCaptureStop(active.captureId, active.frameCount, active.stopError ?? undefined);
      if (active.stopRequestId) {
        api.sendCommandDone(active.stopRequestId, active.stopError ?? undefined);
        active.stopRequestId = null;
      }
      if (activeRef.current === active) {
        activeRef.current = null;
      }
    };

    const stopAndCleanup = (active: ActiveRecording, error?: string) => {
      if (active.stopped) return;
      active.stopped = true;
      if (error && !active.stopError) active.stopError = error;
      try {
        if (active.recorder.state !== "inactive") {
          active.recorder.stop();
        } else {
          // Recorder already inactive — onstop won't fire, so drive the barrier.
          try {
            active.stream.getTracks().forEach((t) => t.stop());
          } catch {
            // ignore
          }
          maybeSendStop(active);
        }
      } catch {
        maybeSendStop(active);
      }
    };

    const offStart = api.onExecCommand(
      "demo:exec-start-capture",
      async (payload: Record<string, unknown>) => {
        const captureId = payload.captureId as string;
        const requestId = payload.requestId as string;
        const fps = (payload.fps as number | undefined) ?? 30;
        const requestedMime = (payload.mimeType as string | undefined) ?? "video/webm;codecs=vp9";

        if (activeRef.current && !activeRef.current.stopped) {
          api.sendCommandDone(requestId, "Capture already in progress");
          return;
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: fps },
            audio: false,
          });
        } catch (err) {
          const message = formatErrorMessage(err, "getDisplayMedia failed");
          api.sendCommandDone(requestId, `getDisplayMedia failed: ${message}`);
          return;
        }

        const mimeType = MediaRecorder.isTypeSupported(requestedMime)
          ? requestedMime
          : "video/webm";

        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, { mimeType });
        } catch (err) {
          stream.getTracks().forEach((t) => t.stop());
          const message = formatErrorMessage(err, "MediaRecorder init failed");
          api.sendCommandDone(requestId, `MediaRecorder init failed: ${message}`);
          return;
        }

        const active: ActiveRecording = {
          captureId,
          recorder,
          stream,
          frameCount: 0,
          pendingChunks: 0,
          stopped: false,
          stopSignalSent: false,
          stopRequestId: null,
          stopError: null,
        };
        activeRef.current = active;

        recorder.ondataavailable = async (e: BlobEvent) => {
          if (!e.data || e.data.size === 0) return;
          active.pendingChunks += 1;
          active.frameCount += 1;
          try {
            const ab = await e.data.arrayBuffer();
            api.sendCaptureChunk(active.captureId, new Uint8Array(ab));
          } catch (err) {
            if (!active.stopError) {
              active.stopError = formatErrorMessage(err, "Failed to send capture chunk");
            }
          } finally {
            active.pendingChunks -= 1;
            maybeSendStop(active);
          }
        };

        recorder.onerror = (event: Event) => {
          const errEvent = event as unknown as { error?: Error };
          const message = errEvent.error?.message ?? "MediaRecorder error";
          stopAndCleanup(active, message);
        };

        recorder.onstop = () => {
          try {
            active.stream.getTracks().forEach((t) => t.stop());
          } catch {
            // ignore
          }
          active.stopped = true;
          maybeSendStop(active);
        };

        try {
          recorder.start(1000);
          api.sendCommandDone(requestId);
        } catch (err) {
          const message = formatErrorMessage(err, "recorder.start failed");
          stopAndCleanup(active, message);
          api.sendCommandDone(requestId, `recorder.start failed: ${message}`);
        }
      }
    );

    const offStop = api.onExecCommand(
      "demo:exec-stop-capture",
      (payload: Record<string, unknown>) => {
        const captureId = payload.captureId as string;
        const requestId = payload.requestId as string;
        const active = activeRef.current;

        if (!active || active.captureId !== captureId) {
          api.sendCommandDone(requestId);
          return;
        }
        if (active.stopSignalSent) {
          api.sendCommandDone(requestId);
          return;
        }

        active.stopRequestId = requestId;
        try {
          if (active.recorder.state !== "inactive") {
            active.recorder.stop();
          } else {
            active.stopped = true;
            maybeSendStop(active);
          }
        } catch (err) {
          const message = formatErrorMessage(err, "Failed to stop recorder");
          active.stopError = message;
          active.stopped = true;
          maybeSendStop(active);
        }
      }
    );

    return () => {
      offStart();
      offStop();
      const active = activeRef.current;
      if (active && !active.stopped) {
        stopAndCleanup(active, "DemoCaptureBridge unmounted");
      }
      activeRef.current = null;
    };
  }, []);

  return null;
}
