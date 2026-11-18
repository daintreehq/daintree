/**
 * The on-device speech model, run in its own `utilityProcess` child: ONNX
 * Runtime can abort in native code (#12577), which here ends this child and
 * never main, and inference never stalls main's event loop. The model stays
 * loaded between dictations; each one gets fresh model state and its own
 * Silero VAD, which hears the same audio messages in the same order as the
 * model, so where a pause falls in the words is never a race between two
 * processes. Nothing is logged here: transcripts never leave this protocol.
 */
import type * as Ort from "onnxruntime-node";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pcm16ToFloat, Resampler24kTo16k } from "./localSpeechAudio.js";
import type { DecodedToken } from "./localSpeechDecoder.js";
import { FRAMES_PER_CHUNK, LocalSpeechEngine } from "./localSpeechEngine.js";
import { LOCAL_SPEECH_GEOMETRY as G } from "./localSpeechModelSpec.js";
import { LocalSpeechSegmenter, type SegmentEvent, type TimedToken } from "./localSpeechSegments.js";
import type {
  LocalSpeechWorkerInbound,
  LocalSpeechWorkerOutbound,
} from "./localSpeechWorkerProtocol.js";

interface SpeechParentPort {
  on(event: "message", listener: (event: { data: LocalSpeechWorkerInbound }) => void): void;
  postMessage(message: LocalSpeechWorkerOutbound): void;
}

const port = process.parentPort as unknown as SpeechParentPort | undefined;
if (!port) throw new Error("localSpeechWorker must run in a utility process");

function post(message: LocalSpeechWorkerOutbound): void {
  port!.postMessage(message);
}

/** On the next turn, so the last message flushes before the process goes. */
function exitSoon(code: number): void {
  setImmediate(() => process.exit(code));
}

process.on("uncaughtException", (err) => {
  post({ type: "error", message: formatErrorMessage(err, "Speech process error") });
  exitSoon(1);
});
process.on("unhandledRejection", (reason) => {
  post({ type: "error", message: formatErrorMessage(reason, "Speech process error") });
  exitSoon(1);
});

/** avr-vad's frames: 512 samples at 16 kHz. */
const VAD_FRAME_MS = 32;
/** avr-vad's end-of-speech holdover, in its frames: speech ended this long before it says so. */
const VAD_REDEMPTION_FRAMES = 24;
/**
 * How far past the end of speech a pause closes its passage. The model emits
 * a word's last piece up to about 100 ms after the word ends; this leaves
 * room for that, and is still well short of the earliest the speaker can be
 * heard again (the holdover).
 */
const PAUSE_CLOSE_GUARD_MS = 400;
/**
 * Output held while captured audio waits behind the packet that made it is
 * let go after this long anyway, so a machine that can't keep up still shows
 * words; a held passage then decides end of speech from what was heard so far.
 */
const MAX_HOLD_MS = 3_000;
const CHUNK_MS = (G.chunkSamples / G.sampleRate) * 1000;
const FRAME_MS = CHUNK_MS / FRAMES_PER_CHUNK;

type RealTimeVADClass = typeof import("avr-vad").RealTimeVAD;
type RealTimeVADInstance = Awaited<ReturnType<RealTimeVADClass["new"]>>;

async function loadRealTimeVAD(): Promise<RealTimeVADClass | undefined> {
  // avr-vad ships as CommonJS: the class is a named export or default-wrapped.
  const ns = (await import("avr-vad")) as unknown as {
    RealTimeVAD?: RealTimeVADClass;
    default?: { RealTimeVAD?: RealTimeVADClass };
  };
  return ns.RealTimeVAD ?? ns.default?.RealTimeVAD;
}

type VadEvent = { type: "start" } | { type: "end"; frame: number };

type SessionOutbound = Extract<LocalSpeechWorkerOutbound, { session: number }>;

/** A closed passage whose end of speech is decided when the output is let go. */
type HeldMessage = SessionOutbound | (SessionOutbound & { type: "segment"; pauseEnd: true });

