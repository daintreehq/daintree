import { describe, expect, it } from "vitest";
import {
  SIGNAL_PEAK_THRESHOLD,
  hasRealSignal,
  measurePcm16Chunk,
  summarizeOpeningChunks,
} from "../voiceStartDiagnostics";

describe("measurePcm16Chunk", () => {
  it("reports an all-zero chunk as fully zero with no signal", () => {
    const stats = measurePcm16Chunk(new Int16Array(2400));
    expect(stats).toEqual({ samples: 2400, rms: 0, peak: 0, zeroFraction: 1 });
    expect(hasRealSignal(stats)).toBe(false);
  });

  it("computes rms, absolute peak and zero fraction", () => {
    const stats = measurePcm16Chunk(Int16Array.from([0, 16384, -32768, 0]));
    expect(stats.samples).toBe(4);
    expect(stats.peak).toBe(1);
    expect(stats.zeroFraction).toBe(0.5);
    expect(stats.rms).toBeCloseTo(Math.sqrt((0.25 + 1) / 4), 10);
  });

  it("matches the per-sample normalised RMS the UI level used to compute", () => {
    const samples = Int16Array.from({ length: 480 }, (_, i) => Math.round(Math.sin(i / 7) * 9000));
    let sumSq = 0;
    for (const v of samples) sumSq += (v / 32768) ** 2;
    expect(measurePcm16Chunk(samples).rms).toBeCloseTo(Math.sqrt(sumSq / samples.length), 10);
  });

  it("treats an empty chunk as zero stats rather than NaN", () => {
    expect(measurePcm16Chunk(new Int16Array(0))).toEqual({
      samples: 0,
      rms: 0,
      peak: 0,
      zeroFraction: 0,
    });
  });

  it("separates near-silent dither from real signal at the peak threshold", () => {
    const threshold = Math.ceil(SIGNAL_PEAK_THRESHOLD * 32768);
    expect(hasRealSignal(measurePcm16Chunk(Int16Array.from([1, -2, 3, 0])))).toBe(false);
    expect(hasRealSignal(measurePcm16Chunk(Int16Array.from([0, threshold])))).toBe(true);
  });
});

describe("summarizeOpeningChunks", () => {
  it("counts only non-empty chunks that are entirely zero", () => {
    const zero = measurePcm16Chunk(new Int16Array(10));
    const empty = measurePcm16Chunk(new Int16Array(0));
    const live = measurePcm16Chunk(Int16Array.from([0, 1000, -1000, 0]));
    const summary = summarizeOpeningChunks([zero, zero, empty, live]);
    expect(summary.chunks).toBe(4);
    expect(summary.allZeroChunks).toBe(2);
    expect(summary.zeroFraction).toEqual([1, 1, 0, 0.5]);
    expect(summary.peak[3]).toBe(Number((1000 / 32768).toFixed(4)));
  });
});
