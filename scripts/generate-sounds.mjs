#!/usr/bin/env node
/**
 * Generate Canopy notification sounds.
 *
 * Design language: "digital ecology" — organic strike transients,
 * FM-synthesis body with woody inharmonicity, subtle natural-space
 * reverb, all built on a Just Intonation A-major pentatonic scale.
 *
 * Run with: node scripts/generate-sounds.mjs
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../electron/resources/sounds");
mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 44100;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
// Just Intonation A-major pentatonic (ratio × 440 Hz)
// ---------------------------------------------------------------------------
const JI = {
  A4: 440.0, // 1/1  — root
  B4: 495.0, // 9/8  — suspension / unresolved
  Cs5: 550.0, // 5/4  — brightness / affirmation
  E5: 660.0, // 3/2  — stability / completion
  Fs5: 733.33, // 5/3  — elevation / alertness
};

// ---------------------------------------------------------------------------
// DSP primitives
// ---------------------------------------------------------------------------

/** Phase-accumulating oscillator (click-free under frequency changes). */
class PhaseOsc {
  constructor() {
    this.phase = 0;
  }
  next(freq) {
    this.phase += (TWO_PI * freq) / SAMPLE_RATE;
    if (this.phase > TWO_PI) this.phase -= TWO_PI;
    return Math.sin(this.phase);
  }
}

/** ADSR envelope (times in seconds, all exponential curves). */
class Envelope {
  constructor(attack, decay, sustain, release, totalDuration) {
    this.a = Math.max(attack, 0.001);
    this.d = decay;
    this.s = sustain;
    this.r = Math.max(release, 0.001);
    this.total = totalDuration;
  }
  at(t) {
    if (t < this.a) {
      // Exponential attack (avoid true zero)
      return Math.pow(t / this.a, 2);
    }
    const decayT = t - this.a;
    if (decayT < this.d) {
      const frac = decayT / this.d;
      return 1.0 - (1.0 - this.s) * (1 - Math.exp(-5 * frac));
    }
    const sustainEnd = this.total - this.r;
    if (t < sustainEnd) return this.s;
    const releaseT = t - sustainEnd;
    return this.s * Math.exp((-6 * releaseT) / this.r);
  }
}

/** Simple exponential decay — the common case for short percussive sounds. */
function expDecay(t, duration, rate = 5) {
  return Math.exp((-rate * t) / duration);
}

/** State-variable bandpass filter. */
class SVFilter {
  constructor() {
    this.ic1eq = 0;
    this.ic2eq = 0;
  }
  bandpass(input, freq, q) {
    const g = Math.tan((Math.PI * freq) / SAMPLE_RATE);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.ic2eq;
    const v1 = a1 * this.ic1eq + a2 * v3;
    const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    return v1;
  }
}

/** One-pole low-pass filter for gentle HF rolloff. */
class OnePole {
  constructor(freq) {
    const fc = freq / SAMPLE_RATE;
    this.a = Math.exp(-TWO_PI * fc);
    this.b = 1 - this.a;
    this.z = 0;
  }
  process(x) {
    this.z = x * this.b + this.z * this.a;
    return this.z;
  }
}

// ---------------------------------------------------------------------------
// Freeverb (lowpass-feedback comb filters + series allpass)
// ---------------------------------------------------------------------------

class LowpassCombFilter {
  constructor(delaySamples, feedback, damping) {
    this.buf = new Float32Array(delaySamples);
    this.len = delaySamples;
    this.idx = 0;
    this.feedback = feedback;
    this.damping = damping;
    this.filterStore = 0;
  }
  process(input) {
    const out = this.buf[this.idx];
    this.filterStore = out * (1 - this.damping) + this.filterStore * this.damping;
    this.buf[this.idx] = input + this.filterStore * this.feedback;
    if (++this.idx >= this.len) this.idx = 0;
    return out;
  }
}

class AllpassFilter {
  constructor(delaySamples, feedback) {
    this.buf = new Float32Array(delaySamples);
    this.len = delaySamples;
    this.idx = 0;
    this.feedback = feedback;
  }
  process(input) {
    const delayed = this.buf[this.idx];
    this.buf[this.idx] = input + delayed * this.feedback;
    if (++this.idx >= this.len) this.idx = 0;
    return -input + delayed;
  }
}

class Freeverb {
  constructor(wet = 0.08, damping = 0.4) {
    // Prime-number delay lengths for a small natural space (RT60 < 500ms)
    this.combs = [
      new LowpassCombFilter(487, 0.75, damping),
      new LowpassCombFilter(577, 0.73, damping),
      new LowpassCombFilter(673, 0.71, damping),
      new LowpassCombFilter(751, 0.69, damping),
    ];
    this.allpasses = [new AllpassFilter(223, 0.7), new AllpassFilter(73, 0.7)];
    this.wet = wet;
    this.dry = 1.0;
  }
  process(input) {
    let combSum = 0;
    for (const c of this.combs) combSum += c.process(input);
    let out = combSum * 0.25;
    for (const a of this.allpasses) out = a.process(out);
    return input * this.dry + out * this.wet;
  }
}

