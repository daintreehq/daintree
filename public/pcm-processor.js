/* eslint-disable */
// This file runs in the AudioWorklet global scope, not a browser/Node context.
// AudioWorkletProcessor, sampleRate, and registerProcessor are globals there.

/**
 * AudioWorklet processor that downsamples microphone input to 24kHz PCM16 mono
 * for use with the OpenAI Realtime API.
 *
 * Uses a correct phase-accumulator with linear interpolation.
 * Input:  Float32 at the AudioContext sample rate (usually 44100 or 48000 Hz)
 * Output: Int16Array chunks at 24000 Hz via postMessage, ~100ms each (2400 samples),
 *         plus a shorter final chunk when a stop flushes the processor
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

    // When paused, process() short-circuits before downsampling/postMessage so
    // no PCM chunks cross the IPC boundary. The worklet stays alive (returns
    // true) so resume restores forwarding without rebuilding the audio graph.
    this.isPaused = false;
    // Set once a stop has flushed this processor. Nothing may follow the
    // "flushed" marker, so process() stops emitting for good.
    this.isFlushed = false;
    // The AudioContext outlives each capture, so a processor that is done must
    // end itself: returning true would keep it alive in the reused context.
    this.isDisposed = false;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "setPaused") {
        this.isPaused = !!data.value;
      } else if (data.type === "flush") {
        this.flush();
      } else if (data.type === "dispose") {
        this.isDisposed = true;
      }
    };
  }

  // Posts the partial chunk still being filled, then a marker. Port messages
  // arrive in order, so the marker tells the main thread that every chunk this
  // processor produced has already been delivered.
  flush() {
    if (!this.isFlushed && this.outIdx > 0) {
      const buf = this.outBuf.slice(0, this.outIdx).buffer;
      this.port.postMessage(buf, [buf]);
      this.outIdx = 0;
    }
    this.isFlushed = true;
    this.port.postMessage({ type: "flushed" });
  }

  process(inputs) {
    if (this.isFlushed || this.isDisposed) return false;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const src = input[0];
    if (!src || src.length === 0) return true;

    if (this.isPaused) return true;

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
