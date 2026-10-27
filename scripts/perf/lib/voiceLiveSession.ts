import type { EventEmitter } from "node:events";
import nodeModule from "node:module";
import path from "node:path";
import { REPLAY_SAMPLE_RATE, type PreparedClip } from "../../../e2e/helpers/voiceReplayFixtures";
import type { OpenAITranscriptionTuning } from "../../../electron/services/voice/openaiTranscriptionTuning";
import type { TranscriptionProvider } from "../../../electron/services/voice/TranscriptionProvider";
import { VOICE_CLEANUP_AI_MODEL } from "../../../shared/config/voiceCorrection";
import type { VoiceInputSettings } from "../../../shared/types/ipc/api";
import { formatErrorMessage } from "../../../shared/utils/errorMessage";
import { REPO_ROOT } from "../registry";
import type { ObservedEvent, SessionObservation, VadObservation } from "./voicePreviewFinalScore";

/**
 * Dictation sessions played into the real `OpenAITranscriptionProvider` under
 * Node, against the live socket, for the live voice harnesses
 * (`voice-preview-final`, `voice-tuning`). Only Electron is swapped out.
 */

const VAD_CHILD = path.join(REPO_ROOT, "scripts", "perf", "voice-live-vad.ts");
// The renderer's worklet posts 100 ms of 24 kHz mono PCM16 at a time.
const CHUNK_SAMPLES = REPLAY_SAMPLE_RATE / 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// `electron` under Node is a path string. The provider needs only
// `utilityProcess.fork` from it, for its VAD; this hands it a Node child
// running the real worker, and reports what each child says on `vadEvents`,
// tagged with its id so a session counts only its own.
function electronStubSource(): string {
  return `
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
export const vadEvents = new EventEmitter();
let nextId = 0;
class NodeUtilityProcess extends EventEmitter {
  pid = undefined;
  #id = ++nextId;
  #destroyRequested = false;
  #exited = false;
  constructor(options) {
    super();
    this.child = fork(${JSON.stringify(VAD_CHILD)}, [], {
      execArgv: ["--import", "tsx"],
      env: options && options.env,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    vadEvents.emit("fork", this.#id);
    this.child.once("spawn", () => {
      this.pid = this.child.pid;
      this.emit("spawn");
    });
    this.child.on("message", (message) => {
      vadEvents.emit("message", this.#id, message);
      this.emit("message", message);
    });
    this.child.on("error", (error) => {
      this.emit("error", "spawn", String((error && error.message) || error));
      if (this.pid === undefined) this.#exit(1);
    });
    this.child.once("exit", (code, signal) => this.#exit(code ?? (signal ? 1 : 0)));
  }
  #exit(code) {
    if (this.#exited) return;
    this.#exited = true;
    vadEvents.emit("exit", this.#id, { code, expected: this.#destroyRequested });
    this.emit("exit", code);
  }
  postMessage(message) {
    if (message && message.type === "destroy") this.#destroyRequested = true;
    // A channel that closed mid-send ends in the exit, which settles it.
    if (this.child.connected) this.child.send(message, () => {});
  }
  kill() {
    return this.child.kill();
  }
}
export const utilityProcess = {
  fork: (_modulePath, _args, options) => new NodeUtilityProcess(options),
};
`;
}

function installElectronStub(): void {
  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (specifier: string, context: unknown) => { url: string }
        ) => { url: string; shortCircuit?: boolean };
      }) => void;
    }
  ).registerHooks;
  if (typeof registerHooks !== "function") {
    throw new Error(`needs module.registerHooks (Node 22.15+), this is ${process.version}`);
  }
  const url = `data:text/javascript,${encodeURIComponent(electronStubSource())}`;
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "electron" ? { url, shortCircuit: true } : next(specifier, context),
  });
}

export function liveVoiceSettings(apiKey: string, keyterms: string[]): VoiceInputSettings {
  return {
    enabled: true,
    openaiApiKey: apiKey,
    deepgramApiKey: "",
    xaiApiKey: "",
    language: "en",
    dictionary: [],
    transcriptionProvider: "openai",
    transcriptionModel: "gpt-live-transcribe",
    correctionEnabled: false,
    correctionModel: VOICE_CLEANUP_AI_MODEL,
    correctionCustomInstructions: "",
    paragraphingStrategy: "manual",
    resolveFileLinks: false,
    deviceId: "",
    deviceLabel: "",
    organizationId: process.env.OPENAI_ORG_ID ?? "",
    projectId: process.env.OPENAI_PROJECT_ID ?? "",
    recordingMode: "toggle",
    keyterms,
    suggestedDictionary: [],
    dismissedSuggestions: [],
    learnFromCorrections: false,
  };
}

export interface LiveProviderHost {
  Provider: new (tuning?: Partial<OpenAITranscriptionTuning>) => TranscriptionProvider;
  waitForRetiringVadProcesses: (timeoutMs: number) => Promise<number>;
  retireWaitMs: number;
  vadEvents: EventEmitter;
}

/**
 * One dictation: the clip as the microphone from the moment `start()` is
 * called (the mic opens while the socket connects), 100 ms at a time on the
 * capture clock, then the stop as the clip runs out, as the replay benchmark
 * presses it.
 */
