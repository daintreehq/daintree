import { useEffect, useRef } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface ActiveRecording {
  captureId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunkCount: number;
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
      api.sendCaptureStop(active.captureId, active.chunkCount, active.stopError ?? undefined);
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
        const videoBitsPerSecond =
          typeof payload.videoBitsPerSecond === "number" ? payload.videoBitsPerSecond : undefined;
        const width = typeof payload.width === "number" ? payload.width : undefined;
        const height = typeof payload.height === "number" ? payload.height : undefined;

        if (activeRef.current && !activeRef.current.stopped) {
          api.sendCommandDone(requestId, "Capture already in progress");
          return;
        }

        // Request the capture resolution as `ideal` so acquisition stays soft —
        // `exact` here throws TypeError for display capture. Chromium treats
        // width/height as advisory for getDisplayMedia, so the delivered track
        // is the surface's native backing-store size; we pin it precisely below
        // via applyConstraints().
        const videoConstraints: MediaTrackConstraints = { frameRate: fps };
        if (width && height) {
          videoConstraints.width = { ideal: width };
          videoConstraints.height = { ideal: height };
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: videoConstraints,
            audio: false,
          });
        } catch (err) {
          const message = formatErrorMessage(err, "getDisplayMedia failed");
          api.sendCommandDone(requestId, `getDisplayMedia failed: ${message}`);
          return;
        }

        // Resolution is all-or-nothing: a partial request (one dimension, or a
        // non-positive value) would silently fall through to native size, which
        // is exactly the wrong-resolution bug this guards against. Fail fast.
        const wantWidth = typeof width === "number" && width > 0;
        const wantHeight = typeof height === "number" && height > 0;
        if (wantWidth !== wantHeight) {
          stream.getTracks().forEach((t) => t.stop());
          api.sendCommandDone(
            requestId,
            "Capture resolution requires both width and height (got one)"
          );
          return;
        }

        // Pin the captured frame to the exact requested size. getDisplayMedia
        // ignores width/height, so applyConstraints({ exact }) is the only seam
        // that forces Chromium to downscale the track (e.g. 3840×2160 backing
        // store → 2560×1440). It succeeds when the requested ratio matches the
        // surface (the demo window is sized to match), otherwise it rejects.
        // Fail hard on any miss rather than silently recording the wrong size.
        if (wantWidth && wantHeight) {
          const videoTrack = stream.getVideoTracks()[0];
          if (!videoTrack) {
            stream.getTracks().forEach((t) => t.stop());
            api.sendCommandDone(requestId, "No video track in capture stream");
            return;
          }
          try {
            await videoTrack.applyConstraints({
              width: { exact: width },
              height: { exact: height },
            });
          } catch (err) {
            stream.getTracks().forEach((t) => t.stop());
            const message = formatErrorMessage(err, "applyConstraints failed");
            api.sendCommandDone(requestId, `Capture resolution pin failed: ${message}`);
            return;
          }
          const settings = videoTrack.getSettings();
          if (settings.width !== width || settings.height !== height) {
            stream.getTracks().forEach((t) => t.stop());
            api.sendCommandDone(
              requestId,
              `Capture resolution mismatch: got ${settings.width}×${settings.height}, ` +
                `wanted ${width}×${height}`
            );
            return;
          }
        }

        const mimeType = MediaRecorder.isTypeSupported(requestedMime)
          ? requestedMime
          : "video/webm";

        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, {
            mimeType,
            ...(videoBitsPerSecond ? { videoBitsPerSecond } : {}),
          });
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
          chunkCount: 0,
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
          active.chunkCount += 1;
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
