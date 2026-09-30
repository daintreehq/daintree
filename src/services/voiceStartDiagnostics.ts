/** Number of opening worklet chunks (~100ms each) summarised after a dictation start. */
export const OPENING_CHUNK_WINDOW = 20;

/**
 * Amplitude floor (~-54 dBFS) for "above-threshold signal". A heuristic, not
 * speech detection: a transient can cross it and very quiet speech can sit
 * under it. It exists to separate exact zeros (a muted track, or Chromium
 * zero-filling an underrunning input FIFO) and near-zero warm-up dither from a
 * mic that is plainly delivering audio.
 */
export const SIGNAL_PEAK_THRESHOLD = 0.002;

export interface PcmChunkStats {
  samples: number;
  rms: number;
  peak: number;
  zeroFraction: number;
}

export function measurePcm16Chunk(samples: Int16Array): PcmChunkStats {
  const n = samples.length;
  if (n === 0) return { samples: 0, rms: 0, peak: 0, zeroFraction: 0 };
  let sumSq = 0;
  let peak = 0;
  let zeros = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    if (v === 0) {
      zeros++;
      continue;
    }
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return {
    samples: n,
    rms: Math.sqrt(sumSq / n) / 32768,
    peak: peak / 32768,
    zeroFraction: zeros / n,
  };
}

export function hasRealSignal(stats: PcmChunkStats): boolean {
  return stats.peak >= SIGNAL_PEAK_THRESHOLD;
}

const round4 = (value: number) => Number(value.toFixed(4));

/**
 * Compact per-chunk rows for the opening-window log line. Arrays of numbers,
 * not objects, so twenty chunks stay one readable line.
 */
export function summarizeOpeningChunks(chunks: readonly PcmChunkStats[]): {
  chunks: number;
  allZeroChunks: number;
  rms: number[];
  peak: number[];
  zeroFraction: number[];
} {
  return {
    chunks: chunks.length,
    allZeroChunks: chunks.filter((c) => c.samples > 0 && c.zeroFraction === 1).length,
    rms: chunks.map((c) => round4(c.rms)),
    peak: chunks.map((c) => round4(c.peak)),
    zeroFraction: chunks.map((c) => round4(c.zeroFraction)),
  };
}
