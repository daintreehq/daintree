import type { LocalSpeechModelStatus } from "@shared/types";

/**
 * This view's copy of the on-device speech model's status. Main pushes every
 * change to every view; a read answered after a newer push keeps the push.
 * Settings shows it, and dictation counts as configured with on-device
 * transcription only once it says `ready`.
 */

let latest: LocalSpeechModelStatus | null = null;
/** Moves on with every push: a reply sent before it is older. */
let pushes = 0;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<(status: LocalSpeechModelStatus) => void>();

function voice() {
  return window.electron?.voiceInput;
}

function publish(status: LocalSpeechModelStatus): void {
  latest = status;
  for (const listener of listeners) listener(status);
}

function ensureSubscribed(): void {
  if (unsubscribe) return;
  const api = voice();
  if (!api?.onLocalModelStatus) return;
  unsubscribe = api.onLocalModelStatus((status) => {
    pushes++;
    publish(status);
  });
}

async function call(
  request: () => Promise<LocalSpeechModelStatus> | undefined
): Promise<LocalSpeechModelStatus | null> {
  ensureSubscribed();
  const before = pushes;
  const status = await request();
  if (!status) return latest;
  if (pushes === before) publish(status);
  return latest;
}

/** The status as this view last heard it; null before the first read. */
export function getLocalModelStatus(): LocalSpeechModelStatus | null {
  return latest;
}

export function isLocalModelReady(): boolean {
  return latest?.state === "ready";
}

/** Reads the status from main, which checks the installed files once a launch. */
export function readLocalModelStatus(): Promise<LocalSpeechModelStatus | null> {
  return call(() => voice()?.getLocalModel());
}

export function downloadLocalModel(): Promise<LocalSpeechModelStatus | null> {
  return call(() => voice()?.downloadLocalModel());
}

export function cancelLocalModelDownload(): Promise<LocalSpeechModelStatus | null> {
  return call(() => voice()?.cancelLocalModel());
}

export function removeLocalModel(): Promise<LocalSpeechModelStatus | null> {
  return call(() => voice()?.removeLocalModel());
}

/** Hears every status this view receives from now on. */
export function subscribeLocalModelStatus(
  listener: (status: LocalSpeechModelStatus) => void
): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only: forget everything heard. */
export function resetLocalModelClientForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  latest = null;
  pushes = 0;
  listeners.clear();
}
