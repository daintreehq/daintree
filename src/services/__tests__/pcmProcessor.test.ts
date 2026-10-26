import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  posted: unknown[];
  postMessage: (message: unknown) => void;
}

interface Processor {
  port: WorkletPort;
  process: (inputs: Float32Array[][]) => boolean;
}

const source = readFileSync(resolve(__dirname, "../../../public/pcm-processor.js"), "utf8");

// The AudioWorklet global scope, reduced to what the processor touches. At a
// 24kHz context the ratio is 1, so each input sample becomes one output sample.
function loadProcessor(sampleRate = 24000): Processor {
  let ProcessorClass: (new () => Processor) | null = null;
  class AudioWorkletProcessor {
    port: WorkletPort = {
      onmessage: null,
      posted: [],
      postMessage(message: unknown) {
        this.posted.push(message);
      },
    };
  }
  runInNewContext(source, {
    AudioWorkletProcessor,
    sampleRate,
    registerProcessor: (_name: string, cls: new () => Processor) => {
      ProcessorClass = cls;
    },
  });
  if (!ProcessorClass) throw new Error("pcm-processor did not register");
  return new (ProcessorClass as new () => Processor)();
}

function feed(processor: Processor, samples: number, value = 0.5): void {
  processor.process([[new Float32Array(samples).fill(value)]]);
}

function send(processor: Processor, data: unknown): void {
  processor.port.onmessage?.({ data });
}

// The script runs in its own realm, so its buffers fail `instanceof ArrayBuffer`.
const isArrayBuffer = (m: unknown): m is ArrayBuffer =>
  Object.prototype.toString.call(m) === "[object ArrayBuffer]";

const chunkLengths = (posted: unknown[]) =>
  posted.filter(isArrayBuffer).map((b) => b.byteLength / 2);

describe("pcm-processor worklet", () => {
  it("posts the partial chunk it is still filling, then the flushed marker", () => {
    const processor = loadProcessor();
    feed(processor, 2400 + 640);
    expect(chunkLengths(processor.port.posted)).toEqual([2400]);

    send(processor, { type: "flush" });

    const posted = processor.port.posted;
    expect(chunkLengths(posted)).toEqual([2400, 640]);
    expect(posted.at(-1)).toEqual({ type: "flushed" });
    expect(Array.from(new Int16Array(posted[1] as ArrayBuffer).slice(0, 3))).toEqual([
      16384, 16384, 16384,
    ]);
  });

  it("answers a flush with only the marker when nothing is buffered", () => {
    const processor = loadProcessor();
    feed(processor, 2400);
    send(processor, { type: "flush" });
    expect(chunkLengths(processor.port.posted)).toEqual([2400]);
    expect(processor.port.posted.at(-1)).toEqual({ type: "flushed" });
  });

  it("emits nothing after the flushed marker", () => {
    const processor = loadProcessor();
    feed(processor, 100);
    send(processor, { type: "flush" });
    const afterFlush = processor.port.posted.length;

    feed(processor, 4800);
    send(processor, { type: "flush" });

    expect(processor.port.posted.slice(afterFlush)).toEqual([{ type: "flushed" }]);
  });

  // The AudioContext is reused across dictations, so a finished processor must
  // end itself rather than stay alive on the shared graph.
  it("ends itself once flushed", () => {
    const processor = loadProcessor();
    expect(processor.process([[new Float32Array(128)]])).toBe(true);
    send(processor, { type: "flush" });
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
  });

  it("ends itself when disposed, even with no input", () => {
    const processor = loadProcessor();
    expect(processor.process([])).toBe(true);
    send(processor, { type: "dispose" });

    expect(processor.process([])).toBe(false);
    feed(processor, 4800);
    expect(processor.port.posted).toEqual([]);
  });

  it("still flushes audio captured before a pause", () => {
    const processor = loadProcessor();
    feed(processor, 300);
    send(processor, { type: "setPaused", value: true });
    feed(processor, 2400);
    send(processor, { type: "flush" });
    expect(chunkLengths(processor.port.posted)).toEqual([300]);
  });

  it("downsamples to 24kHz before chunking", () => {
    const processor = loadProcessor(48000);
    feed(processor, 4800);
    send(processor, { type: "flush" });
    expect(chunkLengths(processor.port.posted)).toEqual([2400]);
  });
});
