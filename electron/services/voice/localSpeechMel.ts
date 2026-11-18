/**
 * The streaming log-mel front-end of the on-device speech model, chunk by
 * chunk, as onnxruntime-genai's NeMo streaming extractor computes it for this
 * export: pre-emphasis carrying the last raw sample across chunks, the
 * stream's last 256 pre-emphasised samples as left context, a symmetric Hann
 * window zero-padded to the FFT, the power spectrum, a Slaney mel filterbank
 * and `ln(x + 2^-24)`, with no normalisation and no dither. Each chunk is
 * followed by zeros rather than the next chunk's samples, as the reference
 * does, so its last frame matches what the model was exported against.
 */

export interface LocalSpeechMelConfig {
  sampleRate: number;
  numMels: number;
  fftSize: number;
  hopLength: number;
  winLength: number;
  preemph: number;
  logEps: number;
}

export const NEMOTRON_MEL_CONFIG: LocalSpeechMelConfig = {
  sampleRate: 16_000,
  numMels: 128,
  fftSize: 512,
  hopLength: 160,
  winLength: 400,
  preemph: 0.97,
  logEps: 2 ** -24,
};

const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = 15;
const LIN_SCALE = 200 / 3;
const LOG_STEP = Math.log(6.4) / 27;

function hzToMel(hz: number): number {
  return hz < MIN_LOG_HZ ? hz / LIN_SCALE : MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
}

function melToHz(mel: number): number {
  return mel < MIN_LOG_MEL ? mel * LIN_SCALE : MIN_LOG_HZ * Math.exp((mel - MIN_LOG_MEL) * LOG_STEP);
}

/**
 * Slaney-scale, area-normalised triangular filters from 0 Hz to Nyquist (librosa
 * `htk=False, norm='slaney'`), row-major `[numMels, fftSize / 2 + 1]`.
 */
export function createMelFilterbank(numMels: number, fftSize: number, sampleRate: number): Float32Array {
  const bins = fftSize / 2 + 1;
  const low = hzToMel(0);
  const high = hzToMel(sampleRate / 2);
  const melHz = new Float64Array(numMels + 2);
  for (let i = 0; i < numMels + 2; i++) {
    melHz[i] = melToHz(low + ((high - low) * i) / (numMels + 1));
  }
  const fb = new Float32Array(numMels * bins);
  for (let m = 0; m < numMels; m++) {
    const lowerWidth = melHz[m + 1] - melHz[m];
    const upperWidth = melHz[m + 2] - melHz[m + 1];
    const enorm = 2 / (melHz[m + 2] - melHz[m]);
    for (let k = 0; k < bins; k++) {
      const freq = (k * sampleRate) / fftSize;
      const lower = (freq - melHz[m]) / lowerWidth;
      const upper = (melHz[m + 2] - freq) / upperWidth;
      fb[m * bins + k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return fb;
}

/** In-place radix-2 FFT tables for one power-of-two size. */
class Fft {
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(readonly size: number) {
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reversed[i] = r;
    }
  }

  /** The power spectrum of `this.re` (imaginary part zero) into `power`, bins 0..size/2. */
  power(power: Float32Array): void {
    const { re, im, size } = this;
    im.fill(0);
    for (let i = 0; i < size; i++) {
      const j = this.reversed[i];
      if (j > i) {
        const t = re[i];
        re[i] = re[j];
        re[j] = t;
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= size / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  }
}

export class LocalSpeechMel {
  private readonly window: Float64Array;
  private readonly filterbank: Float32Array;
  private readonly bins: number;
  /** Samples of left context: half the FFT. */
  private readonly pad: number;
  /** Where a window starts inside its FFT frame, and the zeros after a chunk. */
  private readonly winOffset: number;
  private readonly fft: Fft;
  private readonly spectrum: Float32Array;
  private readonly overlap: Float64Array;
  private previous = 0;

  constructor(private readonly config: LocalSpeechMelConfig = NEMOTRON_MEL_CONFIG) {
    const { fftSize, winLength, numMels, sampleRate } = config;
    this.bins = fftSize / 2 + 1;
    this.pad = fftSize / 2;
    this.winOffset = (fftSize - winLength) / 2;
    this.window = new Float64Array(winLength);
    for (let i = 0; i < winLength; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winLength - 1)));
    }
    this.filterbank = createMelFilterbank(numMels, fftSize, sampleRate);
    this.fft = new Fft(fftSize);
    this.spectrum = new Float32Array(this.bins);
    this.overlap = new Float64Array(this.pad);
  }

  get numMels(): number {
    return this.config.numMels;
  }

  /** Mel frames a chunk of `samples` samples yields. */
  framesFor(samples: number): number {
    const span = this.pad + samples - this.config.winLength;
    return span < 0 ? 0 : Math.floor(span / this.config.hopLength) + 1;
  }

  reset(): void {
    this.overlap.fill(0);
    this.previous = 0;
  }

  /**
   * The mel frames of the stream's next chunk, time-major (`frames × numMels`),
   * written into `out` from `offset`. Returns the number of frames written.
   */
  process(chunk: Float32Array, out: Float32Array, offset = 0): number {
    const n = chunk.length;
    const frames = this.framesFor(n);
    if (frames <= 0) throw new Error("A chunk is shorter than one analysis window");
    const { pad, winOffset } = this;
    const { preemph, hopLength, winLength, fftSize, numMels, logEps } = this.config;
    const padded = new Float64Array(pad + n + winOffset);
    padded.set(this.overlap, 0);
    padded[pad] = chunk[0] - preemph * this.previous;
    for (let i = 1; i < n; i++) padded[pad + i] = chunk[i] - preemph * chunk[i - 1];
    this.overlap.set(padded.subarray(n, n + pad));
    this.previous = chunk[n - 1];

    const re = this.fft.re;
    for (let t = 0; t < frames; t++) {
      const start = t * hopLength + winOffset;
      for (let i = 0; i < winLength; i++) re[i] = padded[start + i] * this.window[i];
      re.fill(0, winLength, fftSize);
      this.fft.power(this.spectrum);
      const row = offset + t * numMels;
      for (let m = 0; m < numMels; m++) {
        let sum = 0;
        const base = m * this.bins;
        for (let k = 0; k < this.bins; k++) {
          const w = this.filterbank[base + k];
          if (w !== 0) sum += w * this.spectrum[k];
        }
        out[row + m] = Math.log(sum + logEps);
      }
    }
    return frames;
  }
}