export async function dictate(
  host: LiveProviderHost,
  prepared: PreparedClip,
  samples: Int16Array,
  session: {
    pass: number;
    /** The provider's session id, for its logs. */
    name: string;
    settings: VoiceInputSettings;
    tuning?: Partial<OpenAITranscriptionTuning>;
  }
): Promise<SessionObservation> {
  const { pass, settings } = session;
  const vad: VadObservation = {
    forks: 0,
    ready: 0,
    speechStarts: 0,
    speechEnds: 0,
    pauses: 0,
    errors: 0,
    unexpectedExits: 0,
  };
  const mine = new Set<number>();
  const onFork = (id: number) => {
    mine.add(id);
    vad.forks++;
  };
  const onMessage = (id: number, message: { type?: string }) => {
    if (!mine.has(id)) return;
    if (message.type === "ready") vad.ready++;
    else if (message.type === "speech-start") vad.speechStarts++;
    else if (message.type === "speech-end") vad.speechEnds++;
    else if (message.type === "pause") vad.pauses = (vad.pauses ?? 0) + 1;
    else if (message.type === "error") vad.errors++;
  };
  const onExit = (id: number, exit: { expected: boolean }) => {
    if (mine.has(id) && !exit.expected) vad.unexpectedExits++;
  };
  host.vadEvents.on("fork", onFork);
  host.vadEvents.on("message", onMessage);
  host.vadEvents.on("exit", onExit);

  const provider = new host.Provider(session.tuning);
  const events: ObservedEvent[] = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  let readyMs: number | null = null;
  provider.onEvent((event) => {
    if (event.type === "delta") {
      events.push({ at: at(), type: "delta", itemId: event.itemId ?? null, text: event.text });
    } else if (event.type === "complete") {
      events.push({
        at: at(),
        type: "complete",
        itemId: event.itemId ?? null,
        text: event.text,
        endOfSpeech: event.endOfSpeech === true,
        endsAtPause: event.endsAtPause === true,
        incomplete: event.incomplete === true,
      });
    } else if (event.type === "error") {
      events.push({ at: at(), type: "error", code: event.error.code });
    } else if (event.type === "status") {
      events.push({ at: at(), type: "status", status: event.status });
      if (event.status === "recording") readyMs ??= at();
    }
  });

  try {
    const started = provider.start(settings, session.name).catch((error: unknown) => ({
      ok: false as const,
      error: formatErrorMessage(error, "start threw"),
    }));
    let maxChunkLateMs = 0;
    for (let offset = 0; offset < samples.length; offset += CHUNK_SAMPLES) {
      const end = Math.min(offset + CHUNK_SAMPLES, samples.length);
      const due = t0 + (end / REPLAY_SAMPLE_RATE) * 1000;
      await sleep(due - performance.now());
      maxChunkLateMs = Math.max(maxChunkLateMs, performance.now() - due);
      provider.sendAudioChunk(samples.slice(offset, end).buffer);
    }
    const stopAt = performance.now();
    const drained = provider.stopGracefully();
    const startResult = await started;
    await drained;
    const drainMs = performance.now() - stopAt;
    const stats = provider.getSessionStats();
    return {
      clip: prepared.clip.id,
      pass,
      startResult: startResult.ok ? { ok: true } : { ok: false, error: startResult.error },
      events,
      vad,
      reconnects: stats.reconnects,
      droppedConnect: stats.droppedConnect,
      droppedReplay: stats.droppedReplay,
      audioMs: prepared.audioMs,
      readyMs,
      maxChunkLateMs: Math.round(maxChunkLateMs),
      stopMs: Math.round(stopAt - t0),
      drainMs: Math.round(drainMs),
    };
  } finally {
    provider.destroy();
    // Recorded on the observation already returned, which shares `vad`: the
    // session is kept and excluded, and the run stops after saving it.
    vad.leftRunning = await host.waitForRetiringVadProcesses(host.retireWaitMs);
    host.vadEvents.off("fork", onFork);
    host.vadEvents.off("message", onMessage);
    host.vadEvents.off("exit", onExit);
  }
}

/**
 * Puts the Electron stub in place and loads the provider and its VAD process
 * module behind it. Call once, after every check that could end the run.
 */
export async function loadLiveProviderHost(): Promise<LiveProviderHost> {
  installElectronStub();
  // The logger decides at load whether to write files into the working
  // directory. Provider logs carry ids and lengths, never text; warnings stay.
  process.env.DAINTREE_DISABLE_FILE_LOGGING = "1";
  const { setLogLevelOverrides } = await import("../../../electron/utils/logger");
  setLogLevelOverrides({ "*": "warn" });
  // A computed specifier keeps the provider's import graph out of the perf
  // TypeScript program, which can't see the remote-service keys it reads;
  // `TranscriptionProvider` types every call made on it.
  const providerModule = "../../../electron/services/voice/OpenAITranscriptionProvider";
  const { OpenAITranscriptionProvider } = (await import(providerModule)) as {
    OpenAITranscriptionProvider: LiveProviderHost["Provider"];
  };
  const { VAD_RETIRE_KILL_MS, waitForRetiringVadProcesses } =
    await import("../../../electron/services/voice/openaiVadProcess");
  const { vadEvents } = (await import("electron")) as unknown as { vadEvents: EventEmitter };
  return {
    Provider: OpenAITranscriptionProvider,
    waitForRetiringVadProcesses,
    retireWaitMs: VAD_RETIRE_KILL_MS + 2_000,
    vadEvents,
  };
}
