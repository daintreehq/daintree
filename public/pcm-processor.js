/* eslint-disable */
// This file runs in the AudioWorklet global scope, not a browser/Node context.
// AudioWorkletProcessor, sampleRate, and registerProcessor are globals there.

/**
 * AudioWorklet processor that downsamples microphone input to 24kHz PCM16 mono
 * for use with the OpenAI Realtime API.
 *
 * Input: Float32 at the AudioContext sample rate (usually 44100 or 48000 Hz)
 * Output: Int16Array chunks at 24000 Hz via postMessage, ~100ms each (2400 samples)
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a global available inside AudioWorkletProcessor
    this.sourceSampleRate = sampleRate;
    this.targetSampleRate = 24000;
    this.resampleRatio = this.sourceSampleRate / this.targetSampleRate;

    // Buffer to accumulate resampled samples (100ms at 24kHz)
    this.chunkSize = 2400;
    this.buffer = new Int16Array(this.chunkSize);
    this.bufferIndex = 0;

    // Fractional position tracker for linear interpolation
    this.position = 0;
    this.lastSample = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mix to mono if multi-channel
    const channelData = input[0];
    if (!channelData) return true;

    // Resample from source rate to 24kHz using linear interpolation
    for (let i = 0; i < channelData.length; i++) {
      const currentSample = channelData[i];

      while (this.position <= i) {
        // Linear interpolation between last and current sample
        const t = this.position - Math.floor(this.position - 1) - 1;
        const interpolated = this.lastSample + t * (currentSample - this.lastSample);

        // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const int16 = Math.max(-32768, Math.min(32767, Math.round(interpolated * 32767)));
        this.buffer[this.bufferIndex++] = int16;

        if (this.bufferIndex >= this.chunkSize) {
          // Transfer the buffer to the main thread (zero-copy)
          const out = this.buffer.buffer.slice(0);
          this.port.postMessage(out, [out]);
          this.buffer = new Int16Array(this.chunkSize);
          this.bufferIndex = 0;
        }

        this.position += this.resampleRatio;
      }

      this.lastSample = currentSample;
    }

    // Adjust position relative to next block
    this.position -= channelData.length;

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
