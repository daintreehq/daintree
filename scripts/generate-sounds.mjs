#!/usr/bin/env node
/**
 * Generate Daintree notification sounds.
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
// Seeded PRNG (mulberry32) — deterministic builds, reproducible WAVs.
// Seed can be changed to generate a different "take" of the same sounds.
// ---------------------------------------------------------------------------
const SEED = 0xca0917; // change this to re-roll all randomness
let _seed = SEED;
function seedReset(s = SEED) {
  _seed = s;
}
function rand() {
  _seed |= 0;
  _seed = (_seed + 0x6d2b79f5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Random float in [-1, 1] */
function rand2() {
  return rand() * 2 - 1;
}

// ---------------------------------------------------------------------------
// Variant generation
//
// The key insight from game audio: varying GLOBAL parameters (FM index,
// resonance) produces imperceptible differences.  What actually makes
// strikes sound different is varying WHICH HARMONICS are excited — the
// spectral envelope.  Hitting a marimba bar in the center excites the
// fundamental strongly; hitting near the edge excites upper partials.
//
// Each variant is the same bar struck in a slightly different spot with
// slightly different hand tension.  The "identity core" (gesture contour,
// transient shape, spectral region) is INVARIANT.  Only micro-features
// change: pitch ±20 cents, volume ±1dB, transient emphasis, spectral tilt.
//
// Research sweet spots (mobile game audio / psychoacoustics):
//   Pitch:    ±15-20 cents  (below conscious detection, above SSA threshold)
//   Volume:   ±0.9-1.1x     (~±1dB)
//   Noise:    ±10%          (strike texture)
//   Timing:   ±5-15ms       (handled by sequence jitter, not here)
//   Modes:    ±15-25% on upper partials only (fundamental stays at 1.0)
// ---------------------------------------------------------------------------

const VARIANT_COUNT = 4;

const VARIANTS = [
  // v0: center strike — the canonical sound
  {
    pitchCents: 0,
    modeAmpMul: [1.0, 1.0, 1.0, 1.0],
    modeFreqShift: [0, 0, 0, 0],
    dropMode: -1,
    fmIndex: 1.0,
    fmAmt: 1.0,
    fmDecayRate: 1.0,
    malletAmt: 1.0,
    thumpAmt: 1.0,
    noiseBandHz: 1.0,
    excDuration: 1.0,
    presenceAmt: 1.0,
    presenceHz: 1.0,
    resonance: 1.0,
  },
  // v1: slightly off-center, marginally softer — upper partials reduced,
  //     a touch more mallet weight, slightly sharp pitch
  {
    pitchCents: 15,
    modeAmpMul: [1.0, 0.8, 0.75, 0.6],
    modeFreqShift: [0, -8, -12, 5],
    dropMode: -1,
    fmIndex: 0.85,
    fmAmt: 0.9,
    fmDecayRate: 1.15,
    malletAmt: 1.1,
    thumpAmt: 1.15,
    noiseBandHz: 0.9,
    excDuration: 1.15,
    presenceAmt: 0.85,
    presenceHz: 0.96,
    resonance: 1.04,
  },
  // v2: slightly brighter strike — upper partials boosted, a touch more
  //     FM shimmer, slightly shorter contact, flat pitch
  {
    pitchCents: -12,
    modeAmpMul: [1.0, 1.15, 1.25, 1.1],
    modeFreqShift: [0, 10, 15, -5],
    dropMode: -1,
    fmIndex: 1.2,
    fmAmt: 1.12,
    fmDecayRate: 0.88,
    malletAmt: 0.92,
    thumpAmt: 0.85,
    noiseBandHz: 1.12,
    excDuration: 0.85,
    presenceAmt: 1.2,
    presenceHz: 1.06,
    resonance: 0.95,
  },
  // v3: slightly warmer, more body — 2nd partial a touch louder, 3rd/4th
  //     a touch quieter, marginally more thump, sharp pitch
  {
    pitchCents: 8,
    modeAmpMul: [1.0, 1.1, 0.8, 0.7],
    modeFreqShift: [0, 5, -8, 10],
    dropMode: -1,
    fmIndex: 0.9,
    fmAmt: 0.95,
    fmDecayRate: 1.08,
    malletAmt: 1.08,
    thumpAmt: 1.1,
    noiseBandHz: 0.95,
    excDuration: 1.1,
    presenceAmt: 0.9,
    presenceHz: 0.98,
    resonance: 1.02,
  },
];

