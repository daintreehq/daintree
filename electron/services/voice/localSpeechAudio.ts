/**
 * Turns the renderer's 24 kHz PCM16 capture into the 16 kHz float samples the
 * on-device speech model reads, one chunk at a time, with no seam between
 * chunks: a windowed-sinc low-pass at the new Nyquist, evaluated at every
 * output position.
 */

const IN_RATE = 24_000;
const OUT_RATE = 16_000;
const STEP = IN_RATE / OUT_RATE;
/** Input samples either side of an output position. */
const HALF_TAPS = 16;
/** A little under the new Nyquist, so the window's roll-off stays below it. */
const CUTOFF = (0.45 * OUT_RATE) / IN_RATE;

function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}

function kernel(t: number): number {
  if (Math.abs(t) >= HALF_TAPS) return 0;
  const window = 0.5 * (1 + Math.cos((Math.PI * t) / HALF_TAPS));
  return 2 * CUTOFF * sinc(2 * CUTOFF * t) * window;
}

export function pcm16ToFloat(pcm: ArrayBuffer): Float32Array {
  const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return out;
}

export class Resampler24kTo16k {
  /** Input not yet past every window that reads it, from absolute index `base`. */
  private pending = new Float32Array(0);
  private base = 0;
  /** The absolute input position of the next output sample. */
  private next = 0;

  reset(): void {
    this.pending = new Float32Array(0);
    this.base = 0;
    this.next = 0;
  }

  /** Feeds `input` and returns every output sample whose window it completes. */
  push(input: Float32Array): Float32Array {
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending, 0);
    joined.set(input, this.pending.length);
    const end = this.base + joined.length;
    const out: number[] = [];
    while (this.next + HALF_TAPS < end) {
      out.push(this.sample(joined, this.next));
      this.next += STEP;
    }
    const keepFrom = Math.max(0, Math.floor(this.next) - HALF_TAPS - this.base);
    this.pending = joined.slice(keepFrom);
    this.base += keepFrom;
    return Float32Array.from(out);
  }

  /** Whatever input remains, read as if silence followed it. */
  flush(): Float32Array {
    return this.push(new Float32Array(HALF_TAPS + 1));
  }

  private sample(joined: Float32Array, position: number): number {
    const centre = Math.floor(position);
    let sum = 0;
    for (let k = centre - HALF_TAPS + 1; k <= centre + HALF_TAPS; k++) {
      const i = k - this.base;
      if (i < 0 || i >= joined.length) continue;
      sum += joined[i] * kernel(position - k);
    }
    return sum;
  }
}