interface Session {
  id: number;
  /**
   * Output not yet posted, in order. It waits while more captured audio is
   * queued behind the packet that made it: a pause has only ended speech if
   * nothing in that audio starts it again.
   */
  outbox: HeldMessage[];
  /** When the oldest held output was made. */
  heldSince: number | null;
  resampler: Resampler24kTo16k;
  /** 16 kHz samples short of a whole chunk. */
  pending: Float32Array;
  /** Chunks decoded this session, padded ones included. */
  chunks: number;
  /** Silence added to finish a chunk at Enter, which the session's audio never had. */
  paddingMs: number;
  segmenter: LocalSpeechSegmenter;
  vad: RealTimeVADInstance | null;
  vadFrames: number;
  vadEvents: VadEvent[];
  speaking: boolean;
  failed: boolean;
}

let engine: LocalSpeechEngine | null = null;
let loading: Promise<void> = Promise.resolve();
/** Every message's work, one after another: one model, one stream. */
let chain: Promise<void> = Promise.resolve();
let session: Session | null = null;
let destroyed = false;
/** Audio messages received and not yet processed, by session. */
const queuedAudio = new Map<number, number>();

async function load(dir: string, threads: number): Promise<void> {
  const started = performance.now();
  // Loaded here rather than at module scope, so a failed native load is
  // reported as a message rather than killing the entry module.
  const ortModule = (await import("onnxruntime-node")) as typeof Ort & { default?: typeof Ort };
  const ort = ortModule.InferenceSession ? ortModule : ortModule.default!;
  const loaded = await LocalSpeechEngine.load(ort, dir, threads);
  if (destroyed) {
    await loaded.release();
    return;
  }
  engine = loaded;
  post({ type: "ready", loadMs: Math.round(performance.now() - started) });
}

async function createVad(target: Session): Promise<RealTimeVADInstance | null> {
  try {
    const RealTimeVAD = await loadRealTimeVAD();
    if (!RealTimeVAD) return null;
    const vad = await RealTimeVAD.new({
      // The same model and tuning as the OpenAI provider's VAD: 768 ms holdover,
      // thresholds 0.5/0.35. avr-vad resamples the 24 kHz capture itself.
      model: "v5",
      sampleRate: 24000,
      onFrameProcessed: () => {
        target.vadFrames++;
      },
      onSpeechStart: () => {
        target.speaking = true;
        target.vadEvents.push({ type: "start" });
      },
      onSpeechEnd: () => {
        target.speaking = false;
        target.vadEvents.push({ type: "end", frame: target.vadFrames });
      },
      // Speech too short to count as speech for avr-vad, a short "yes" among
      // them: it ends there, after the same holdover, and closes what it said.
      onVADMisfire: () => {
        target.speaking = false;
        target.vadEvents.push({ type: "end", frame: target.vadFrames });
      },
    });
    vad.start();
    return vad;
  } catch {
    return null;
  }
}

async function releaseVad(target: Session): Promise<void> {
  const vad = target.vad;
  target.vad = null;
  await vad?.destroy().catch(() => {});
}

function hold(target: Session, message: HeldMessage): void {
  target.outbox.push(message);
  target.heldSince ??= performance.now();
}

function postEvents(target: Session, events: SegmentEvent[]): void {
  for (const event of events) {
    if (event.type === "text") {
      hold(target, { type: "text", session: target.id, segment: event.segment, text: event.text });
      continue;
    }
    // A pause after nothing the model wrote: nothing to complete.
    if (event.text === "" && !event.shown && event.reason === "pause") continue;
    const pauseEnd = event.reason === "pause";
    hold(target, {
      type: "segment",
      session: target.id,
      segment: event.segment,
      text: event.text,
      shown: event.shown,
      reason: event.reason,
      endOfSpeech: false,
      ...(pauseEnd ? { pauseEnd: true as const } : {}),
    });
  }
}

/**
 * Posts the held output in order. A passage a pause closed ended speech only
 * if no speech start follows it in what was held and the VAD hears silence
 * now: one that the speaker went on from must never carry a send.
 */
function flushOutbox(target: Session): void {
  const outbox = target.outbox;
  target.outbox = [];
  target.heldSince = null;
  let resumed = target.speaking || target.vad === null;
  for (let i = outbox.length - 1; i >= 0; i--) {
    const message = outbox[i];
    if (message.type === "speech-start") resumed = true;
    if (message.type === "segment" && "pauseEnd" in message) {
      outbox[i] = {
        type: "segment",
        session: message.session,
        segment: message.segment,
        text: message.text,
        shown: message.shown,
        reason: message.reason,
        endOfSpeech: !resumed,
      };
    }
  }
  for (const message of outbox) post(message);
}