/** Apply variant to a note's opts.  Injects per-mode overrides that
 *  WoodModal will pick up via modeAmps / modeFreqShifts arrays. */
function applyVariant(opts, variantIdx) {
  if (variantIdx === 0) return opts;
  const v = VARIANTS[variantIdx];
  const tweaked = { ...opts };

  // Per-mode spectral overrides — the biggest lever for audible variation
  tweaked._modeAmpMul = v.modeAmpMul;
  tweaked._modeFreqShift = v.modeFreqShift;
  tweaked._dropMode = v.dropMode;
  tweaked._pitchCents = v.pitchCents || 0;

  // Global parameter scaling
  if (tweaked.fmIndex != null) tweaked.fmIndex *= v.fmIndex;
  if (tweaked.fmAmt != null) tweaked.fmAmt *= v.fmAmt;
  if (tweaked.fmDecayRate != null) tweaked.fmDecayRate *= v.fmDecayRate;
  if (tweaked.malletAmt != null) tweaked.malletAmt *= v.malletAmt;
  if (tweaked.thumpAmt != null) tweaked.thumpAmt *= v.thumpAmt;
  if (tweaked.noiseBandHz != null) tweaked.noiseBandHz *= v.noiseBandHz;
  if (tweaked.excDuration != null) tweaked.excDuration *= v.excDuration;
  if (tweaked.attackPresenceAmt != null) tweaked.attackPresenceAmt *= v.presenceAmt;
  if (tweaked.attackPresenceHz != null) tweaked.attackPresenceHz *= v.presenceHz;
  if (tweaked.resonance != null && v.resonance) tweaked.resonance *= v.resonance;
  return tweaked;
}

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
  A5: 880.0, // 2/1  — octave, full resolution
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

/** DC blocker — removes DC offset introduced by asymmetric waveshaping.
 *  High-pass at ~14Hz (inaudible), keeps waveform centered at zero. */
class DCBlocker {
  constructor(r = 0.995) {
    this.r = r;
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
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
      // Variant overrides: per-mode amplitude multipliers and freq shifts
      _modeAmpMul, // [1.0, 0.3, 0.15, 0.0] — vary which partials ring
      _modeFreqShift, // [0, -15, -25, 0] — cents shift per mode
      _dropMode = -1, // index to mute entirely (-1 = none)
    } = opts;

    this.modes = modeRatios
      .map((ratio, i) => {
        // Drop this mode entirely if variant says so
        if (i === _dropMode) return null;

        let modeFreq = frequency * ratio;

        // Apply per-mode frequency shift (in cents) for upper partials
        if (_modeFreqShift && i > 0 && _modeFreqShift[i]) {
          modeFreq *= Math.pow(2, _modeFreqShift[i] / 1200);
        }

        if (modeFreq > SAMPLE_RATE * 0.45) return null;

        // Apply per-mode amplitude multiplier (the biggest audible lever)
        let amp = modeAmps[i];
        if (_modeAmpMul && _modeAmpMul[i] !== undefined) {
          amp *= _modeAmpMul[i];
        }

        return new ModalResonator(modeFreq, modeQs[i] * resonance, amp);
      })
      .filter(Boolean);

    // Split-fundamental beating
    const shadowFreq = frequency * 1.004;
    if (shadowFreq < SAMPLE_RATE * 0.45) {
      this.modes.push(new ModalResonator(shadowFreq, modeQs[0] * resonance * 0.9, 0.25));
    }

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

  // Strike zone micro-variance: a real mallet never hits the exact same
  // spot twice.  ±5% jitter on the noise band and thump frequency adds
  // organic texture to the static WAV without affecting pitch stability.
  const jitter = () => 0.95 + rand() * 0.1;
  const jitteredBandHz = noiseBandHz * jitter();
  const jitteredThumpStart = thumpStartHz * jitter();

