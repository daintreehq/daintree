/**
 * VAD side-chain worker for `OpenAITranscriptionProvider`.
 *
 * `gpt-realtime-whisper` has no server-side VAD (`turn_detection` must be
 * null), so segmentation happens on the client. Rather than commit on a blind
 * 2s timer — which cuts words mid-pause and adds latency at end-of-speech — we
 * run Silero VAD v5 (via `avr-vad`) here, on a worker thread, and report
 * speech-boundary events back to the provider. ONNX inference runs every ~32ms
 * and would add jitter to the Electron main IPC loop if run inline, hence the
 * worker.
 *
 * Audio in is raw 24kHz mono PCM16 (the same stream sent to OpenAI). avr-vad
 * resamples to the 16kHz Silero expects internally when `sampleRate` is above
 * 16kHz, so no manual resampling is needed here.
 */
import { parentPort } from "node:worker_threads";
import * as avrVad from "avr-vad";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { VadWorkerInbound, VadWorkerOutbound } from "./openaiVadWorkerProtocol.js";

const port = parentPort;
if (!port) {
  // Spawned outside a worker thread — nothing sane to do.
  throw new Error("openaiVadWorker must run as a worker thread");
}

function post(message: VadWorkerOutbound): void {
  port!.postMessage(message);
}

// avr-vad ships as CommonJS; resolve the class defensively across the ESM/CJS
// interop boundary (named export vs. default-wrapped) so a packaging quirk
// doesn't silently break VAD init.
const ns = avrVad as unknown as {
  RealTimeVAD?: typeof import("avr-vad").RealTimeVAD;
  default?: { RealTimeVAD?: typeof import("avr-vad").RealTimeVAD };
};
const RealTimeVAD = (ns.RealTimeVAD ?? ns.default?.RealTimeVAD) as unknown as
  typeof import("avr-vad").RealTimeVAD | undefined;

/** Converts little-endian PCM16 samples to the Float32 [-1, 1) avr-vad wants. */
function pcm16ToFloat32(pcm: ArrayBuffer): Float32Array {
  const view = new Int16Array(pcm);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) {
    out[i] = view[i] / 32768;
  }
  return out;
}

type RealTimeVADInstance = Awaited<ReturnType<typeof import("avr-vad").RealTimeVAD.new>>;

let vad: RealTimeVADInstance | null = null;
// Serializes processAudio() calls — avr-vad mutates an internal buffer per call,
// so overlapping awaits would corrupt frame boundaries. Audio messages chain
// onto this promise in arrival order.
let processChain: Promise<void> = Promise.resolve();
let destroyed = false;

async function init(): Promise<void> {
  if (!RealTimeVAD) {
    post({ type: "error", message: "avr-vad RealTimeVAD export not found" });
    return;
  }
  try {
    vad = await RealTimeVAD.new({
      // Silero v5. avr-vad's frame-processor defaults (512-sample frames,
      // 24 redemption frames ≈ 768ms holdover, positive/negative thresholds
      // 0.5/0.35) are tuned for dictation; only the input sample rate differs.
      model: "v5",
      sampleRate: 24000,
      onSpeechStart: () => post({ type: "speech-start" }),
      onSpeechEnd: () => post({ type: "speech-end" }),
      // A misfire is a sub-`minSpeechFrames` blip that avr-vad discards without
      // an end event. Surface it as speech-end so the provider always returns
      // to the not-speaking state (the undersized buffer commit is skipped).
      onVADMisfire: () => post({ type: "speech-end" }),
    });
    vad.start();
    post({ type: "ready" });
  } catch (err) {
    post({ type: "error", message: formatErrorMessage(err, "VAD initialization failed") });
  }
}

port.on("message", (message: VadWorkerInbound) => {
  if (message.type === "destroy") {
    destroyed = true;
    const current = vad;
    vad = null;
    if (current) {
      // Drain the in-flight chain, then release the ONNX session.
      processChain = processChain.then(() => current.destroy()).catch(() => {});
    }
    void processChain.finally(() => port.close());
    return;
  }

  if (message.type === "audio") {
    if (destroyed || !vad) return;
    const frame = pcm16ToFloat32(message.pcm);
    processChain = processChain
      .then(() => (vad ? vad.processAudio(frame) : undefined))
      .catch((err: unknown) => {
        post({ type: "error", message: formatErrorMessage(err, "VAD processing failed") });
      });
  }
});

void init();
