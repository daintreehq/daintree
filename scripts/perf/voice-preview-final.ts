import { execFileSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import nodeModule from "node:module";
import path from "node:path";
import {
  allFixtureTerms,
  prepareClip,
  readPcm16Wav,
  REPLAY_CLIPS,
  REPLAY_SAMPLE_RATE,
  type PreparedClip,
} from "../../e2e/helpers/voiceReplayFixtures";
import { contentHash } from "../../e2e/helpers/voiceReplayScore";
import type { TranscriptionProvider } from "../../electron/services/voice/TranscriptionProvider";
import { VOICE_CLEANUP_AI_MODEL } from "../../shared/config/voiceCorrection";
import type { VoiceInputSettings } from "../../shared/types/ipc/api";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { seededShuffle } from "./lib/voiceCleanupScore";
import {
  LIVE_TRANSCRIBE_USD_PER_MINUTE,
  renderHeadline,
  renderReport,
  scoreRun,
  VOICE_PREVIEW_FINAL_SCHEMA_VERSION,
  VOICE_PREVIEW_FINAL_SCORING_VERSION,
  type ObservedEvent,
  type RunSummary,
  type SessionObservation,
  type VadObservation,
} from "./lib/voicePreviewFinalScore";
import { REPO_ROOT } from "./registry";

const RESULTS_DIR = path.join(REPO_ROOT, ".tmp", "perf-results", "voice-preview-final");
const CLIP_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "voice-replay", "clips");
const VAD_CHILD = path.join(REPO_ROOT, "scripts", "perf", "voice-preview-final-vad.ts");
// The renderer's worklet posts 100 ms of 24 kHz mono PCM16 at a time.
const CHUNK_SAMPLES = REPLAY_SAMPLE_RATE / 10;

const USAGE = `usage: npm run perf voice-preview-final -- [options]

Plays every replay clip into the real OpenAITranscriptionProvider, with its real
VAD and the live OpenAI socket (needs OPENAI_API_KEY; costs cents), and scores
where each segment's final disagrees with its preview against the clip's reference.

  --repeats <n>         passes over the clips (default 3)
  --clips <list>        only these clip ids
  --terms               send every fixture term as a bias term (default none)
  --seed <n>            clip order seed (default 14852)
  --label <name>        result file prefix (default run)
  --rescore <run.json>  score a saved run again with today's references and scoring, sending nothing`;

interface Options {
  repeats: number;
  clips: string[];
  terms: boolean;
  seed: number;
  label: string;
  rescore: string | null;
}

function parseArgs(argv: readonly string[]): Options | null {
  const options: Options = {
    repeats: 3,
    clips: [],
    terms: false,
    seed: 14852,
    label: "run",
    rescore: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    const count = (min: number) => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < min) throw new Error(`${flag} needs an integer >= ${min}`);
      return n;
    };
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--repeats":
        options.repeats = count(1);
        break;
      case "--clips":
        options.clips = value()
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        break;
      case "--terms":
        options.terms = true;
        break;
      case "--seed":
        options.seed = count(0);
        break;
      case "--label":
        options.label = value().replace(/[^\w.-]+/g, "-");
        break;
      case "--rescore":
        options.rescore = value();
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  const unknown = options.clips.filter((id) => !REPLAY_CLIPS.some((clip) => clip.id === id));
  if (unknown.length > 0) throw new Error(`unknown clip(s): ${unknown.join(", ")}`);
  return options;
}

