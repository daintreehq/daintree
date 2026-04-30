/**
 * Renderer-side sound playback service using the Web Audio API.
 *
 * Receives sound trigger events from main process via IPC and plays
 * WAV files through a singleton AudioContext. Sounds are fetched via
 * the daintree-file:// protocol and decoded AudioBuffers are cached
 * for instant replay.
 */

let audioContext: AudioContext | null = null;
let soundsDir: string | null = null;
const bufferCache = new Map<string, AudioBuffer>();
let activeSource: AudioBufferSourceNode | null = null;

async function ensureContext(): Promise<AudioContext> {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
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

export async function playSound(soundFile: string, detune?: number): Promise<void> {
  try {
    const ctx = await ensureContext();
    const buffer = await getBuffer(ctx, soundFile);
    if (!buffer) return;

    // Stop any currently playing sound
    cancelSound();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (detune !== undefined) source.detune.value = detune;
    source.connect(ctx.destination);
    source.onended = () => {
      if (activeSource === source) activeSource = null;
    };
    activeSource = source;
    source.start(0);
  } catch {
    // Non-critical — fail silently
  }
}

export function cancelSound(): void {
  if (activeSource) {
    try {
      activeSource.stop();
    } catch {
      // Already stopped
    }
    activeSource = null;
  }
}

export function dispose(): void {
  cancelSound();
  bufferCache.clear();
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  soundsDir = null;
}
