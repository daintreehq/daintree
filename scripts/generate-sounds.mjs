#!/usr/bin/env node
/**
 * Generate notification sound WAV files for Canopy.
 * Run with: node scripts/generate-sounds.mjs
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "../electron/resources/sounds");
mkdirSync(outDir, { recursive: true });

const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const BITS = 16;

function writeWavHeader(buf, numSamples) {
  const dataBytes = numSamples * (BITS / 8) * CHANNELS;
  let offset = 0;

  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(36 + dataBytes, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;
  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4; // chunk size
  buf.writeUInt16LE(1, offset);
  offset += 2; // PCM format
  buf.writeUInt16LE(CHANNELS, offset);
  offset += 2; // channels
  buf.writeUInt32LE(SAMPLE_RATE, offset);
  offset += 4; // sample rate
  buf.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS / 8), offset);
  offset += 4; // byte rate
  buf.writeUInt16LE(CHANNELS * (BITS / 8), offset);
  offset += 2; // block align
  buf.writeUInt16LE(BITS, offset);
  offset += 2; // bits per sample
  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(dataBytes, offset);
}

function generateTone(frequency, durationSec, amplitude = 0.6) {
  const numSamples = Math.ceil(SAMPLE_RATE * durationSec);
  const buf = Buffer.alloc(44 + numSamples * 2);
  writeWavHeader(buf, numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Envelope: short attack, hold, exponential decay
    const attackLen = 0.005 * SAMPLE_RATE;
    const attack = i < attackLen ? i / attackLen : 1.0;
    const decay = Math.exp((-4 * t) / durationSec);
    const envelope = attack * decay;
    const sample = Math.sin(2 * Math.PI * frequency * t) * amplitude * envelope;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buf;
}

function generateChord(frequencies, durationSec, amplitude = 0.5) {
  const numSamples = Math.ceil(SAMPLE_RATE * durationSec);
  const buf = Buffer.alloc(44 + numSamples * 2);
  writeWavHeader(buf, numSamples);
  const perTone = amplitude / frequencies.length;

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const attackLen = 0.008 * SAMPLE_RATE;
    const attack = i < attackLen ? i / attackLen : 1.0;
    const decay = Math.exp((-3.5 * t) / durationSec);
    const envelope = attack * decay;

    let sample = 0;
    for (const f of frequencies) {
      sample += Math.sin(2 * Math.PI * f * t) * perTone;
    }
    sample *= envelope;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buf;
}

function generateTwoTone(freq1, freq2, durationSec, amplitude = 0.55) {
  // Two sequential tones: first for half duration, second for second half
  const numSamples = Math.ceil(SAMPLE_RATE * durationSec);
  const buf = Buffer.alloc(44 + numSamples * 2);
  writeWavHeader(buf, numSamples);
  const half = numSamples / 2;

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const freq = i < half ? freq1 : freq2;
    const localT = i < half ? t : t - half / SAMPLE_RATE;
    const halfDur = durationSec / 2;

    const attackLen = 0.005 * SAMPLE_RATE;
    const localI = i < half ? i : i - half;
    const attack = localI < attackLen ? localI / attackLen : 1.0;
    const decay = Math.exp((-5 * localT) / halfDur);
    const envelope = attack * decay;

    const sample = Math.sin(2 * Math.PI * freq * t) * amplitude * envelope;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buf;
}

// chime.wav — soft major chord (C5+E5+G5), 0.6s — default completion sound
writeFileSync(join(outDir, "chime.wav"), generateChord([523.25, 659.25, 783.99], 0.6));
console.log("✓ chime.wav");

// ping.wav — short high tone (A5), 0.3s — brief alert
writeFileSync(join(outDir, "ping.wav"), generateTone(880, 0.3, 0.5));
console.log("✓ ping.wav");

// complete.wav — descending two-tone (C5→G4), 0.6s — completion indicator
writeFileSync(join(outDir, "complete.wav"), generateTwoTone(523.25, 392.0, 0.6));
console.log("✓ complete.wav");

// waiting.wav — ascending two-tone (G4→C5), 0.5s — waiting/permission
writeFileSync(join(outDir, "waiting.wav"), generateTwoTone(392.0, 523.25, 0.5));
console.log("✓ waiting.wav");

// error.wav — low tone (E3), 0.4s — failure alert
writeFileSync(join(outDir, "error.wav"), generateTone(164.81, 0.4, 0.5));
console.log("✓ error.wav");

console.log(`\nSounds written to ${outDir}`);
