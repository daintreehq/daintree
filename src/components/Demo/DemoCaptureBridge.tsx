import { useEffect, useRef } from "react";

interface ActiveRecording {
  captureId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  frameCount: number;
  stopped: boolean;
  stopRequestId: string | null;
}

function getDemoApi() {
  return window.electron.demo!;
}

export function DemoCaptureBridge() {
  const activeRef = useRef<ActiveRecording | null>(null);

  useEffect(() => {
    const api = getDemoApi();

    const stopAndCleanup = (active: ActiveRecording, error?: string) => {
      if (active.stopped) return;
      active.stopped = true;
      try {
        if (active.recorder.state !== "inactive") {
          active.recorder.stop();
        }
      } catch {
        // already stopped
      }
      try {
        active.stream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      if (error) {
        api.sendCaptureStop(active.captureId, active.frameCount, error);
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
          const message = err instanceof Error ? err.message : String(err);
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
          const message = err instanceof Error ? err.message : String(err);
          api.sendCommandDone(requestId, `MediaRecorder init failed: ${message}`);
          return;
        }

        const active: ActiveRecording = {
          captureId,
          recorder,
          stream,
          frameCount: 0,
          stopped: false,
          stopRequestId: null,
        };
        activeRef.current = active;

        recorder.ondataavailable = async (e: BlobEvent) => {
          if (e.data && e.data.size > 0) {
            try {
              const ab = await e.data.arrayBuffer();
              api.sendCaptureChunk(active.captureId, new Uint8Array(ab));
            } catch {
              // renderer unloading
            }
          }
        };

        recorder.onerror = (event: Event) => {
          const errEvent = event as unknown as { error?: Error };
          const message = errEvent.error?.message ?? "MediaRecorder error";
          stopAndCleanup(active, message);
          if (active.stopRequestId) {
            api.sendCommandDone(active.stopRequestId, message);
            active.stopRequestId = null;
          }
        };

        recorder.onstop = () => {
          try {
            active.stream.getTracks().forEach((t) => t.stop());
          } catch {
            // ignore
          }
          api.sendCaptureStop(active.captureId, active.frameCount);
          if (active.stopRequestId) {
            api.sendCommandDone(active.stopRequestId);
            active.stopRequestId = null;
          }
          if (activeRef.current === active) {
            activeRef.current = null;
          }
        };

        try {
          recorder.start(1000);
          api.sendCommandDone(requestId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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

        if (!active || active.captureId !== captureId || active.stopped) {
          api.sendCommandDone(requestId);
          return;
        }

        active.stopped = true;
        active.stopRequestId = requestId;
        try {
          if (active.recorder.state !== "inactive") {
            active.recorder.stop();
          } else {
            api.sendCaptureStop(active.captureId, active.frameCount);
            api.sendCommandDone(requestId);
            active.stopRequestId = null;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          api.sendCommandDone(requestId, message);
          active.stopRequestId = null;
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
