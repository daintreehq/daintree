import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { SIGNAL_PEAK_THRESHOLD } from "@/services/voiceStartDiagnostics";
import { pcmPeak } from "./fakeMicrophone";

/** pcm-processor.js posts 2400 samples (100 ms at 24 kHz), plus a shorter chunk when a stop flushes it. */
export const CHUNK_SAMPLES = 2_400;
const SAMPLES_PER_MS = 24;
const NON_SILENT_PEAK = SIGNAL_PEAK_THRESHOLD * 32_768;

/**
 * A speech-like test signal: a gliding pitch under a slow amplitude envelope, after a short
 * silence. A steady tone won't do, because 440 Hz repeats every 600 samples at 24 kHz and
 * every chunk would be identical, so arrival couldn't be told apart from position.
 */
export function glidingVoice(t: number): number {
  if (t < 0.25) return 0;
  const phase =
    2 * Math.PI * (300 * t - (80 / (2 * Math.PI * 0.7)) * Math.cos(2 * Math.PI * 0.7 * t));
  return Math.sin(phase) * (0.35 + 0.15 * Math.sin(2 * Math.PI * 2.3 * t));
}

export interface TappedChunk {
  /** Renderer `Date.now()` when the chunk reached the main thread. */
  t: number;
  bytes: Buffer;
}

export interface CaptureTapSnapshot {
  /**
   * One entry per pcm-processor node, so per dictation start. `flushedAfter` is how many chunks
   * had arrived when the worklet's "flushed" marker did, or null before a stop flushed it.
   */
  nodes: Array<{ chunks: TappedChunk[]; flushedAfter: number | null }>;
  keys: Array<{ type: "keydown" | "keyup"; key: string; code: string; repeat: boolean; t: number }>;
  completes: Array<{ text: string; t: number }>;
}

interface RawTap {
  nodes: Array<{ chunks: Array<{ t: number; data: ArrayBuffer }>; flushedAfter: number | null }>;
  keys: CaptureTapSnapshot["keys"];
  completes: CaptureTapSnapshot["completes"];
}

declare global {
  interface Window {
    __voiceCaptureTap__?: RawTap;
  }
}

/**
 * Records, in the renderer, every chunk the capture worklet hands the main thread, the
 * worklet's "flushed" marker, key events and final transcripts, all on one clock. The tap is
 * a second listener on the worklet's port, added before the service sets `onmessage`, so it
 * sees each chunk first and independently of whether the service forwards it.
 */
export async function installCaptureTap(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__voiceCaptureTap__) return;
    const tap: RawTap = { nodes: [], keys: [], completes: [] };
    window.__voiceCaptureTap__ = tap;

    const Base = window.AudioWorkletNode;
    class TappedWorkletNode extends Base {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== "pcm-processor") return;
        const node: RawTap["nodes"][number] = { chunks: [], flushedAfter: null };
        tap.nodes.push(node);
        this.port.addEventListener("message", (event: MessageEvent) => {
          const data: unknown = event.data;
          if (data instanceof ArrayBuffer) node.chunks.push({ t: Date.now(), data: data.slice(0) });
          else if ((data as { type?: unknown } | null)?.type === "flushed") {
            node.flushedAfter ??= node.chunks.length;
          }
        });
      }
    }
    window.AudioWorkletNode = TappedWorkletNode;

    const recordKey = (event: KeyboardEvent) => {
      tap.keys.push({
        type: event.type as "keydown" | "keyup",
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        t: Date.now(),
      });
    };
    window.addEventListener("keydown", recordKey, { capture: true });
    window.addEventListener("keyup", recordKey, { capture: true });
    window.electron.voiceInput.onTranscriptionComplete(({ text }) => {
      tap.completes.push({ text, t: Date.now() });
    });
  });
}

export async function resetCaptureTap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tap = window.__voiceCaptureTap__;
    if (!tap) return;
    tap.nodes.length = 0;
    tap.keys.length = 0;
    tap.completes.length = 0;
  });
}

/** Non-silent chunks the latest pcm-processor node has delivered so far. */
export async function signalChunksTapped(page: Page): Promise<number> {
  return await page.evaluate((floor) => {
    const node = window.__voiceCaptureTap__?.nodes.at(-1);
    if (!node) return 0;
    return node.chunks.filter(({ data }) => {
      const samples = new Int16Array(data);
      for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= floor) return true;
      return false;
    }).length;
  }, NON_SILENT_PEAK);
}

