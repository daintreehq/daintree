/**
 * Renderer-side sound playback service using the Web Audio API.
 *
 * Receives sound trigger events from main process via IPC and plays
 * WAV files through a singleton AudioContext. Sounds are fetched via
 * the daintree-file:// protocol and decoded AudioBuffers are cached
 * for instant replay.
 *
 * Polyphony note: the main-process SoundService owns dampening, debounce,
 * decay, and priority. The renderer just plays what arrives — overlapping
 * playback is allowed (capped at MAX_VOICES as a safety backstop). Early
 * stops fade through a per-voice GainNode to avoid DC-offset clicks.
 */

import { customSoundFileName } from "@shared/types/ipc/notificationSounds";

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
}

const MAX_VOICES = 4;
const FADE_TIME_CONSTANT = 0.015;
const FADE_TAIL_SECONDS = 0.1;
// A running AudioContext keeps Chromium's audio render path ticking (and the
// audio service's output stream open) through silence, for the rest of the
// session. Suspend once playback has been quiet this long; the next play
// resumes before it schedules, so nothing is dropped.
export const IDLE_SUSPEND_MS = 30_000;
// Imports are ids into a user library that can grow, so only the most recently
// played few stay decoded; the bundled set is small and fixed.
const MAX_CACHED_CUSTOM_BUFFERS = 8;

let audioContext: AudioContext | null = null;
let soundsDir: string | null = null;
let customSoundsDir: string | null = null;
// Advanced by dispose(), so a lookup or decode that settles afterwards can't
// repopulate the caches it just cleared.
let lifetime = 0;
const bufferCache = new Map<string, AudioBuffer>();
const activeVoices: ActiveVoice[] = [];
let cancelGeneration = 0;
let pendingPlays = 0;
let idleSuspendTimer: ReturnType<typeof setTimeout> | null = null;
// Set when we issue suspend(), before its promise settles: `state` still reads
// "running" while the suspend is in flight, so it cannot be what decides
// whether the next play has to resume.
let suspendedForIdle = false;

function clearIdleSuspend(): void {
  if (idleSuspendTimer !== null) {
    clearTimeout(idleSuspendTimer);
    idleSuspendTimer = null;
  }
}

function scheduleIdleSuspend(): void {
  clearIdleSuspend();
  if (!audioContext || suspendedForIdle || activeVoices.length > 0 || pendingPlays > 0) return;
  idleSuspendTimer = setTimeout(() => {
    idleSuspendTimer = null;
    const ctx = audioContext;
    if (!ctx || activeVoices.length > 0 || pendingPlays > 0) return;
    suspendedForIdle = true;
    ctx.suspend().catch(() => {});
  }, IDLE_SUSPEND_MS);
}

async function ensureContext(): Promise<AudioContext> {
  clearIdleSuspend();
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (suspendedForIdle || audioContext.state === "suspended") {
    suspendedForIdle = false;
    // Control messages are processed in order, so this also wins over a
    // suspend() that has not settled yet.
    await audioContext.resume();
  }
  return audioContext;
}

async function ensureSoundsDir(started: number): Promise<string> {
  if (soundsDir) return soundsDir;
  const dir = await window.electron.sound.getSoundDir();
  if (started === lifetime) soundsDir = dir;
  return dir;
}

/** Where a sound's file lives: the bundled directory, or this device's imports for a custom id. */
/** `started` is the lifetime the play began in; a lookup from an older one isn't kept. */
async function locate(soundFile: string, started: number): Promise<{ dir: string; file: string }> {
  const customFile = customSoundFileName(soundFile);
  if (customFile) {
    if (customSoundsDir !== null) return { dir: customSoundsDir, file: customFile };
    const dir = await window.electron.notificationSounds.getCustomDir();
    if (started === lifetime) customSoundsDir = dir;
    return { dir, file: customFile };
  }
  return { dir: await ensureSoundsDir(started), file: soundFile };
}

function cacheBuffer(soundFile: string, buffer: AudioBuffer): void {
  bufferCache.set(soundFile, buffer);
  if (!customSoundFileName(soundFile)) return;
  const custom = [...bufferCache.keys()].filter((key) => customSoundFileName(key) !== null);
  for (const key of custom.slice(0, Math.max(0, custom.length - MAX_CACHED_CUSTOM_BUFFERS))) {
    bufferCache.delete(key);
  }
}

async function getBuffer(
  ctx: AudioContext,
  soundFile: string,
  started: number
): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(soundFile);
  if (cached) {
    // Re-inserted so the custom-buffer cap evicts the least recently played.
    bufferCache.delete(soundFile);
    bufferCache.set(soundFile, cached);
    return cached;
  }

  try {
    const { dir, file } = await locate(soundFile, started);
    const url = `daintree-file://?path=${encodeURIComponent(`${dir}/${file}`)}&root=${encodeURIComponent(dir)}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (started === lifetime) cacheBuffer(soundFile, audioBuffer);
    return audioBuffer;
  } catch {
    return null;
  }
}

function fadeOutVoice(ctx: AudioContext, voice: ActiveVoice): void {
  try {
    voice.gainNode.gain.setTargetAtTime(0, ctx.currentTime, FADE_TIME_CONSTANT);
    voice.source.stop(ctx.currentTime + FADE_TAIL_SECONDS);
  } catch {
    // Already stopped or context closed
  }
}

export interface PlaySoundOptions {
  detune?: number;
  /** Linear gain from Main (the volume setting times any repeat decay), 0-1. */
  volume?: number;
}

function gainFor(volume: number | undefined): number {
  if (volume === undefined || !Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

export async function playSound(
  soundFile: string,
  { detune, volume }: PlaySoundOptions = {}
): Promise<void> {
  // Captured before any await — if cancelSound() fires during fetch/decode,
  // the generation advances and we abort before scheduling playback.
  const startGeneration = cancelGeneration;
  const startLifetime = lifetime;
  pendingPlays++;
  try {
    const ctx = await ensureContext();
    const buffer = await getBuffer(ctx, soundFile, startLifetime);
    if (!buffer) return;
    if (startGeneration !== cancelGeneration) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (detune !== undefined) source.detune.value = detune;

    const gainNode = ctx.createGain();
    gainNode.gain.value = gainFor(volume);
    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    const voice: ActiveVoice = { source, gainNode };
    source.onended = () => {
      const idx = activeVoices.indexOf(voice);
      if (idx !== -1) activeVoices.splice(idx, 1);
      scheduleIdleSuspend();
    };

    activeVoices.push(voice);
    while (activeVoices.length > MAX_VOICES) {
      const oldest = activeVoices.shift();
      if (oldest) fadeOutVoice(ctx, oldest);
    }

    try {
      source.start(0);
    } catch {
      const idx = activeVoices.indexOf(voice);
      if (idx !== -1) activeVoices.splice(idx, 1);
    }
  } catch {
    // Non-critical — fail silently
  } finally {
    pendingPlays--;
    scheduleIdleSuspend();
  }
}

export function cancelSound(): void {
  cancelGeneration++;
  if (activeVoices.length === 0) return;
  const ctx = audioContext;
  const voices = activeVoices.splice(0);
  if (!ctx) return;
  for (const voice of voices) {
    fadeOutVoice(ctx, voice);
  }
}

export function dispose(): void {
  cancelSound();
  clearIdleSuspend();
  suspendedForIdle = false;
  bufferCache.clear();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  soundsDir = null;
  customSoundsDir = null;
  lifetime++;
}
