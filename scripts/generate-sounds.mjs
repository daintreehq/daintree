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
// Just Intonation pitch palette (ratio × 440 Hz)
//
// Core: A-major pentatonic.  Ds5 (Lydian #4) adds a sense of wonder /
// discovery borrowed from the Zelda "item-get" language — brighter than
// plain major.  Used sparingly in the chime sound.
// ---------------------------------------------------------------------------
const JI = {
  A4: 440.0, // 1/1  — root
  B4: 495.0, // 9/8  — suspension / unresolved
  Cs5: 550.0, // 5/4  — brightness / affirmation
  Ds5: 618.75, // 45/32 — Lydian #4, wonder / discovery
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
// Modal synthesis (physically modeled stiff wooden bar / marimba)
//
// Unlike Karplus-Strong (which models flexible strings with integer
// harmonics), modal synthesis uses a bank of resonant bandpass filters
// tuned to the actual inharmonic mode ratios of a vibrating bar:
//
//   Mode 1: 1.000 × f   (fundamental)
//   Mode 2: 2.756 × f   (not an octave — this is what makes wood sound
//   Mode 3: 5.404 × f    like wood and not like a guitar string)
//   Mode 4: 8.933 × f
//
// Each mode is an independent resonator with its own decay rate.  Higher
// modes decay faster (wood absorbs HF energy), which gives the
// characteristic "bright attack, warm tail" of struck wooden instruments.
// ---------------------------------------------------------------------------

class ModalResonator {
  constructor(freq, q, gain) {
    // Biquad bandpass coefficients
    const w0 = (TWO_PI * freq) / SAMPLE_RATE;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (alpha * gain) / a0;
    this.b1 = 0;
    this.b2 = (-alpha * gain) / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
  process(input) {
    const y =
      this.b0 * input +
      this.b1 * this.x1 +
      this.b2 * this.x2 -
      this.a1 * this.y1 -
      this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class WoodModal {
  constructor(frequency, opts = {}) {
    const {
      // Mode ratios for a stiff rectangular bar (Euler-Bernoulli beam theory)
      modeRatios = [1.0, 2.756, 5.404, 8.933],
      // Amplitude per mode (higher modes are quieter)
      modeAmps = [1.0, 0.45, 0.2, 0.08],
      // Q factor per mode (higher modes ring less — wood absorbs HF)
      modeQs = [200, 120, 60, 30],
      // Material character: scales all Qs (lower = woodier/deader)
      resonance = 1.0,
      // Strike deformation: momentary sharp pitch on fundamental (Hz above true pitch)
      deformHz = 15,
      deformMs = 18,
    } = opts;

    this.modes = modeRatios
      .map((ratio, i) => {
        const modeFreq = frequency * ratio;
        if (modeFreq > SAMPLE_RATE * 0.45) return null;
        return new ModalResonator(modeFreq, modeQs[i] * resonance, modeAmps[i]);
      })
      .filter(Boolean);

    // Strike deformation: a brief, sharp resonator slightly above the
    // fundamental that decays very fast.  Simulates the momentary pitch
    // spike when wood is struck hard — the material deforms under impact
    // and its tension briefly increases before settling.
    if (deformHz > 0 && frequency + deformHz < SAMPLE_RATE * 0.45) {
      this.deformMode = new ModalResonator(frequency + deformHz, 40, 0.3);
      this.deformSamples = Math.ceil(SAMPLE_RATE * (deformMs / 1000));
    } else {
      this.deformMode = null;
      this.deformSamples = 0;
    }
    this.sampleIdx = 0;
  }

  process(excitation) {
    let out = 0;
    for (const mode of this.modes) {
      out += mode.process(excitation);
    }
    // Strike deformation fades in first N ms
    if (this.deformMode && this.sampleIdx < this.deformSamples) {
      const deformEnv = 1 - this.sampleIdx / this.deformSamples;
      out += this.deformMode.process(excitation) * deformEnv;
    }
    this.sampleIdx++;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Composite mallet exciter
//
// Two components:
//   1. Bandpass-filtered pink noise (surface contact / texture)
//   2. Low-frequency sine sweep 150→50Hz over 5ms (mallet mass / thump)
//
// The combination simulates a physical mallet with mass and surface
// hardness striking a bar — much more realistic than noise alone.
// ---------------------------------------------------------------------------

function generateExcitation(numSamples, opts = {}) {
  const {
    noiseBandHz = 1100,
    noiseQ = 2.0,
    noiseAmt = 0.6,
    thumpAmt = 0.35,
    thumpStartHz = 150,
    thumpEndHz = 50,
    duration = 0.006, // total excitation window
  } = opts;

  const excSamples = Math.ceil(SAMPLE_RATE * duration);
  const out = new Float32Array(numSamples); // zero-padded to full note length
  const bn = new BrownNoise(); // brown noise: darker, more organic friction
  const filt = new SVFilter();

  for (let i = 0; i < excSamples && i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = expDecay(t, duration, 8);

    // Noise component: mallet surface texture (brown = wood grain character)
    const noise = filt.bandpass(bn.next(), noiseBandHz, noiseQ) * noiseAmt;

    // Thump component: mallet mass (exponential freq sweep down)
    const thumpFreq = thumpStartHz * Math.pow(thumpEndHz / thumpStartHz, t / duration);
    const thump = Math.sin(TWO_PI * thumpFreq * t) * thumpAmt;

    out[i] = (noise + thump) * env;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Asymmetric waveshaper (even-harmonic warmth)
//
// Standard tanh is symmetrical → generates odd harmonics (hollow, digital).
// Adding a DC bias before clipping introduces even harmonics (2nd, 4th, 6th)
// which the ear perceives as warm and musical — the "tube/tape" character.
// The bias is subtracted afterward to re-center the waveform.
// ---------------------------------------------------------------------------

function waveshape(x, drive = 1.8, bias = 0.15) {
  return Math.tanh(x * drive + bias) - Math.tanh(bias);
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

/** Brown noise (integrated white noise, -6dB/octave).
 *  Darker and more rumbling than pink — sounds like organic friction,
 *  wood grain scraping, or distant thunder.  Better mallet excitation. */
class BrownNoise {
  constructor() {
    this.z = 0;
  }
  next() {
    const white = Math.random() * 2 - 1;
    this.z = (this.z + 0.02 * white) / 1.02; // leaky integrator
    return this.z * 3.5; // scale to roughly [-1, 1]
  }
}

// ---------------------------------------------------------------------------
// Canopy note synthesizer
//
// Architecture: serial excitation.  The FM "digital shimmer" and mallet
// noise are combined into a composite excitation signal that is fed INTO
// the modal wood resonators.  The wood model physically shapes everything
// — the digital component literally passes through the wood, fusing the
// two into one impossible material.  This is "digital ecology" expressed
// as DSP architecture, not just a metaphor.
//
// Signal flow:
//   [FM burst + mallet noise] → [Modal wood resonators] → [waveshape] → out
//                                                    ↑
//                              [detuned double adds organic width at output]
// ---------------------------------------------------------------------------

function canopyNote(freq, duration, opts = {}) {
  const {
    amplitude = 0.55,
    // Modal wood body
    resonance = 1.0, // material character (lower = deader wood)
    modeRatios, // override inharmonic mode ratios
    modeAmps, // override mode amplitudes
    modeQs, // override mode Q factors
    // FM excitation (digital shimmer fed INTO the wood)
    fmRatio = 1.4142, // √2 for standard woody, √3 for metallic
    fmIndex = 1.5,
    fmDecayRate = 16, // how fast the digital shimmer dies
    fmAmt = 0.5, // FM contribution to the excitation signal
    // Mallet excitation
    malletAmt = 0.5, // mallet noise+thump contribution
    noiseBandHz = 1100,
    noiseQ = 2.0,
    thumpAmt = 0.35,
    excDuration = 0.006, // mallet contact time
    // Detuned double (added at output, not through the wood)
    detuneMix = 0.12,
    // Pitch envelope (FM component only)
    pitchBendHz = 20,
    pitchBendMs = 12,
  } = opts;

  const numSamples = Math.ceil(SAMPLE_RATE * duration);
  const samples = new Float32Array(numSamples);

  // Modal resonator bank: the wood body
  const modalOpts = { resonance };
  if (modeRatios) modalOpts.modeRatios = modeRatios;
  if (modeAmps) modalOpts.modeAmps = modeAmps;
  if (modeQs) modalOpts.modeQs = modeQs;
  const wood = new WoodModal(freq, modalOpts);

  // FM oscillators for the digital excitation component
  const carrier = new PhaseOsc();
  const modulator = new PhaseOsc();

  // Detuned double oscillator (added at output for width)
  const detuned = new PhaseOsc();
  const detuneFactor = Math.pow(2, 3 / 1200); // +3 cents

  // Pre-generate the mallet excitation (noise + thump)
  const mallet = generateExcitation(numSamples, {
    noiseBandHz,
    noiseQ,
    noiseAmt: 0.6,
    thumpAmt,
    duration: excDuration,
  });

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;

    // --- FM excitation burst (decays quickly → digital shimmer) ---
    const pitchBendDur = pitchBendMs / 1000;
    const pitchOffset = t < pitchBendDur ? pitchBendHz * (1 - t / pitchBendDur) : 0;
    const f = freq + pitchOffset;
    const modFreq = f * fmRatio;
    const modEnv = expDecay(t, duration, fmDecayRate);
    const mod = modulator.next(modFreq) * fmIndex * modEnv;
    const fmSample = Math.sin(carrier.phase + mod) * modEnv; // envelope the FM output too
    carrier.phase += (TWO_PI * f) / SAMPLE_RATE;
    if (carrier.phase > TWO_PI) carrier.phase -= TWO_PI;

    // --- Composite excitation: FM + mallet, fed into the wood ---
    const excitation = fmSample * fmAmt + mallet[i] * malletAmt;

    // --- Modal wood resonators shape everything ---
    const woodSample = wood.process(excitation);

    // --- Detuned double at output (organic width, not through wood) ---
    const detunedSample = detuned.next(f * detuneFactor) * expDecay(t, duration, 6) * detuneMix;

    samples[i] = waveshape(woodSample + detunedSample) * amplitude;
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Multi-note sequencer
//
// BOTW lesson: humanized timing.  Slight rubato (±jitterMs) on note onsets
// makes sounds feel performed rather than mechanically triggered.
// ---------------------------------------------------------------------------

function sequence(notes, opts = {}) {
  const { noteGap = 0.0, tailPad = 0.1, jitterMs = 3 } = opts;

  // Pre-calculate jittered onset offsets (deterministic seed via index)
  const jitters = notes.map((_, i) => {
    // Simple deterministic pseudo-random per note index
    const seed = Math.sin(i * 9.1 + 0.7) * 43758.5453;
    return (seed - Math.floor(seed) - 0.5) * 2 * (jitterMs / 1000);
  });
  // First note always starts on time
  jitters[0] = 0;

  // Calculate total length
  let totalDuration = 0;
  for (let i = 0; i < notes.length; i++) {
    totalDuration += notes[i].duration + noteGap + Math.abs(jitters[i]);
  }
  totalDuration += tailPad;
  const totalSamples = Math.ceil(SAMPLE_RATE * totalDuration);
  const output = new Float32Array(totalSamples);

  let offsetSamples = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const jitteredOffset = Math.max(0, offsetSamples + Math.round(jitters[i] * SAMPLE_RATE));
    const noteDur = n.duration + tailPad;
    const noteSamples = canopyNote(n.freq, noteDur, n.opts || {});
    for (let j = 0; j < noteSamples.length && jitteredOffset + j < totalSamples; j++) {
      output[jitteredOffset + j] += noteSamples[j];
    }
    offsetSamples += Math.ceil(SAMPLE_RATE * (n.duration + noteGap));
  }

  return output;
}

// ---------------------------------------------------------------------------
// Post-processing: reverb + lowpass + normalization
// ---------------------------------------------------------------------------

function postProcess(samples, opts = {}) {
  const { reverbWet = 0.08, lpFreq = 4000, targetPeak = 0.7, chassisMix = 0.025 } = opts;

  const reverb = new Freeverb(reverbWet, 0.4);
  const lp = new OnePole(lpFreq);

  // Sympathetic chassis resonance: a shared, very quiet A4 resonator
  // that every sound excites.  Even error and waiting carry a whisper
  // of the brand root — this ties the entire sound family together
  // acoustically, like keys on the same wooden instrument body.
  const chassis = chassisMix > 0 ? new ModalResonator(JI.A4, 80, chassisMix) : null;

  // Apply chassis resonance, reverb, then lowpass
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (chassis) s += chassis.process(s);
    samples[i] = lp.process(reverb.process(s));
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
// Design principles:
//   1. Earthy core — modal wood resonators are the primary voice
//   2. Serial excitation — FM shimmer passes THROUGH the wood, not beside it
//   3. Dry UI — near-zero reverb; sounds feel like app chrome
//   4. Micro-feedback — short, sparse; 1-2 notes max
//   5. Material-per-meaning — wood resonance/hardness varies by semantic
//   6. Brand anchor — A4 → E5 (perfect fifth) woven through all sounds
// ---------------------------------------------------------------------------

// chime.wav — Lydian ascending pair A4→Ds5
// Light bamboo resonance with moderate FM excitation.  The digital shimmer
// passes through the wood modes, creating a hybrid "techno-bamboo" pluck.
const chime = postProcess(
  sequence(
    [
      {
        freq: JI.A4,
        duration: 0.1,
        opts: {
          resonance: 0.9,
          fmAmt: 0.5,
          fmIndex: 1.2,
          fmDecayRate: 14,
          malletAmt: 0.5,
          thumpAmt: 0.3,
        },
      },
      {
        freq: JI.Ds5,
        duration: 0.16,
        opts: {
          amplitude: 0.6,
          resonance: 0.95,
          fmAmt: 0.4,
          fmIndex: 0.8,
          fmDecayRate: 18,
          malletAmt: 0.55,
        },
      },
    ],
    { noteGap: 0.015, tailPad: 0.12 }
  ),
  { reverbWet: 0.02 }
);

// complete.wav — descending resolution E5→A4
// Warmer, more resonant wood.  The A4 root has higher resonance (longer
// ring) and less FM — the wood body dominates the tail, giving a warm
// marimba-bar settling feeling.
const complete = postProcess(
  sequence(
    [
      {
        freq: JI.E5,
        duration: 0.1,
        opts: {
          amplitude: 0.5,
          resonance: 0.9,
          fmAmt: 0.45,
          fmIndex: 0.8,
          fmDecayRate: 18,
          malletAmt: 0.55,
        },
      },
      {
        freq: JI.A4,
        duration: 0.22,
        opts: {
          amplitude: 0.6,
          resonance: 1.1, // more resonant — longer ring on the root
          fmAmt: 0.3, // less digital on the resolution note
          fmIndex: 0.6,
          fmDecayRate: 20,
          malletAmt: 0.6,
          thumpAmt: 0.4, // more mallet mass on the low note
        },
      },
    ],
    { noteGap: 0.025, tailPad: 0.14 }
  ),
  { reverbWet: 0.02 }
);

// waiting.wav — rising unresolved pair A4→B4
// Harder wood (higher resonance + brighter modes) with more FM excitation
// on the B4 — the digital component lingers longer, adding urgency.
const waiting = postProcess(
  sequence(
    [
      {
        freq: JI.A4,
        duration: 0.08,
        opts: {
          resonance: 0.85,
          fmAmt: 0.5,
          fmIndex: 1.3,
          malletAmt: 0.5,
        },
      },
      {
        freq: JI.B4,
        duration: 0.18,
        opts: {
          amplitude: 0.55,
          resonance: 0.95,
          fmAmt: 0.6, // more digital = more urgent
          fmIndex: 1.6,
          fmDecayRate: 10, // FM lingers longer on the tension note
          malletAmt: 0.4,
          noiseBandHz: 1300, // brighter strike
        },
      },
    ],
    { noteGap: 0.02, tailPad: 0.1 }
  ),
  { reverbWet: 0.02 }
);

// error.wav — single Cs5 with dense, dark wood character.
// Low resonance (dead wood), heavy mallet, FM at √3 ratio for metallic
// undertones.  The wood model shapes the metallic FM into something
// that sounds like striking a thick, dense branch.
const error = postProcess(
  canopyNote(JI.Cs5, 0.26, {
    amplitude: 0.55,
    resonance: 0.7, // dead wood — short ring, hollow
    modeQs: [150, 80, 40, 20], // lower Qs = faster decay, more percussive
    fmRatio: 1.7321, // √3 — metallic inharmonics
    fmAmt: 0.55,
    fmIndex: 2.2,
    fmDecayRate: 7, // metallic FM lingers
    malletAmt: 0.55,
    noiseBandHz: 800, // darker strike
    thumpAmt: 0.5, // heavier mallet
    pitchBendHz: 35,
    pitchBendMs: 20,
  }),
  { reverbWet: 0.01 }
);

// ping.wav — single kalimba pluck on E5.
// High resonance, minimal FM — the most purely "natural" sound.  The
// modal resonators do almost all the work; FM is just a tiny sparkle
// on the initial strike.
const ping = postProcess(
  canopyNote(JI.E5, 0.22, {
    amplitude: 0.5,
    resonance: 1.1, // resonant wood — clean ring
    fmAmt: 0.25, // barely there
    fmIndex: 0.5,
    fmDecayRate: 22, // gone almost instantly
    malletAmt: 0.65, // mostly mallet excitation
    detuneMix: 0.08,
    excDuration: 0.004, // very short contact = clean pluck
  }),
  { reverbWet: 0.02 }
);

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