  const excSamples = Math.ceil(SAMPLE_RATE * duration);
  const out = new Float32Array(numSamples); // zero-padded to full note length
  const bn = new BrownNoise(); // brown noise: darker, more organic friction
  const filt = new SVFilter();

  for (let i = 0; i < excSamples && i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = expDecay(t, duration, 8);

    // Noise component: mallet surface texture (brown = wood grain character)
    const noise = filt.bandpass(bn.next(), jitteredBandHz, noiseQ) * noiseAmt;

    // Thump component: mallet mass (exponential freq sweep down)
    const thumpFreq = jitteredThumpStart * Math.pow(thumpEndHz / jitteredThumpStart, t / duration);
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
    const white = rand() * 2 - 1;
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
    const white = rand() * 2 - 1;
    this.z = (this.z + 0.02 * white) / 1.02; // leaky integrator
    return this.z * 3.5; // scale to roughly [-1, 1]
  }
}

// ---------------------------------------------------------------------------
// Daintree note synthesizer
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

function daintreeNote(freq, duration, opts = {}) {
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
    // Attack fingerprint: a short presence burst in the 1.8-3.2kHz range
    // that aids fast recognition on laptop speakers.  Different center
    // frequency and hardness per cue creates an identity in the first 80ms
    // that the 4kHz lowpass would otherwise suppress.
    attackPresenceHz = 2400, // center frequency of the presence burst
    attackPresenceQ = 1.5, // Q of the presence band (lower = wider)
    attackPresenceAmt = 0.0, // 0 = off; typical range 0.08-0.20
    attackPresenceMs = 10, // duration of the presence burst
  } = opts;

  const numSamples = Math.ceil(SAMPLE_RATE * duration);
  const samples = new Float32Array(numSamples);

  // Modal resonator bank: the wood body
  const modalOpts = { resonance };
  if (modeRatios) modalOpts.modeRatios = modeRatios;
  if (modeAmps) modalOpts.modeAmps = modeAmps;
  if (modeQs) modalOpts.modeQs = modeQs;
  // Pass variant spectral overrides through to WoodModal
  if (opts._modeAmpMul) modalOpts._modeAmpMul = opts._modeAmpMul;
  if (opts._modeFreqShift) modalOpts._modeFreqShift = opts._modeFreqShift;
  if (opts._dropMode != null) modalOpts._dropMode = opts._dropMode;
  const wood = new WoodModal(freq, modalOpts);

  // FM oscillators for the digital excitation component
  const carrier = new PhaseOsc();
  const modulator = new PhaseOsc();

  // Detuned double oscillator (added at output for width)
  const detuned = new PhaseOsc();
  const detuneFactor = Math.pow(2, 3 / 1200); // +3 cents

  // Attack presence fingerprint filter (identity in first 80ms)
  const presenceFilt = attackPresenceAmt > 0 ? new SVFilter() : null;
  const presenceSamples = Math.ceil(SAMPLE_RATE * (attackPresenceMs / 1000));

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

    // --- Attack presence fingerprint (laptop speaker discrimination) ---
    let presence = 0;
    if (presenceFilt && i < presenceSamples) {
      const presEnv = expDecay(t, attackPresenceMs / 1000, 6);
      presence =
        presenceFilt.bandpass(rand2() * 0.5, attackPresenceHz, attackPresenceQ) *
        presEnv *
        attackPresenceAmt;
    }

    samples[i] = waveshape(woodSample + detunedSample + presence) * amplitude;
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
    // Apply per-variant pitch shift (in cents) to the frequency
    let noteFreq = n.freq;
    const pitchCents = (n.opts || {})._pitchCents || 0;
    if (pitchCents !== 0) noteFreq *= Math.pow(2, pitchCents / 1200);
    const noteSamples = daintreeNote(noteFreq, noteDur, n.opts || {});
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
  const {
    reverbWet = 0.08,
    lpFreq = 4000,
    targetPeak = 0.7,
    chassisMix = 0.025,
    // Dynamic material absorption: the whole wood acts as a lowpass that
    // closes over time as kinetic energy dissipates.  Bright attack → warm tail.
    absorptionStartHz = 6000,
    absorptionEndHz = 800,
    absorptionRate = 5, // exponential sweep speed
  } = opts;

  const reverb = new Freeverb(reverbWet, 0.4);
  const lp = new OnePole(lpFreq);
  const dc = new DCBlocker(); // removes DC from asymmetric waveshaper
  const chassis = chassisMix > 0 ? new ModalResonator(JI.A4, 80, chassisMix) : null;

  // Dynamic absorption filter — one-pole LPF with time-varying cutoff
  let absorptionZ = 0;
  const duration = samples.length / SAMPLE_RATE;

  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    const t = i / SAMPLE_RATE;

    // Chassis resonance
    if (chassis) s += chassis.process(s);

    // Dynamic absorption: cutoff sweeps from bright to dark exponentially
    const cutoff =
      absorptionEndHz +
      (absorptionStartHz - absorptionEndHz) * expDecay(t, duration, absorptionRate);
    const fc = cutoff / SAMPLE_RATE;
    const absorptionA = Math.exp(-TWO_PI * fc);
    absorptionZ = s * (1 - absorptionA) + absorptionZ * absorptionA;

    // DC blocker after absorption, before reverb
    samples[i] = lp.process(reverb.process(dc.process(absorptionZ)));
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

  // Fade out last 20ms (quadratic curve for smooth taper)
  const fadeSamples = Math.min(Math.floor(SAMPLE_RATE * 0.02), samples.length);
  for (let i = 0; i < fadeSamples; i++) {
    const idx = samples.length - fadeSamples + i;
    const g = 1 - i / (fadeSamples - 1 || 1);
    samples[idx] *= g * g; // quadratic fade to zero
  }
  samples[samples.length - 1] = 0; // guarantee clean termination

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
    // TPDF dither: triangular probability density function noise at ±1 LSB.
    // Decorrelates quantization error so quiet tails decay more naturally.
    const dither = (rand() - rand()) / 32768;
    const scaled = (clamped < 0 ? clamped * 32768 : clamped * 32767) + dither;
    const pcm = Math.max(-32768, Math.min(32767, Math.round(scaled)));
    buf.writeInt16LE(pcm, 44 + i * 2);
  }

  writeFileSync(filePath, buf);
}

