import { describe, expect, it } from "vitest";
import { createMelFilterbank, LocalSpeechMel, NEMOTRON_MEL_CONFIG } from "../localSpeechMel.js";

const CHUNK = 8960;
const MELS = NEMOTRON_MEL_CONFIG.numMels;

function sine(hz: number, samples: number, offset = 0, amplitude = 0.5): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * (i + offset)) / 16_000);
  }
  return out;
}

function process(mel: LocalSpeechMel, chunk: Float32Array): Float32Array {
  const out = new Float32Array(mel.framesFor(chunk.length) * MELS);
  mel.process(chunk, out);
  return out;
}

function loudestBin(frames: Float32Array, frame: number): number {
  let best = 0;
  for (let m = 1; m < MELS; m++) {
    if (frames[frame * MELS + m] > frames[frame * MELS + best]) best = m;
  }
  return best;
}

describe("createMelFilterbank", () => {
  it("covers every FFT bin up to Nyquist with area-normalised triangles", () => {
    const fb = createMelFilterbank(MELS, 512, 16_000);
    const bins = 257;
    for (let m = 0; m < MELS; m++) {
      let peak = 0;
      for (let k = 0; k < bins; k++) peak = Math.max(peak, fb[m * bins + k]);
      expect(peak).toBeGreaterThan(0);
    }
    // Slaney normalisation: wider (higher) filters are lower.
    const peakOf = (m: number) => Math.max(...fb.subarray(m * bins, (m + 1) * bins));
    expect(peakOf(MELS - 1)).toBeLessThan(peakOf(10));
  });
});

describe("LocalSpeechMel", () => {
  it("yields 56 frames for a 560 ms chunk", () => {
    expect(new LocalSpeechMel().framesFor(CHUNK)).toBe(56);
  });

  it("floors silence at ln(2^-24)", () => {
    const frames = process(new LocalSpeechMel(), new Float32Array(CHUNK));
    const floor = Math.log(2 ** -24);
    for (const value of frames) expect(value).toBeCloseTo(floor, 5);
  });

  it("puts a tone's energy in the mel band that holds its frequency", () => {
    const low = process(new LocalSpeechMel(), sine(300, CHUNK));
    const high = process(new LocalSpeechMel(), sine(3000, CHUNK));
    expect(loudestBin(high, 20)).toBeGreaterThan(loudestBin(low, 20) + 20);
  });

  it("carries context across chunks: a stream reads the same as its own continuation", () => {
    const tone = sine(440, CHUNK * 2);
    const streamed = new LocalSpeechMel();
    process(streamed, tone.subarray(0, CHUNK));
    const second = process(streamed, tone.subarray(CHUNK));
    const cold = process(new LocalSpeechMel(), tone.subarray(CHUNK));
    // A cold start sees silence before its first frame; a stream sees the tone.
    expect(Math.abs(second[0] - cold[0])).toBeGreaterThan(0.1);
    // Past the first window both read the same steady tone.
    expect(second[30 * MELS + 10]).toBeCloseTo(cold[30 * MELS + 10], 3);
  });

  it("forgets the stream on reset", () => {
    const mel = new LocalSpeechMel();
    process(mel, sine(440, CHUNK));
    mel.reset();
    const afterReset = process(mel, sine(440, CHUNK));
    const fresh = process(new LocalSpeechMel(), sine(440, CHUNK));
    expect(Array.from(afterReset)).toEqual(Array.from(fresh));
  });

  it("writes from the offset it is given, leaving what comes before", () => {
    const out = new Float32Array((9 + 56) * MELS).fill(7);
    new LocalSpeechMel().process(new Float32Array(CHUNK), out, 9 * MELS);
    expect(out[9 * MELS - 1]).toBe(7);
    expect(out[9 * MELS]).not.toBe(7);
  });
});
