import { describe, expect, it } from "vitest";
import { pcm16ToFloat, Resampler24kTo16k } from "../localSpeechAudio.js";

function sine24k(hz: number, samples: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / 24_000);
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function zeroCrossings(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 !== samples[i] < 0) count++;
  }
  return count;
}

describe("pcm16ToFloat", () => {
  it("scales little-endian PCM16 to [-1, 1)", () => {
    const pcm = new Int16Array([0, 16384, -32768, 32767]);
    expect(Array.from(pcm16ToFloat(pcm.buffer))).toEqual([0, 0.5, -1, 32767 / 32768]);
  });
});

describe("Resampler24kTo16k", () => {
  it("keeps two samples of every three", () => {
    const resampler = new Resampler24kTo16k();
    const out = concat([resampler.push(sine24k(440, 24_000)), resampler.flush()]);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(2);
  });

  it("gives the same samples however the input is split into packets", () => {
    const input = sine24k(1000, 7_200);
    const whole = new Resampler24kTo16k();
    const once = concat([whole.push(input), whole.flush()]);
    const split = new Resampler24kTo16k();
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 2_400) parts.push(split.push(input.subarray(i, i + 2_400)));
    parts.push(split.flush());
    const packets = concat(parts);
    expect(packets.length).toBe(once.length);
    for (let i = 0; i < once.length; i++) expect(packets[i]).toBeCloseTo(once[i], 6);
  });

  it("keeps a tone's pitch", () => {
    const resampler = new Resampler24kTo16k();
    const out = resampler.push(sine24k(500, 24_000));
    // 500 Hz crosses zero 1,000 times a second, whatever the sample rate.
    expect(Math.abs(zeroCrossings(out) / (out.length / 16_000) - 1000)).toBeLessThan(10);
  });

  it("filters out what the lower rate can't hold", () => {
    const resampler = new Resampler24kTo16k();
    const out = resampler.push(sine24k(10_000, 24_000)).subarray(100);
    const rms = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0) / out.length);
    expect(rms).toBeLessThan(0.02);
  });
});