// ---------------------------------------------------------------------------
// Sound definitions — the Daintree palette
//
// Design principles:
//   1. Earthy core — modal wood resonators are the primary voice
//   2. Serial excitation — FM shimmer passes THROUGH the wood, not beside it
//   3. Dry UI — near-zero reverb; sounds feel like app chrome
//   4. Micro-feedback — short, sparse; 1-2 notes max
//   5. Material-per-meaning — wood resonance/hardness varies by semantic
//   6. Brand anchor — A4 → E5 (perfect fifth) woven through all sounds
//
// Perceptual loudness hierarchy (targetPeak is NOT perceived loudness,
// but shaping it per-role creates the right feel):
//   chime    0.70  — reference level, friendly default
//   complete 0.62  — softer, settled, "exhale"
//   waiting  0.75  — more forward, "look at me"
//   error    0.75  — cuts through briefly
//   ping     0.68  — sharp but not dominant
// ---------------------------------------------------------------------------

// chime, complete, waiting, ping — defined as generator functions for
// variant generation.  See "Sound generators" section below.

// pulse.wav — STATIC: ambient working-state awareness cue.
// Single quiet note, long attack, played every 8-10s during background work.
// A4 (root) conveys grounding/presence without implying completion or alert.
const pulse = postProcess(
  daintreeNote(JI.A4, 0.22, {
    amplitude: 0.28,
    resonance: 1.1,
    fmAmt: 0.2,
    fmIndex: 0.4,
    fmDecayRate: 20,
    malletAmt: 0.6,
    thumpAmt: 0.3,
    detuneMix: 0.1,
    excDuration: 0.004,
    attackPresenceAmt: 0,
  }),
  { reverbWet: 0.01, targetPeak: 0.4, chassisMix: 0.02 }
);