// ---------------------------------------------------------------------------
// Waveshaper (tanh soft-clip for warmth)
// ---------------------------------------------------------------------------

function waveshape(x, drive = 1.8) {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

// ---------------------------------------------------------------------------
// Pink-ish noise via Paul Kellet's approximation
// ---------------------------------------------------------------------------

class PinkNoise {
  constructor() {
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
  }
  next() {
    const white = Math.random() * 2 - 1;
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.969 * this.b2 + white * 0.153852;
    this.b3 = 0.8665 * this.b3 + white * 0.3104856;
    this.b4 = 0.55 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.016898;
    const pink =
      this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    return pink * 0.11; // normalize roughly to [-1, 1]
  }
}

// ---------------------------------------------------------------------------
// Canopy note synthesizer
//
// Layers:
//   1. FM body   — carrier sine + modulator (ratio 1:√2 for woody inharmonicity)
//   2. Harmonics — even-biased additive (2nd, 3rd, 4th partial)
//   3. Detuned double — second oscillator +3 cents for organic width
//   4. Noise transient — bandpass-filtered pink noise "strike"
//   5. Pitch envelope — subtle downward bend on attack
// ---------------------------------------------------------------------------

function canopyNote(freq, duration, opts = {}) {
  const {
    amplitude = 0.55,
    attack = 0.018,
    fmRatio = 1.4142, // √2 — woody/bell inharmonicity
    fmIndex = 1.5,
    fmDecayRate = 12,
    noiseAmt = 0.15,
    noiseBandHz = 1000,
    noiseQ = 2.0,
    noiseDuration = 0.008,
    pitchBendHz = 30,
    pitchBendMs = 20,
  } = opts;

  const numSamples = Math.ceil(SAMPLE_RATE * duration);
  const samples = new Float32Array(numSamples);

  const carrier = new PhaseOsc();
  const modulator = new PhaseOsc();
  const detuned = new PhaseOsc();
  const noiseGen = new PinkNoise();
  const noiseFilt = new SVFilter();

  const detuneFactor = Math.pow(2, 3 / 1200); // +3 cents

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;

    // Envelope: fast exponential attack + exponential decay (no sustain)
    const attackEnv = i < attack * SAMPLE_RATE ? Math.pow(t / attack, 2) : 1.0;
    const decayEnv = expDecay(t, duration, 4.5);
    const env = attackEnv * decayEnv;

    // Pitch envelope: subtle downward bend
    const pitchBendDur = pitchBendMs / 1000;
    const pitchOffset = t < pitchBendDur ? pitchBendHz * (1 - t / pitchBendDur) : 0;
    const f = freq + pitchOffset;

    // FM body
    const modFreq = f * fmRatio;
    const modEnv = expDecay(t, duration, fmDecayRate);
    const mod = modulator.next(modFreq) * fmIndex * modEnv;
    const fmSample = Math.sin(carrier.phase + mod);
    carrier.phase += (TWO_PI * f) / SAMPLE_RATE;
    if (carrier.phase > TWO_PI) carrier.phase -= TWO_PI;

    // Detuned double for organic width
    const detunedSample = detuned.next(f * detuneFactor);

    // Even-biased harmonics (2nd, 3rd, 4th with warm rolloff: 1/n^1.7)
    const h2 = Math.sin(carrier.phase * 2) * (1 / Math.pow(2, 1.7));
    const h3 = Math.sin(carrier.phase * 3) * (1 / Math.pow(3, 1.7));
    const h4 = Math.sin(carrier.phase * 4) * (1 / Math.pow(4, 1.7));

    // Mix tonal components
    let tonal = fmSample * 0.5 + detunedSample * 0.35 + (h2 + h3 + h4) * 0.15;

    // Noise transient (strike texture)
    let noise = 0;
    if (t < noiseDuration) {
      const noiseEnv = expDecay(t, noiseDuration, 8);
      noise = noiseFilt.bandpass(noiseGen.next(), noiseBandHz, noiseQ) * noiseEnv * noiseAmt;
    }

    // Combine and shape
    samples[i] = waveshape(tonal + noise) * env * amplitude;
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Multi-note sequencer — arpeggiates canopyNote() calls
// ---------------------------------------------------------------------------

function sequence(notes, opts = {}) {
  const { noteGap = 0.0, tailPad = 0.15 } = opts;

  // Calculate total length
  let totalDuration = 0;
  for (const n of notes) totalDuration += n.duration + noteGap;
  totalDuration += tailPad; // extra tail for reverb
  const totalSamples = Math.ceil(SAMPLE_RATE * totalDuration);
  const output = new Float32Array(totalSamples);

  let offsetSamples = 0;
  for (const n of notes) {
    // Allow note duration + tail so reverb/decay can ring
    const noteDur = n.duration + tailPad;
    const noteSamples = canopyNote(n.freq, noteDur, n.opts || {});
    for (let i = 0; i < noteSamples.length && offsetSamples + i < totalSamples; i++) {
      output[offsetSamples + i] += noteSamples[i];
    }
    offsetSamples += Math.ceil(SAMPLE_RATE * (n.duration + noteGap));
  }

  return output;
}

// ---------------------------------------------------------------------------
// Post-processing: reverb + lowpass + normalization
// ---------------------------------------------------------------------------

function postProcess(samples, opts = {}) {
  const { reverbWet = 0.08, lpFreq = 4000, targetPeak = 0.7 } = opts;

  const reverb = new Freeverb(reverbWet, 0.4);
  const lp = new OnePole(lpFreq);

  // Apply reverb then lowpass
  for (let i = 0; i < samples.length; i++) {
    samples[i] = lp.process(reverb.process(samples[i]));
  }

  // Normalize to target peak
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    const gain = targetPeak / peak;
    for (let i = 0; i < samples.length; i++) {
      samples[i] *= gain;
    }
  }

  // Fade out last 20ms to avoid any click at the end
  const fadeSamples = Math.min(Math.floor(SAMPLE_RATE * 0.02), samples.length);
  for (let i = 0; i < fadeSamples; i++) {
    const idx = samples.length - fadeSamples + i;
    samples[idx] *= i / fadeSamples;
  }

  return samples;
}

// ---------------------------------------------------------------------------
// WAV writer (16-bit mono PCM)
// ---------------------------------------------------------------------------

function writeWav(samples, filePath) {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);

  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const pcm = clamped < 0 ? clamped * 32768 : clamped * 32767;
    buf.writeInt16LE(Math.round(pcm), 44 + i * 2);
  }

  writeFileSync(filePath, buf);
}

