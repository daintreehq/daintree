/**
 * The on-device speech model's two halves, each made on first use only: the
 * files on disk and the process that runs them. Nothing here starts until a
 * user picks on-device transcription or opens its settings.
 */
import path from "node:path";
import { app } from "electron";
import type { LocalSpeechModelStatus } from "../../../shared/types/voice.js";
import { LocalSpeechHost } from "./localSpeechProcess.js";
import { LocalSpeechModelStore } from "./localSpeechModelStore.js";

const MODEL_FOLDER = "nemotron-3.5-asr-streaming-0.6b-int4";

let models: LocalSpeechModelStore | null = null;
let host: LocalSpeechHost | null = null;
const statusListeners = new Set<(status: LocalSpeechModelStatus) => void>();

export function getLocalSpeechModels(): LocalSpeechModelStore {
  models ??= new LocalSpeechModelStore(
    path.join(app.getPath("userData"), "voice", "models", MODEL_FOLDER),
    (status) => {
      for (const listener of statusListeners) listener(status);
    }
  );
  return models;
}

export function getLocalSpeechHost(): LocalSpeechHost {
  host ??= new LocalSpeechHost();
  return host;
}

/** Hears every change to the model's status, downloads' progress included. */
export function onLocalSpeechModelStatus(
  listener: (status: LocalSpeechModelStatus) => void
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Deletes the model's files, after stopping the process that has them open.
 * Refused while a dictation is using them.
 */
export async function removeLocalSpeechModel(): Promise<void> {
  await getLocalSpeechModels().remove(async () => {
    await host?.releaseModel();
  });
}

/**
 * On quit: stop a download and the speech process, waiting up to `timeoutMs`
 * for both. A download stopped part way resumes next launch.
 */
export async function shutdownLocalSpeech(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([
    Promise.all([models?.cancel(), host?.shutdown(timeoutMs)]).then(() => undefined),
    budget,
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