// error.wav — STATIC: no variants.  Critical sounds need Pavlovian consistency.
const error = postProcess(
  daintreeNote(JI.Cs5, 0.26, {
    amplitude: 0.55,
    resonance: 0.7,
    modeQs: [150, 80, 40, 20],
    fmRatio: 1.7321,
    fmAmt: 0.55,
    fmIndex: 2.2,
    fmDecayRate: 7,
    malletAmt: 0.55,
    noiseBandHz: 800,
    thumpAmt: 0.5,
    pitchBendHz: 35,
    pitchBendMs: 20,
    attackPresenceHz: 2200,
    attackPresenceAmt: 0.16,
    attackPresenceQ: 1.0,
    attackPresenceMs: 14,
  }),
  { reverbWet: 0.01, targetPeak: 0.75, chassisMix: 0.01 }
);

// ---------------------------------------------------------------------------
// Sound generators (functions that produce samples, callable per-variant)
// ---------------------------------------------------------------------------

function genWaiting(variantIdx = 0) {
  return postProcess(
    sequence(
      [
        {
          freq: JI.A4,
          duration: 0.08,
          opts: applyVariant(
            {
              amplitude: 0.4,
              resonance: 0.85,
              fmAmt: 0.4,
              fmIndex: 1.0,
              malletAmt: 0.5,
            },
            variantIdx
          ),
        },
        {
          freq: JI.B4,
          duration: 0.18,
          opts: applyVariant(
            {
              amplitude: 0.6,
              resonance: 0.95,
              fmAmt: 0.55,
              fmIndex: 1.6,
              fmDecayRate: 14,
              malletAmt: 0.65,
              thumpAmt: 0.45,
              noiseBandHz: 1400,
              attackPresenceHz: 3000,
              attackPresenceAmt: 0.18,
              attackPresenceQ: 2.0,
              attackPresenceMs: 12,
            },
            variantIdx
          ),
        },
      ],
      { noteGap: 0.045, tailPad: 0.1 }
    ),
    { reverbWet: 0.02, targetPeak: 0.75, chassisMix: 0.015 }
  );
}

function genChime(variantIdx = 0) {
  return postProcess(
    sequence(
      [
        {
          freq: JI.A4,
          duration: 0.1,
          opts: applyVariant(
            {
              resonance: 0.9,
              fmAmt: 0.5,
              fmIndex: 1.2,
              fmDecayRate: 14,
              malletAmt: 0.5,
              thumpAmt: 0.3,
              attackPresenceHz: 2600,
              attackPresenceAmt: 0.12,
              attackPresenceQ: 1.8,
            },
            variantIdx
          ),
        },
        {
          freq: JI.Ds5,
          duration: 0.16,
          opts: applyVariant(
            {
              amplitude: 0.6,
              resonance: 0.95,
              fmAmt: 0.4,
              fmIndex: 0.8,
              fmDecayRate: 18,
              malletAmt: 0.55,
              attackPresenceHz: 2800,
              attackPresenceAmt: 0.1,
              attackPresenceQ: 2.0,
            },
            variantIdx
          ),
        },
      ],
      { noteGap: 0.015, tailPad: 0.12 }
    ),
    { reverbWet: 0.02, targetPeak: 0.7, chassisMix: 0.02 }
  );
}

function genComplete(variantIdx = 0) {
  return postProcess(
    sequence(
      [
        {
          freq: JI.E5,
          duration: 0.1,
          opts: applyVariant(
            {
              amplitude: 0.5,
              resonance: 0.9,
              fmAmt: 0.45,
              fmIndex: 0.8,
              fmDecayRate: 18,
              malletAmt: 0.55,
              attackPresenceHz: 2000,
              attackPresenceAmt: 0.08,
              attackPresenceQ: 1.2,
            },
            variantIdx
          ),
        },
        {
          freq: JI.A4,
          duration: 0.22,
          opts: applyVariant(
            {
              amplitude: 0.6,
              resonance: 1.1,
              fmAmt: 0.3,
              fmIndex: 0.6,
              fmDecayRate: 20,
              malletAmt: 0.6,
              thumpAmt: 0.4,
              attackPresenceHz: 1800,
              attackPresenceAmt: 0.06,
              attackPresenceQ: 1.0,
            },
            variantIdx
          ),
        },
      ],
      { noteGap: 0.025, tailPad: 0.14 }
    ),
    { reverbWet: 0.02, targetPeak: 0.62, chassisMix: 0.035 }
  );
}