/** Whether the latest pcm-processor node has handed over its final chunk to a stop. */
export async function captureFlushed(page: Page): Promise<boolean> {
  return await page.evaluate(
    () => (window.__voiceCaptureTap__?.nodes.at(-1)?.flushedAfter ?? null) !== null
  );
}

/** Key events and final transcripts, without the audio. */
export async function readTapEvents(
  page: Page
): Promise<Pick<CaptureTapSnapshot, "keys" | "completes">> {
  return await page.evaluate(() => {
    const tap = window.__voiceCaptureTap__;
    if (!tap) throw new Error("installCaptureTap() has not run in this view");
    return { keys: [...tap.keys], completes: [...tap.completes] };
  });
}

export async function readCaptureTap(page: Page): Promise<CaptureTapSnapshot> {
  const raw = await page.evaluate(() => {
    const tap = window.__voiceCaptureTap__;
    if (!tap) throw new Error("installCaptureTap() has not run in this view");
    const toBase64 = (buffer: ArrayBuffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    return {
      nodes: tap.nodes.map((node) => ({
        flushedAfter: node.flushedAfter,
        chunks: node.chunks.map(({ t, data }) => ({ t, data: toBase64(data) })),
      })),
      keys: [...tap.keys],
      completes: [...tap.completes],
    };
  });
  return {
    keys: raw.keys,
    completes: raw.completes,
    nodes: raw.nodes.map((node) => ({
      flushedAfter: node.flushedAfter,
      chunks: node.chunks.map(({ t, data }) => ({ t, bytes: Buffer.from(data, "base64") })),
    })),
  };
}

export interface Coverage {
  /** Captured chunks from the first non-silent one to the end of capture. */
  capturedChunks: number;
  /** Captured chunks whose bytes match an earlier one, so arrival can't tell them apart. */
  repeatedChunks: number;
  /** Chunks that never reached the provider, before the first one that did. */
  missingAtStart: number;
  /** Chunks that never reached the provider, after the last one that did. */
  missingAtEnd: number;
  /** Chunks that never reached the provider, or arrived out of order, between two that did. */
  missingInside: number;
  missingMsAtStart: number;
  missingMsAtEnd: number;
}

const digest = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

/**
 * Which captured chunks, from the first non-silent one on, the provider received, in order.
 * Audio crosses renderer, main and provider byte for byte, one message per chunk, so a chunk's
 * bytes identify it. Each chunk is looked for after the one before it: a replay may resend
 * audio the provider already sent, but a chunk that only arrives ahead of its predecessor
 * counts as lost.
 */
export function measureCoverage(
  captured: readonly Buffer[],
  received: readonly Buffer[]
): Coverage {
  const first = captured.findIndex((chunk) => pcmPeak(chunk) >= NON_SILENT_PEAK);
  const span = first < 0 ? [] : captured.slice(first);
  const spanKeys = span.map(digest);
  const receivedKeys = received.map(digest);
  let from = 0;
  const arrived = spanKeys.map((key) => {
    const at = receivedKeys.indexOf(key, from);
    if (at < 0) return false;
    from = at + 1;
    return true;
  });

  const head = arrived.indexOf(true);
  const tail = arrived.lastIndexOf(true);
  const ms = (chunks: readonly Buffer[]) =>
    Math.round(chunks.reduce((n, chunk) => n + chunk.length / 2, 0) / SAMPLES_PER_MS);
  const counts = {
    capturedChunks: span.length,
    repeatedChunks: span.length - new Set(spanKeys).size,
  };
  if (head < 0) {
    return {
      ...counts,
      missingAtStart: span.length,
      missingAtEnd: 0,
      missingInside: 0,
      missingMsAtStart: ms(span),
      missingMsAtEnd: 0,
    };
  }
  return {
    ...counts,
    missingAtStart: head,
    missingAtEnd: span.length - 1 - tail,
    missingInside: arrived.slice(head, tail + 1).filter((ok) => !ok).length,
    missingMsAtStart: ms(span.slice(0, head)),
    missingMsAtEnd: ms(span.slice(tail + 1)),
  };
}