/** Lets the output go once no captured audio waits behind it, or it has waited too long. */
function flushIfCaughtUp(target: Session): void {
  const waiting = (queuedAudio.get(target.id) ?? 0) > 0;
  const tooLong =
    target.heldSince !== null && performance.now() - target.heldSince >= MAX_HOLD_MS;
  if (!waiting || tooLong) flushOutbox(target);
}

/** Where decoding has reached in the session's own audio. */
function decodedThroughMs(target: Session): number {
  return target.chunks * CHUNK_MS - target.paddingMs;
}

function timed(target: Session, tokens: readonly DecodedToken[]): TimedToken[] {
  const chunkStart = target.chunks * CHUNK_MS - target.paddingMs;
  return tokens.map((token) => ({ id: token.id, atMs: chunkStart + token.frame * FRAME_MS }));
}

async function decodeWhole(target: Session, current: LocalSpeechEngine): Promise<void> {
  while (target.pending.length >= G.chunkSamples) {
    const chunk = target.pending.subarray(0, G.chunkSamples);
    target.pending = target.pending.slice(G.chunkSamples);
    const tokens = timed(target, await current.decodeChunk(chunk));
    target.chunks++;
    postEvents(target, target.segmenter.addChunk(tokens, decodedThroughMs(target)));
  }
}

/** Decodes what is left short of a chunk, finished with silence. */
async function decodeRest(target: Session, current: LocalSpeechEngine): Promise<void> {
  if (target.pending.length === 0) return;
  const chunk = new Float32Array(G.chunkSamples);
  chunk.set(target.pending);
  const padMs = ((G.chunkSamples - target.pending.length) / G.sampleRate) * 1000;
  target.pending = new Float32Array(0);
  const tokens = timed(target, await current.decodeChunk(chunk));
  target.chunks++;
  target.paddingMs += padMs;
  postEvents(target, target.segmenter.addChunk(tokens, decodedThroughMs(target)));
}

function append(target: Session, samples: Float32Array): void {
  if (samples.length === 0) return;
  const joined = new Float32Array(target.pending.length + samples.length);
  joined.set(target.pending, 0);
  joined.set(samples, target.pending.length);
  target.pending = joined;
}

async function startSession(id: number, promptId: number): Promise<void> {
  const current = engine;
  if (!current) {
    post({ type: "session-error", session: id, message: "The speech model isn't loaded" });
    return;
  }
  const next: Session = {
    id,
    outbox: [],
    heldSince: null,
    resampler: new Resampler24kTo16k(),
    pending: new Float32Array(0),
    chunks: 0,
    paddingMs: 0,
    segmenter: new LocalSpeechSegmenter(current.vocabulary),
    vad: null,
    vadFrames: 0,
    vadEvents: [],
    speaking: false,
    failed: false,
  };
  session = next;
  current.reset();
  current.setPromptId(promptId);
  // A stream that opens on speech loses its first word without context
  // before it: a chunk of silence gives the model that context.
  await current.decodeChunk(new Float32Array(G.chunkSamples));
  next.vad = await createVad(next);
  if (session !== next) {
    await releaseVad(next);
    return;
  }
  post({ type: "started", session: id, vad: next.vad !== null });
}

async function processAudio(target: Session, pcm: ArrayBuffer): Promise<void> {
  const current = engine;
  if (!current || target.failed) return;
  const samples = pcm16ToFloat(pcm);
  if (target.vad) {
    target.vadEvents = [];
    await target.vad.processAudio(samples);
    for (const event of target.vadEvents) {
      if (event.type === "start") {
        hold(target, { type: "speech-start", session: target.id });
      } else {
        // The VAD counts the session's own audio, the same clock token times use.
        const endedAt = (event.frame - VAD_REDEMPTION_FRAMES) * VAD_FRAME_MS;
        target.segmenter.closeAt(endedAt + PAUSE_CLOSE_GUARD_MS);
      }
    }
    target.vadEvents = [];
  }
  append(target, target.resampler.push(samples));
  await decodeWhole(target, current);
  // A pause heard in silence closes now rather than when the next chunk
  // fills, which a paused capture may never send: the part-chunk is
  // transcribed, finished with silence. Not while speech has started again,
  // where finishing the chunk early would cut its first word.
  const closeAt = target.segmenter.nextCloseAt();
  if (closeAt !== null && decodedThroughMs(target) < closeAt && !target.speaking) {
    await decodeRest(target, current);
  }
  // A pause heard in this message may already be behind what was decoded.
  postEvents(target, target.segmenter.addChunk([], decodedThroughMs(target)));
}