function genPing(variantIdx = 0) {
  const vopts = applyVariant(
    {
      amplitude: 0.5,
      resonance: 1.1,
      fmAmt: 0.25,
      fmIndex: 0.5,
      fmDecayRate: 22,
      malletAmt: 0.65,
      detuneMix: 0.08,
      excDuration: 0.004,
      attackPresenceHz: 2800,
      attackPresenceAmt: 0.14,
      attackPresenceQ: 2.5,
      attackPresenceMs: 6,
    },
    variantIdx
  );
  let freq = JI.E5;
  if (vopts._pitchCents) freq *= Math.pow(2, vopts._pitchCents / 1200);
  return postProcess(daintreeNote(freq, 0.22, vopts), {
    reverbWet: 0.02,
    targetPeak: 0.68,
    chassisMix: 0.02,
  });
}

function genAllClear(variantIdx = 0) {
  return postProcess(
    sequence(
      [
        {
          freq: JI.A4,
          duration: 0.09,
          opts: applyVariant(
            {
              amplitude: 0.45,
              resonance: 1.0,
              fmAmt: 0.4,
              fmIndex: 1.0,
              fmDecayRate: 16,
              malletAmt: 0.55,
              thumpAmt: 0.3,
              attackPresenceHz: 2200,
              attackPresenceAmt: 0.1,
              attackPresenceQ: 1.5,
            },
            variantIdx
          ),
        },
        {
          freq: JI.E5,
          duration: 0.1,
          opts: applyVariant(
            {
              amplitude: 0.5,
              resonance: 1.05,
              fmAmt: 0.35,
              fmIndex: 0.8,
              fmDecayRate: 18,
              malletAmt: 0.6,
              thumpAmt: 0.35,
              attackPresenceHz: 2400,
              attackPresenceAmt: 0.08,
              attackPresenceQ: 1.8,
            },
            variantIdx
          ),
        },
        {
          freq: JI.A5,
          duration: 0.24,
          opts: applyVariant(
            {
              amplitude: 0.6,
              resonance: 1.15,
              fmAmt: 0.25,
              fmIndex: 0.6,
              fmDecayRate: 22,
              malletAmt: 0.6,
              thumpAmt: 0.4,
              attackPresenceHz: 1800,
              attackPresenceAmt: 0.06,
              attackPresenceQ: 1.0,
            },
            variantIdx
          ),
        },
      ],
      { noteGap: 0.02, tailPad: 0.16 }
    ),
    { reverbWet: 0.03, targetPeak: 0.65, chassisMix: 0.03 }
  );
}

// ---------------------------------------------------------------------------
// UI feedback sound generators (event sounds, quieter than notifications)
// ---------------------------------------------------------------------------

function genGitCommit(variantIdx = 0) {
  const vopts = applyVariant(
    {
      amplitude: 0.45,
      resonance: 1.05,
      fmAmt: 0.2,
      fmIndex: 0.4,
      fmDecayRate: 20,
      malletAmt: 0.55,
      excDuration: 0.005,
      detuneMix: 0.06,
      attackPresenceHz: 2400,
      attackPresenceAmt: 0.08,
      attackPresenceQ: 1.5,
      attackPresenceMs: 8,
    },
    variantIdx
  );
  let freq = JI.E5;
  if (vopts._pitchCents) freq *= Math.pow(2, vopts._pitchCents / 1200);
  return postProcess(daintreeNote(freq, 0.18, vopts), {
    reverbWet: 0.01,
    targetPeak: 0.55,
    chassisMix: 0.015,
  });
}

