// Lazy accessor for SoundService — keeps the module out of the eager-import
// graph. Handlers that play sounds (git-write, worktree lifecycle,
// notifications) reach the service through this wrapper, and the dynamic
// import resolves on first use.

import type * as SoundServiceModule from "./SoundService.js";

let cached: typeof SoundServiceModule | null = null;

async function loadModule(): Promise<typeof SoundServiceModule> {
  if (!cached) {
    cached = await import("./SoundService.js");
  }
  return cached;
}

export async function getSoundService(): Promise<typeof SoundServiceModule.soundService> {
  return (await loadModule()).soundService;
}

export async function getAllowedSoundFiles(): Promise<typeof SoundServiceModule.ALLOWED_SOUND_FILES> {
  return (await loadModule()).ALLOWED_SOUND_FILES;
}

export async function getSoundFiles(): Promise<typeof SoundServiceModule.SOUND_FILES> {
  return (await loadModule()).SOUND_FILES;
}

export async function getSoundsDirectory(): Promise<string> {
  return (await loadModule()).getSoundsDir();
}
