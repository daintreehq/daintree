// Lazy accessor for SoundService — keeps the module out of the eager-import
// graph. Handlers that play sounds (git-write, worktree lifecycle,
// notifications) reach the service through this wrapper, and the dynamic
// import resolves on first use.

import type * as SoundServiceModule from "./SoundService.js";

let pending: Promise<typeof SoundServiceModule> | null = null;

function loadModule(): Promise<typeof SoundServiceModule> {
  return (pending ??= import("./SoundService.js"));
}

export async function getSoundService(): Promise<typeof SoundServiceModule.soundService> {
  return (await loadModule()).soundService;
}

/** The bundled sounds plus this device's playable imports; checked live on every call. */
export async function getAllowedSoundFiles(): Promise<
  typeof SoundServiceModule.PLAYABLE_SOUND_FILES
> {
  return (await loadModule()).PLAYABLE_SOUND_FILES;
}

export async function getSoundFiles(): Promise<typeof SoundServiceModule.SOUND_FILES> {
  return (await loadModule()).SOUND_FILES;
}

export async function getSoundsDirectory(): Promise<string> {
  return (await loadModule()).getSoundsDir();
}