interface RunRecord {
  schemaVersion: number;
  scoringVersion: number;
  complete: boolean;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  git: { revision: string; dirty: boolean };
  node: string;
  platform: string;
  seed: number;
  repeats: number;
  language: string;
  keyterms: string[];
  clips: Array<{
    id: string;
    source: PreparedClip["source"];
    audioMs: number;
    audioHash: string;
    reference: string;
  }>;
  sessions: SessionObservation[];
  summary: RunSummary | null;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

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

function settingsFor(apiKey: string, keyterms: string[]): VoiceInputSettings {
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

interface Host {
  Provider: new () => TranscriptionProvider;
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
async function dictate(
  host: Host,
  prepared: PreparedClip,
  samples: Int16Array,
  pass: number,
  settings: VoiceInputSettings
): Promise<SessionObservation> {
  const vad: VadObservation = {
    forks: 0,
    ready: 0,
    speechStarts: 0,
    speechEnds: 0,
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
    else if (message.type === "error") vad.errors++;
  };
  const onExit = (id: number, exit: { expected: boolean }) => {
    if (mine.has(id) && !exit.expected) vad.unexpectedExits++;
  };
  host.vadEvents.on("fork", onFork);
  host.vadEvents.on("message", onMessage);
  host.vadEvents.on("exit", onExit);

  const provider = new host.Provider();
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
    const started = provider
      .start(settings, `voice-preview-final-${pass}-${prepared.clip.id}`)
      .catch((error: unknown) => ({
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

function load(file: string): RunRecord {
  let run: RunRecord;
  try {
    run = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
  } catch {
    // A parse error can quote the file, and the file quotes transcripts.
    throw new Error(`${file} is not a readable run`);
  }
  if (run.schemaVersion !== VOICE_PREVIEW_FINAL_SCHEMA_VERSION) {
    throw new Error(
      `${file}: schema ${run.schemaVersion}, this script reads ${VOICE_PREVIEW_FINAL_SCHEMA_VERSION}`
    );
  }
  return run;
}

function writeReport(run: RunRecord, file: string): RunSummary {
  // Today's references, so a corrected reference reaches a rescore.
  const references = new Map(REPLAY_CLIPS.map((clip) => [clip.id, clip.reference]));
  const { summary, scored } = scoreRun(run.sessions, references);
  const report = renderReport(
    {
      label: run.label,
      startedAt: run.startedAt,
      revision: run.git.revision,
      dirty: run.git.dirty,
      passes: run.repeats,
      terms: run.keyterms.length > 0,
      complete: run.complete,
      audioMs: run.sessions.reduce((n, session) => n + session.audioMs, 0),
    },
    run.sessions,
    summary,
    scored
  );
  writeFileSync(file, `${report}\n`);
  return summary;
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[voice-preview-final] ${formatErrorMessage(error, "bad arguments")}\n\n${USAGE}`
    );
    return 1;
  }
  if (!options) {
    console.log(USAGE);
    return 0;
  }

  // The report quotes previews and finals, so only counts reach the terminal.
  if (options.rescore) {
    const run = load(options.rescore);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const out = path.join(
      RESULTS_DIR,
      `${path.basename(options.rescore).replace(/\.json$/, "")}-rescored.md`
    );
    const summary = writeReport(run, out);
    console.log(renderHeadline(summary).join("\n"));
    console.error(`\n[voice-preview-final] wrote ${path.relative(REPO_ROOT, path.resolve(out))}`);
    return 0;
  }

  // The provider honours it, and a mock's numbers would pass for OpenAI's.
  if (process.env.DAINTREE_REALTIME_WS_URL) {
    console.error(
      "[voice-preview-final] DAINTREE_REALTIME_WS_URL is set: unset it to measure the real provider"
    );
    return 1;
  }
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("[voice-preview-final] OPENAI_API_KEY is not set");
    return 1;
  }

  // Synthesis happens before anything is sent, so a missing `say` costs nothing.
  const clips = REPLAY_CLIPS.filter(
    (clip) => options.clips.length === 0 || options.clips.includes(clip.id)
  ).map((clip) =>
    prepareClip(clip, {
      cacheDir: CLIP_CACHE_DIR,
      recordingsDir: process.env.VOICE_REPLAY_RECORDINGS_DIR,
      voice: process.env.VOICE_REPLAY_VOICE,
    })
  );
  // Audio goes out as it is, so a recording at another rate would play at the wrong speed.
  const samples = new Map<string, Int16Array>();
  for (const prepared of clips) {
    const pcm = readPcm16Wav(readFileSync(prepared.wavPath));
    if (pcm.sampleRate !== REPLAY_SAMPLE_RATE) {
      console.error(
        `[voice-preview-final] ${prepared.wavPath} is ${pcm.sampleRate} Hz; the provider takes ${REPLAY_SAMPLE_RATE} Hz`
      );
      return 1;
    }
    samples.set(prepared.clip.id, pcm.samples);
  }
  const audioMinutes = (clips.reduce((n, clip) => n + clip.audioMs, 0) * options.repeats) / 60_000;
  console.error(
    `[voice-preview-final] ${clips.length * options.repeats} sessions, ${audioMinutes.toFixed(1)} min of audio, about $${(audioMinutes * LIVE_TRANSCRIBE_USD_PER_MINUTE).toFixed(2)}`
  );

  installElectronStub();
  // The logger decides at load whether to write files into the working
  // directory. Provider logs carry ids and lengths, never text; warnings stay.
  process.env.DAINTREE_DISABLE_FILE_LOGGING = "1";
  const { setLogLevelOverrides } = await import("../../electron/utils/logger");
  setLogLevelOverrides({ "*": "warn" });
  // A computed specifier keeps the provider's import graph out of the perf
  // TypeScript program, which can't see the remote-service keys it reads;
  // `TranscriptionProvider` types every call made on it.
  const providerModule = "../../electron/services/voice/OpenAITranscriptionProvider";
  const { OpenAITranscriptionProvider } = (await import(providerModule)) as {
    OpenAITranscriptionProvider: new () => TranscriptionProvider;
  };
  const { VAD_RETIRE_KILL_MS, waitForRetiringVadProcesses } =
    await import("../../electron/services/voice/openaiVadProcess");
  const { vadEvents } = (await import("electron")) as unknown as { vadEvents: EventEmitter };
  const host: Host = {
    Provider: OpenAITranscriptionProvider,
    waitForRetiringVadProcesses,
    retireWaitMs: VAD_RETIRE_KILL_MS + 2_000,
    vadEvents,
  };

  const keyterms = options.terms ? allFixtureTerms() : [];
  const settings = settingsFor(apiKey, keyterms);
  const startedAt = new Date();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(
    RESULTS_DIR,
    `${options.label}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`
  );
  const run: RunRecord = {
    schemaVersion: VOICE_PREVIEW_FINAL_SCHEMA_VERSION,
    scoringVersion: VOICE_PREVIEW_FINAL_SCORING_VERSION,
    complete: false,
    label: options.label,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    git: { revision: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    seed: options.seed,
    repeats: options.repeats,
    language: settings.language,
    keyterms,
    clips: clips.map((prepared) => ({
      id: prepared.clip.id,
      source: prepared.source,
      audioMs: prepared.audioMs,
      audioHash: contentHash(readFileSync(prepared.wavPath)),
      reference: prepared.clip.reference,
    })),
    sessions: [],
    summary: null,
  };
  // Written whole and renamed into place after every session, so an
  // interrupted run keeps every session it paid for.
  const save = () => {
    writeFileSync(`${jsonPath}.tmp`, `${JSON.stringify(run, null, 2)}\n`);
    renameSync(`${jsonPath}.tmp`, jsonPath);
  };
  save();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      console.error(`\n[voice-preview-final] interrupted; kept ${run.sessions.length} sessions`);
      process.exit(130);
    }
    interrupted = true;
    console.error(
      "\n[voice-preview-final] stopping after the session in flight (Ctrl+C again to quit now)"
    );
  });

  // Passes outermost, so a run cut short has every clip it reached equally often.
  let stopped = false;
  for (let pass = 1; pass <= options.repeats && !interrupted && !stopped; pass++) {
    for (const prepared of seededShuffle(clips, options.seed + pass)) {
      if (interrupted || stopped) break;
      const session = await dictate(host, prepared, samples.get(prepared.clip.id)!, pass, settings);
      run.sessions.push(session);
      save();
      const completions = session.events.filter((event) => event.type === "complete").length;
      const errors = session.events.filter((event) => event.type === "error").length;
      console.error(
        `[voice-preview-final] pass ${pass} · ${prepared.clip.id}: ${completions} segment(s), VAD ${session.vad.ready > 0 ? "ready" : "not ready"}${errors ? `, ${errors} error(s)` : ""}${session.startResult.ok ? "" : ", start failed"}`
      );
      // A VAD still running would share the next session's CPU and timing.
      if (session.vad.leftRunning) {
        console.error(`[voice-preview-final] a VAD process outlived its session; stopping`);
        stopped = true;
      }
    }
  }

  run.complete = !interrupted && !stopped;
  run.finishedAt = new Date().toISOString();
  const markdownPath = jsonPath.replace(/\.json$/, ".md");
  run.summary = writeReport(run, markdownPath);
  save();
  console.log(renderHeadline(run.summary).join("\n"));
  console.error(
    `\n[voice-preview-final] wrote ${path.relative(REPO_ROOT, jsonPath)} and .md (both quote transcripts; keep them in .tmp/)`
  );
  return interrupted ? 130 : stopped ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[voice-preview-final] fatal:", error);
    process.exit(1);
  }
);
