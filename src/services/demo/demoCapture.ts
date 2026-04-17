// Renderer-side driver for demo capture. Subscribes to DEMO_CAPTURE_START /
// DEMO_CAPTURE_STOP signals from main, runs getDisplayMedia + MediaRecorder,
// streams VP9 WebM chunks back to main via IPC. Only bootstrapped when
// window.electron.demo is available (i.e., --demo-mode is on).
//
// Stop sequence is W3C-ordered: main signals stop → mediaRecorder.stop() →
// final ondataavailable → onstop → sendCaptureFinished. Main only closes the
// output file after DEMO_CAPTURE_FINISHED arrives.

const CHUNK_TIMESLICE_MS = 1000;
const RECORDER_MIME_TYPE = "video/webm;codecs=vp9";

interface ActiveRecording {
  captureId: string;
  stream: MediaStream;
  recorder: MediaRecorder;
}

export function initDemoCapture(): () => void {
  const electron = window.electron;
  if (!electron?.demo) {
    return () => {};
  }
  const demo = electron.demo;

  let active: ActiveRecording | null = null;

  async function start(payload: { captureId: string; fps: number }): Promise<void> {
    const { captureId, fps } = payload;

    if (active) {
      console.warn("[demoCapture] Start requested while active session running; ignoring");
      return;
    }

    if (
      typeof MediaRecorder === "undefined" ||
      !MediaRecorder.isTypeSupported(RECORDER_MIME_TYPE)
    ) {
      console.error(`[demoCapture] MediaRecorder does not support ${RECORDER_MIME_TYPE}`);
      demo.sendCaptureFinished(captureId);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps },
        audio: false,
      });
    } catch (err) {
      console.error("[demoCapture] getDisplayMedia rejected:", err);
      // Still signal finished so main's finalize promise can resolve/reject
      // instead of hanging until the safety timeout.
      demo.sendCaptureFinished(captureId);
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE });
    const recording: ActiveRecording = { captureId, stream, recorder };

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      // blob.arrayBuffer() returns a fresh browser-heap ArrayBuffer, so
      // transferring it via postMessage is safe (not backed by a Node slab).
      void event.data.arrayBuffer().then((buffer) => {
        if (!active || active.captureId !== captureId) return;
        demo.sendCaptureChunk(captureId, buffer);
      });
    };

    recorder.onerror = (event) => {
      console.error("[demoCapture] MediaRecorder error:", event);
    };

    recorder.onstop = () => {
      for (const track of recording.stream.getTracks()) {
        track.stop();
      }
      if (active && active.captureId === captureId) {
        active = null;
      }
      demo.sendCaptureFinished(captureId);
    };

    active = recording;
    recorder.start(CHUNK_TIMESLICE_MS);
  }

  function stop(payload: { captureId: string }): void {
    const { captureId } = payload;
    if (!active) {
      // No active session — idempotent ack so main doesn't hang.
      demo.sendCaptureFinished(captureId);
      return;
    }
    if (active.captureId !== captureId) {
      // Stale stop for a prior session — ignore.
      return;
    }
    if (active.recorder.state === "inactive") {
      demo.sendCaptureFinished(captureId);
      return;
    }
    active.recorder.stop();
  }

  const unsubscribeStart = demo.onCaptureStart((payload) => {
    void start(payload);
  });
  const unsubscribeStop = demo.onCaptureStop((payload) => {
    stop(payload);
  });

  return () => {
    unsubscribeStart();
    unsubscribeStop();
    const recording = active;
    if (recording) {
      try {
        if (recording.recorder.state !== "inactive") {
          recording.recorder.stop();
        }
      } catch {
        // Already stopped or disposed
      }
      for (const track of recording.stream.getTracks()) {
        track.stop();
      }
      active = null;
    }
  };
}