function genGitPush(variantIdx = 0) {
  return postProcess(
    sequence(
      [
        {
          freq: JI.A4,
          duration: 0.08,
          opts: applyVariant(
            {
              amplitude: 0.4,
              resonance: 0.9,
              fmAmt: 0.35,
              fmIndex: 0.8,
              fmDecayRate: 16,
              malletAmt: 0.45,
              attackPresenceHz: 2200,
              attackPresenceAmt: 0.08,
              attackPresenceQ: 1.5,
            },
            variantIdx
          ),
        },
        {
          freq: JI.E5,
          duration: 0.2,
          opts: applyVariant(
            {
              amplitude: 0.5,
              resonance: 0.95,
              fmAmt: 0.3,
              fmIndex: 0.7,
              fmDecayRate: 18,
              malletAmt: 0.5,
              thumpAmt: 0.3,
              attackPresenceHz: 2600,
              attackPresenceAmt: 0.06,
              attackPresenceQ: 1.8,
            },
            variantIdx
          ),
        },
      ],
      { noteGap: 0.02, tailPad: 0.1 }
    ),
    { reverbWet: 0.01, targetPeak: 0.55, chassisMix: 0.015 }
  );
}

function genWorktreeCreate(variantIdx = 0) {
  return postProcess(
    sequence(
      [
        {
          freq: JI.B4,
          duration: 0.08,
          opts: applyVariant(
            {
              amplitude: 0.45,
              resonance: 0.9,
              fmAmt: 0.35,
              fmIndex: 0.9,
              fmDecayRate: 15,
              malletAmt: 0.5,
              attackPresenceHz: 2400,
              attackPresenceAmt: 0.1,
              attackPresenceQ: 1.6,
            },
            variantIdx
          ),
        },
        {
          freq: JI.Fs5,
          duration: 0.22,
          opts: applyVariant(
            {
              amplitude: 0.5,
              resonance: 0.9,
              fmAmt: 0.3,
              fmIndex: 0.7,
              fmDecayRate: 18,
              malletAmt: 0.55,
              thumpAmt: 0.3,
              attackPresenceHz: 2800,
              attackPresenceAmt: 0.08,
              attackPresenceQ: 2.0,
            },
            variantIdx
          ),
        },
      ],
      { noteGap: 0.02, tailPad: 0.12 }
    ),
    { reverbWet: 0.02, targetPeak: 0.58, chassisMix: 0.015 }
  );
}

function genAgentSpawned(variantIdx = 0) {
  const vopts = applyVariant(
    {
      amplitude: 0.4,
      resonance: 1.1,
      fmAmt: 0.15,
      fmIndex: 0.3,
      fmDecayRate: 24,
      malletAmt: 0.5,
      excDuration: 0.005,
      detuneMix: 0.06,
      thumpAmt: 0.25,
      attackPresenceHz: 2000,
      attackPresenceAmt: 0.06,
      attackPresenceQ: 1.2,
      attackPresenceMs: 6,
    },
    variantIdx
  );
  let freq = JI.A4;
  if (vopts._pitchCents) freq *= Math.pow(2, vopts._pitchCents / 1200);
  return postProcess(daintreeNote(freq, 0.15, vopts), {
    reverbWet: 0.01,
    targetPeak: 0.5,
    chassisMix: 0.01,
  });
}

function genContextInjected(variantIdx = 0) {
  const vopts = applyVariant(
    {
      amplitude: 0.4,
      resonance: 0.8,
      fmAmt: 0.1,
      fmIndex: 0.3,
      fmDecayRate: 25,
      malletAmt: 0.6,
      excDuration: 0.004,
      noiseBandHz: 900,
      detuneMix: 0.04,
      thumpAmt: 0.3,
      attackPresenceHz: 2800,
      attackPresenceAmt: 0.12,
      attackPresenceQ: 2.0,
      attackPresenceMs: 5,
    },
    variantIdx
  );
  let freq = JI.Cs5;
  if (vopts._pitchCents) freq *= Math.pow(2, vopts._pitchCents / 1200);
  return postProcess(daintreeNote(freq, 0.12, vopts), {
    reverbWet: 0.005,
    targetPeak: 0.52,
    chassisMix: 0.01,
  });
}

// ---------------------------------------------------------------------------
// Write files
//
// Variant sounds: chime, complete, ping get 4 variants each (.v1, .v2, .v3).
// Static sounds: waiting, error, git-push-error, worktree-delete are single
//   files (semantic consistency for critical/destructive sounds).
// The base file (e.g., chime.wav) is variant 0 — the canonical version.
// ---------------------------------------------------------------------------

