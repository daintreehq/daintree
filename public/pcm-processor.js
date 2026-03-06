/* eslint-disable */
// This file runs in the AudioWorklet global scope, not a browser/Node context.
// AudioWorkletProcessor, sampleRate, and registerProcessor are globals there.

/**
 * AudioWorklet processor that downsamples microphone input to 24kHz PCM16 mono
 * for use with the OpenAI Realtime API.
 *
 * Uses a correct phase-accumulator with linear interpolation.
 * Input:  Float32 at the AudioContext sample rate (usually 44100 or 48000 Hz)
 * Output: Int16Array chunks at 24000 Hz via postMessage, ~100ms each (2400 samples)
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a global available inside AudioWorkletProcessor
    this.ratio = sampleRate / 24000; // e.g. 2.0 for 48kHz, ~1.8375 for 44.1kHz

    // Output accumulation buffer (100ms at 24kHz)
    this.chunkSize = 2400;
    this.outBuf = new Int16Array(this.chunkSize);
    this.outIdx = 0;

    // Phase accumulator: fractional index into the current input block
    this.phase = 0.0;
    // Last sample of the previous input block, needed for cross-block interpolation
    this.prevSample = 0.0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const src = input[0];
    if (!src || src.length === 0) return true;

    // Walk through output samples using the phase accumulator
    while (this.phase < src.length) {
      const intPart = Math.floor(this.phase);
      const frac = this.phase - intPart;

      // Sample at intPart (use prevSample when phase < 0 due to cross-block wrap)
      const s0 = intPart >= 0 ? src[intPart] : this.prevSample;
      // Next sample for interpolation (clamp at block end)
      const s1 = intPart + 1 < src.length ? src[intPart + 1] : src[src.length - 1];

      // Linear interpolation
      const sample = s0 + frac * (s1 - s0);

      // Float32 [-1,1] → Int16 [-32768, 32767]
      this.outBuf[this.outIdx++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));

      if (this.outIdx >= this.chunkSize) {
        const buf = this.outBuf.buffer.slice(0);
        this.port.postMessage(buf, [buf]);
        this.outBuf = new Int16Array(this.chunkSize);
        this.outIdx = 0;
      }

      this.phase += this.ratio;
    }

    // Carry phase and last sample forward to the next block
    this.prevSample = src[src.length - 1];
    this.phase -= src.length; // phase is now negative (relative start into next block)

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
