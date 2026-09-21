/**
 * VAD side-chain for `OpenAITranscriptionProvider`, run in its own
 * `utilityProcess` child.
 *
 * The provider sends `turn_detection: null`, so the server never auto-commits
 * and segmentation happens on the client. Rather than commit on a blind
 * 2s timer — which cuts words mid-pause and adds latency at end-of-speech — we
 * run Silero VAD v5 (via `avr-vad`) here and report speech-boundary events back
 * to the provider. ONNX inference runs every ~32ms and would add jitter to the
 * Electron main IPC loop if run inline.
 *
 * This is a separate process rather than a worker thread because ONNX Runtime
 * can abort in native code (#12577). A `std::terminate` on a thread inside main
 * takes the whole app down; here it only ends this child, and the provider
 * falls back to its backstop commit cadence.
 *
 * Audio in is raw 24kHz mono PCM16 (the same stream sent to OpenAI). avr-vad
 * resamples to the 16kHz Silero expects internally when `sampleRate` is above
 * 16kHz, so no manual resampling is needed here.
 */
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { VadWorkerInbound, VadWorkerOutbound } from "./openaiVadWorkerProtocol.js";

interface VadParentPort {
  on(event: "message", listener: (event: { data: VadWorkerInbound }) => void): void;
  postMessage(message: VadWorkerOutbound): void;
}

const port = process.parentPort as unknown as VadParentPort | undefined;
if (!port) {
  // Spawned outside a utility process — nothing sane to do.
  throw new Error("openaiVadWorker must run in a utility process");
}

function post(message: VadWorkerOutbound): void {
  port!.postMessage(message);
}

// Exit on the next turn so the last message flushes over Mojo before the
// process goes away.
function exitSoon(code: number): void {
  setImmediate(() => process.exit(code));
}

// Electron 37+ only warns on these in a utility process. Exit instead, so the
// provider sees the child go and degrades rather than waiting on a VAD that
// will never report again.
process.on("uncaughtException", (err) => {
  post({ type: "error", message: formatErrorMessage(err, "VAD process error") });
  exitSoon(1);
});
process.on("unhandledRejection", (reason) => {
  post({ type: "error", message: formatErrorMessage(reason, "VAD process error") });
  exitSoon(1);
});

type RealTimeVADClass = typeof import("avr-vad").RealTimeVAD;

/**
 * Loaded on demand rather than at module scope so a native load failure (the
 * `onnxruntime_binding.node` dlopen) is reported as an `error` message instead
 * of failing the entry module before any listener exists.
 */
async function loadRealTimeVAD(): Promise<RealTimeVADClass | undefined> {
  // avr-vad ships as CommonJS; resolve the class defensively across the ESM/CJS
  // interop boundary (named export vs. default-wrapped) so a packaging quirk
  // doesn't silently break VAD init.
  const ns = (await import("avr-vad")) as unknown as {
    RealTimeVAD?: RealTimeVADClass;
    default?: { RealTimeVAD?: RealTimeVADClass };
  };
  return ns.RealTimeVAD ?? ns.default?.RealTimeVAD;
}

/** Converts little-endian PCM16 samples to the Float32 [-1, 1) avr-vad wants. */
function pcm16ToFloat32(pcm: ArrayBuffer): Float32Array {
  const view = new Int16Array(pcm);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) {
    out[i] = view[i] / 32768;
  }
  return out;
}

type RealTimeVADInstance = Awaited<ReturnType<RealTimeVADClass["new"]>>;

let vad: RealTimeVADInstance | null = null;
// Serializes processAudio() calls — avr-vad mutates an internal buffer per call,
// so overlapping awaits would corrupt frame boundaries. Audio messages chain
// onto this promise in arrival order.
let processChain: Promise<void> = Promise.resolve();
let destroyed = false;

async function init(): Promise<void> {
  try {
    const RealTimeVAD = await loadRealTimeVAD();
    if (!RealTimeVAD) {
      post({ type: "error", message: "avr-vad RealTimeVAD export not found" });
      return;
    }
    if (destroyed) return;
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
    if (destroyed) return;
    vad.start();
    post({ type: "ready" });
  } catch (err) {
    post({ type: "error", message: formatErrorMessage(err, "VAD initialization failed") });
  }
}

port.on("message", ({ data: message }) => {
  if (message.type === "destroy") {
    if (destroyed) return;
    destroyed = true;
    // Model creation and inference both own native async work. Keep the
    // process alive until they finish and the ONNX session has been released.
    void initialization
      .then(async () => {
        await processChain;
        const current = vad;
        vad = null;
        await current?.destroy();
      })
      .then(
        () => {
          post({ type: "drained" });
          exitSoon(0);
        },
        (err: unknown) => {
          post({ type: "error", message: formatErrorMessage(err, "VAD cleanup failed") });
          exitSoon(1);
        }
      );
    return;
  }

  if (message.type === "audio") {
    if (destroyed || !vad) return;
    const frame = pcm16ToFloat32(message.pcm);
    processChain = processChain
      .then(() => (!destroyed && vad ? vad.processAudio(frame) : undefined))
      .catch((err: unknown) => {
        post({ type: "error", message: formatErrorMessage(err, "VAD processing failed") });
      });
  }
});

const initialization = init();