// ---------------------------------------------------------------------------
// Sound definitions — the Canopy palette
//
// Brand anchor interval: A4 → E5 (perfect fifth, 3:2 ratio)
// All sounds share the same FM timbre, scale, and reverb space.
// ---------------------------------------------------------------------------

// chime.wav — ascending arpeggio A4→C#5→E5, warm greeting / general notification
const chime = postProcess(
  sequence(
    [
      { freq: JI.A4, duration: 0.14 },
      { freq: JI.Cs5, duration: 0.14 },
      { freq: JI.E5, duration: 0.22, opts: { amplitude: 0.6 } },
    ],
    { noteGap: 0.02 }
  ),
  { reverbWet: 0.1 }
);

// complete.wav — descending resolution E5→C#5→A4, "task settled"
const complete = postProcess(
  sequence(
    [
      { freq: JI.E5, duration: 0.12, opts: { amplitude: 0.5 } },
      { freq: JI.Cs5, duration: 0.12, opts: { amplitude: 0.55 } },
      { freq: JI.A4, duration: 0.25, opts: { amplitude: 0.6 } },
    ],
    { noteGap: 0.02 }
  ),
  { reverbWet: 0.1 }
);

// waiting.wav — rise then suspend A4→E5→B4, "needs your attention"
const waiting = postProcess(
  sequence(
    [
      { freq: JI.A4, duration: 0.1 },
      { freq: JI.E5, duration: 0.1, opts: { amplitude: 0.55 } },
      { freq: JI.B4, duration: 0.2, opts: { amplitude: 0.5, fmIndex: 1.8 } },
    ],
    { noteGap: 0.015 }
  ),
  { reverbWet: 0.08 }
);

// error.wav — wide descending leap F#5→B4, concern without panic
const error = postProcess(
  sequence(
    [
      {
        freq: JI.Fs5,
        duration: 0.12,
        opts: { amplitude: 0.5, fmIndex: 2.0, fmDecayRate: 8 },
      },
      {
        freq: JI.B4,
        duration: 0.22,
        opts: { amplitude: 0.55, fmIndex: 2.0, fmDecayRate: 6 },
      },
    ],
    { noteGap: 0.02 }
  ),
  { reverbWet: 0.06 }
);

// ping.wav — single bright note E5, quick acknowledgment
const ping = postProcess(canopyNote(JI.E5, 0.25, { amplitude: 0.5 }), { reverbWet: 0.1 });

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

const sounds = { chime, complete, waiting, error, ping };

for (const [name, samples] of Object.entries(sounds)) {
  const filePath = join(outDir, `${name}.wav`);
  writeWav(samples, filePath);
  const sizeKB = (Buffer.byteLength(Buffer.alloc(44 + samples.length * 2)) / 1024).toFixed(1);
  const durationMs = ((samples.length / SAMPLE_RATE) * 1000).toFixed(0);
  console.log(`  ${name}.wav  ${durationMs}ms  ${sizeKB}KB`);
}

console.log(`\nSounds written to ${outDir}`);