// git-push-error.wav — STATIC: error semantics need consistency.
// Shorter, quieter sibling of error.wav — a soft "operation failed" cue.
const gitPushError = postProcess(
  daintreeNote(JI.Cs5, 0.18, {
    amplitude: 0.45,
    resonance: 0.65,
    modeQs: [120, 60, 30, 15],
    fmRatio: 1.7321, // √3 — metallic, matching error family
    fmAmt: 0.4,
    fmIndex: 1.8,
    fmDecayRate: 10,
    malletAmt: 0.45,
    noiseBandHz: 700,
    thumpAmt: 0.4,
    pitchBendHz: 25,
    pitchBendMs: 15,
    attackPresenceHz: 2000,
    attackPresenceAmt: 0.1,
    attackPresenceQ: 1.0,
    attackPresenceMs: 10,
  }),
  { reverbWet: 0.01, targetPeak: 0.45, chassisMix: 0.01 }
);

// worktree-delete.wav — STATIC: destructive action needs Pavlovian consistency.
// Descending Fs5→A4, muffled closing gesture.
const worktreeDelete = postProcess(
  sequence(
    [
      {
        freq: JI.Fs5,
        duration: 0.08,
        opts: {
          amplitude: 0.4,
          resonance: 0.75,
          fmAmt: 0.2,
          fmIndex: 0.6,
          fmDecayRate: 18,
          malletAmt: 0.45,
          noiseBandHz: 800,
        },
      },
      {
        freq: JI.A4,
        duration: 0.18,
        opts: {
          amplitude: 0.35,
          resonance: 0.75,
          fmAmt: 0.15,
          fmIndex: 0.4,
          fmDecayRate: 20,
          malletAmt: 0.5,
          thumpAmt: 0.3,
          noiseBandHz: 700,
        },
      },
    ],
    { noteGap: 0.02, tailPad: 0.1 }
  ),
  { reverbWet: 0.01, targetPeak: 0.45, chassisMix: 0.01 }
);

// Static sounds (no variants — error/destructive sounds need Pavlovian consistency)
const staticSounds = {
  error,
  pulse,
  "git-push-error": gitPushError,
  "worktree-delete": worktreeDelete,
};

for (const [name, samples] of Object.entries(staticSounds)) {
  const filePath = join(outDir, `${name}.wav`);
  writeWav(samples, filePath);
  const sizeKB = (Buffer.byteLength(Buffer.alloc(44 + samples.length * 2)) / 1024).toFixed(1);
  const durationMs = ((samples.length / SAMPLE_RATE) * 1000).toFixed(0);
  console.log(`  ${name}.wav  ${durationMs}ms  ${sizeKB}KB`);
}

// Variant sounds
const variantGenerators = {
  chime: genChime,
  complete: genComplete,
  waiting: genWaiting,
  ping: genPing,
  "all-clear": genAllClear,
  "git-commit": genGitCommit,
  "git-push": genGitPush,
  "worktree-create": genWorktreeCreate,
  "agent-spawned": genAgentSpawned,
  "context-injected": genContextInjected,
};

for (const [name, generator] of Object.entries(variantGenerators)) {
  for (let v = 0; v < VARIANT_COUNT; v++) {
    // Each variant gets a unique seed offset so the PRNG produces different
    // strike textures, noise patterns, and jitter values.
    seedReset(SEED + v * 0x1000 + name.charCodeAt(0));

    const samples = generator(v);
    const suffix = v === 0 ? "" : `.v${v}`;
    const filePath = join(outDir, `${name}${suffix}.wav`);
    writeWav(samples, filePath);
    const sizeKB = (Buffer.byteLength(Buffer.alloc(44 + samples.length * 2)) / 1024).toFixed(1);
    const durationMs = ((samples.length / SAMPLE_RATE) * 1000).toFixed(0);
    console.log(`  ${name}${suffix}.wav  ${durationMs}ms  ${sizeKB}KB`);
  }
}

console.log(`\nSounds written to ${outDir}`);
