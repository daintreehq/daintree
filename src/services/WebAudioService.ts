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

let audioContext: AudioContext | null = null;
let soundsDir: string | null = null;
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

async function ensureSoundsDir(): Promise<string> {
  if (!soundsDir) {
    soundsDir = await window.electron.sound.getSoundDir();
  }
  return soundsDir;
}

async function getBuffer(ctx: AudioContext, soundFile: string): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(soundFile);
  if (cached) return cached;

  try {
    const dir = await ensureSoundsDir();
    const url = `daintree-file://?path=${encodeURIComponent(`${dir}/${soundFile}`)}&root=${encodeURIComponent(dir)}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    bufferCache.set(soundFile, audioBuffer);
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

export async function playSound(soundFile: string, detune?: number): Promise<void> {
  // Captured before any await — if cancelSound() fires during fetch/decode,
  // the generation advances and we abort before scheduling playback.
  const startGeneration = cancelGeneration;
  pendingPlays++;
  try {
    const ctx = await ensureContext();
    const buffer = await getBuffer(ctx, soundFile);
    if (!buffer) return;
    if (startGeneration !== cancelGeneration) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (detune !== undefined) source.detune.value = detune;

    const gainNode = ctx.createGain();
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
}