async function closeSession(target: Session, reason: "cut" | "finish"): Promise<void> {
  const current = engine;
  if (!current || target.failed) return;
  if (reason === "finish") append(target, target.resampler.flush());
  // A whole chunk or more can be waiting: the resampler's tail can complete one.
  await decodeWhole(target, current);
  await decodeRest(target, current);
  postEvents(target, target.segmenter.closeNow(reason));
}

function failSession(target: Session, err: unknown): void {
  if (target.failed) return;
  target.failed = true;
  flushOutbox(target);
  post({
    type: "session-error",
    session: target.id,
    message: formatErrorMessage(err, "On-device transcription failed"),
  });
}

/** Runs `work` for the live session `id`, in order behind everything before it. */
function forSession(id: number, work: (target: Session) => Promise<void>): void {
  chain = chain.then(async () => {
    const target = session;
    if (destroyed || !target || target.id !== id) return;
    try {
      await work(target);
    } catch (err) {
      failSession(target, err);
    }
  });
}

port.on("message", ({ data: message }) => {
  if (message.type === "destroy") {
    if (destroyed) return;
    destroyed = true;
    void loading
      .then(() => chain)
      .then(async () => {
        const target = session;
        session = null;
        if (target) await releaseVad(target);
        const current = engine;
        engine = null;
        await current?.release();
      })
      .then(
        () => {
          post({ type: "drained" });
          exitSoon(0);
        },
        (err: unknown) => {
          post({
            type: "error",
            message: formatErrorMessage(err, "Speech process cleanup failed"),
          });
          exitSoon(1);
        }
      );
    return;
  }
  if (destroyed) return;
  switch (message.type) {
    case "load":
      loading = load(message.dir, message.threads).catch((err: unknown) => {
        post({ type: "load-failed", message: formatErrorMessage(err, "Couldn't load the model") });
      });
      chain = chain.then(() => loading);
      return;
    case "start": {
      const { session: id, promptId } = message;
      chain = chain.then(async () => {
        const previous = session;
        if (previous) await releaseVad(previous);
        try {
          await startSession(id, promptId);
        } catch (err) {
          post({
            type: "session-error",
            session: id,
            message: formatErrorMessage(err, "On-device transcription failed"),
          });
        }
      });
      return;
    }
    case "audio": {
      const { session: id, pcm } = message;
      queuedAudio.set(id, (queuedAudio.get(id) ?? 0) + 1);
      chain = chain.then(async () => {
        const left = (queuedAudio.get(id) ?? 1) - 1;
        if (left > 0) queuedAudio.set(id, left);
        else queuedAudio.delete(id);
        const target = session;
        if (destroyed || !target || target.id !== id) return;
        try {
          await processAudio(target, pcm);
        } catch (err) {
          failSession(target, err);
        }
        flushIfCaughtUp(target);
      });
      return;
    }
    case "cut":
      forSession(message.session, async (target) => {
        await closeSession(target, "cut");
        flushIfCaughtUp(target);
      });
      return;
    case "finish": {
      const id = message.session;
      forSession(id, async (target) => {
        await closeSession(target, "finish");
        flushOutbox(target);
        await releaseVad(target);
      });
      chain = chain.then(() => {
        if (session?.id === id) session = null;
        post({ type: "finished", session: id });
      });
      return;
    }
    case "end": {
      const id = message.session;
      chain = chain.then(async () => {
        const target = session;
        if (!target || target.id !== id) return;
        session = null;
        await releaseVad(target);
      });
      return;
    }
  }
});
