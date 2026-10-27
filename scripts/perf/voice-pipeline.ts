import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LONG_SPEECH_CLIPS,
  readPcm16Wav,
  REPLAY_CLIPS,
  REPLAY_SAMPLE_RATE,
  type PreparedClip,
  type ReplayClip,
} from "../../e2e/helpers/voiceReplayFixtures";
import type { GrokTranscriptionTuning } from "../../electron/services/voice/grokTranscriptionTuning";
import type { TranscriptionProvider } from "../../electron/services/voice/TranscriptionProvider";
import type { VoiceCommandTarget } from "../../electron/services/voiceCommandTarget";
import type {
  VoiceCorrectionRequest,
  VoiceCorrectionResult,
  VoiceCorrectionService as VoiceCorrectionServiceType,
  VoiceCorrectionSettings,
} from "../../electron/services/VoiceCorrectionService";
import { getAgentConfig } from "../../shared/config/agentRegistry";
import { VOICE_CLEANUP_AI_MODEL } from "../../shared/config/voiceCorrection";
import { getBuiltinSlashCommands } from "../../shared/types/slashCommands";
import { buildVoiceCommandVocabulary } from "../../shared/utils/voiceAgentCommands";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import {
  buildCodeNameIndex,
  matchCodeNames,
  type CodeNameIndex,
} from "../../electron/services/voiceCodeNames";
import { shiftSpans, type VoiceTextSpan } from "../../shared/utils/voiceUncertainWords";
import { CorrectionStreamAligner } from "../../src/services/voiceCorrectionStream";
import { seededShuffle } from "./lib/voiceCleanupScore";
import { installLiveRuntime, liveVoiceSettings } from "./lib/voiceLiveSession";
import { parseVoice, prepareVoiceClip, type PipelineVoice } from "./lib/voicePipelineAudio";
import {
  ACCEPTED_REFERENCES,
  parsePipelineArm,
  renderPipelineTable,
  renderVoiceTable,
  scorePipelineSession,
  summarisePipeline,
  VOICE_PIPELINE_SCHEMA_VERSION,
  VOICE_PIPELINE_SCORING_VERSION,
  type ArmSummary,
  type CleanupRecord,
  type PipelineArm,
  type PipelineEvent,
  type PipelineSession,
  type ScoredPipelineSession,
} from "./lib/voicePipelineScore";
import { REPO_ROOT } from "./registry";

const RESULTS_DIR = path.join(REPO_ROOT, ".tmp", "perf-results", "voice-pipeline");
const SAY_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "voice-replay", "clips");
const VOICE_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "voice-pipeline", "clips");
const CLIPS: readonly ReplayClip[] = [...REPLAY_CLIPS, ...LONG_SPEECH_CLIPS];
const DEFAULT_ARMS = ["prod"];
const DEFAULT_VOICES = [
  "say",
  "gemini:Puck",
  "gemini:Kore",
  "minimax:English_Deep-VoicedGentleman",
];
const CHUNK_SAMPLES = REPLAY_SAMPLE_RATE / 10;

const USAGE = `usage: npm run perf voice-pipeline -- [options]

Dictates every replay clip, in each voice, into the real GrokTranscriptionProvider
against the live xAI socket, then cleans up what landed with the real
VoiceCorrectionService (gpt-6.1-terra) against the live Responses API, as a
dictation in a Claude Code pane does. Scores what reached the draft and how long
the speaker waited after the stop. Needs GROK_API_KEY (or XAI_API_KEY) and
OPENAI_API_KEY; gemini voices need GOOGLE_API_KEY (or GEMINI_API_KEY), minimax
voices REPLICATE_API_TOKEN. Costs cents.

  --arms <list>         pipeline arms, the first the reference (default ${DEFAULT_ARMS.join(",")})
                        tokens joined with +: prod, ep<ms>, nofmt, spec, raw
  --voices <list>       say, say:<name>, gemini:<name>, minimax:<voice_id>
                        (default ${DEFAULT_VOICES.join(",")})
  --stop-tails <list>   ms of silence between the speech ending and the stop (default 0,700)
  --repeats <n>         passes (default 1)
  --clips <list>        only these clip ids (default every replay and long-speech clip)
  --terms               send each clip's terms as Grok keyterms (default none)
  --repo                dictate as into a pane on this repository: its names read as production
                        reads them, sent to Grok as keyterms and to cleanup as repository names,
                        and the code names each passage spells out
  --seed <n>            order seed (default 14900)
  --label <name>        result file prefix (default run)
  --rescore <run.json>  score a saved run again, sending nothing`;

interface Options {
  arms: PipelineArm[];
  voices: PipelineVoice[];
  stopTails: number[];
  repeats: number;
  clips: string[];
  terms: boolean;
  repo: boolean;
  seed: number;
  label: string;
  rescore: string | null;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv: readonly string[]): Options | null {
  const options: Options = {
    arms: DEFAULT_ARMS.map(parsePipelineArm),
    voices: DEFAULT_VOICES.map(parseVoice),
    stopTails: [0, 700],
    repeats: 1,
    clips: [],
    terms: false,
    repo: false,
    seed: 14900,
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
    if (flag === "--help" || flag === "-h") return null;
    else if (flag === "--arms") options.arms = list(value()).map(parsePipelineArm);
    else if (flag === "--voices") options.voices = list(value()).map(parseVoice);
    else if (flag === "--stop-tails") options.stopTails = list(value()).map(Number);
    else if (flag === "--repeats") options.repeats = Number(value());
    else if (flag === "--clips") options.clips = list(value());
    else if (flag === "--terms") options.terms = true;
    else if (flag === "--repo") options.repo = true;
    else if (flag === "--seed") options.seed = Number(value());
    else if (flag === "--label") {
      options.label = value();
      if (!/^[\w.-]+$/.test(options.label)) throw new Error("--label takes letters, digits, . _ -");
    } else if (flag === "--rescore") options.rescore = value();
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1) {
    throw new Error("--repeats must be a positive whole number");
  }
  if (options.stopTails.some((tail) => !Number.isFinite(tail) || tail < 0)) {
    throw new Error("--stop-tails must be milliseconds");
  }
  const unknown = options.clips.filter((id) => !CLIPS.some((clip) => clip.id === id));
  if (unknown.length > 0) throw new Error(`unknown clip ids: ${unknown.join(", ")}`);
  return options;
}

/** Claude Code with its built-in commands, as production describes a terminal running it. */
function claudeCodeTarget(): VoiceCommandTarget {
  const config = getAgentConfig("claude")!;
  return {
    agentId: "claude",
    agentName: config.name,
    isAssistant: false,
    vocabulary: buildVoiceCommandVocabulary(
      getBuiltinSlashCommands("claude"),
      config.completionSources ?? []
    ),
  };
}

/** What production reads from the repository a pane lives in, for its keyterms and cleanup. */
interface RepoContext {
  keyterms: string[];
  repositoryNames: string[];
  /** The repository's code names, as main indexes a local pane's project. */
  codeNames: CodeNameIndex;
}

const NO_REPO_CONTEXT: RepoContext = { keyterms: [], repositoryNames: [], codeNames: new Map() };

async function readRepoContext(): Promise<RepoContext> {
  // Computed specifiers keep these main-process modules out of the perf
  // TypeScript program, as the provider's is.
  const repoModule = "../../electron/services/voiceRepoKeyterms";
  const contextModule = "../../electron/services/voiceContextKeyterms";
  const { deriveRepoNames } = (await import(repoModule)) as {
    deriveRepoNames: (root: string) => Promise<{ names: string[] }>;
  };
  const { assembleKeyterms, screenCorrectionRepositoryNames } = (await import(contextModule)) as {
    assembleKeyterms: (opts: {
      customDictionary: string[];
      projectName: string;
      paneReads: { repoNames: string[]; branchName: null; terminalTerms: string[] };
    }) => Promise<string[]>;
    screenCorrectionRepositoryNames: (names: readonly unknown[]) => string[];
  };
  const searchModule = "../../electron/services/FileSearchService";
  const { fileSearchService } = (await import(searchModule)) as {
    fileSearchService: { listFiles: (cwd: string) => Promise<readonly string[]> };
  };
  const { names } = await deriveRepoNames(REPO_ROOT);
  const repositoryNames = screenCorrectionRepositoryNames(names);
  // The listing production reads for a pane's repository.
  const files = await fileSearchService.listFiles(REPO_ROOT);
  return {
    keyterms: await assembleKeyterms({
      customDictionary: [],
      projectName: "daintree",
      paneReads: { repoNames: names, branchName: null, terminalTerms: [] },
    }),
    repositoryNames,
    codeNames: buildCodeNameIndex(files, repositoryNames),
  };
}

function cleanupSettings(apiKey: string, repo: RepoContext): VoiceCorrectionSettings {
  return {
    ...(repo.repositoryNames.length > 0 ? { repositoryNames: repo.repositoryNames } : {}),
    model: VOICE_CLEANUP_AI_MODEL,
    apiKey,
    customDictionary: [],
    projectName: "daintree",
    projectPath: "/Users/dev/Projects/daintree",
    language: "en",
    commandTarget: claudeCodeTarget(),
    ...(process.env.OPENAI_ORG_ID ? { organizationId: process.env.OPENAI_ORG_ID } : {}),
    ...(process.env.OPENAI_PROJECT_ID ? { projectId: process.env.OPENAI_PROJECT_ID } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

type ProviderClass = new (tuning?: Partial<GrokTranscriptionTuning>) => TranscriptionProvider;

interface Runtime {
  Provider: ProviderClass;
  service: VoiceCorrectionServiceType;
  xaiKey: string;
  openaiKey: string;
  repo: RepoContext;
}

/** The completions joined as the draft holds them, each one's unsure words moved with it. */
class DraftText {
  text = "";
  uncertain: VoiceTextSpan[] = [];

  add(text: string, spans: readonly VoiceTextSpan[] | undefined): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const lead = text.indexOf(trimmed);
    if (this.text) this.text += " ";
    this.uncertain.push(
      ...shiftSpans(
        (spans ?? []).map((span) => ({ from: span.from - lead, to: span.to - lead })),
        this.text.length
      )
    );
    this.text += trimmed;
  }
}

interface CleanupAttempt {
  text: string;
  controller: AbortController;
  sentAt: number;
  /** When production would first show its cleaned words: the stream aligner's first rewrite. */
  firstTextAt: number | null;
  doneAt: number | null;
  promise: Promise<VoiceCorrectionResult>;
}

// Production's prefetch, as `VoiceRecordingService` and main run it: words
// that land and stay unanswered this long start the stop's cleanup, at most
// this many times a session and for a passage at most this long.
const PREFETCH_SETTLE_MS = 150;
const PREFETCHES_PER_SESSION = 8;
const PREFETCH_MAX_CHARS = 2_000;

async function dictate(
  runtime: Runtime,
  prepared: PreparedClip,
  samples: Int16Array,
  arm: PipelineArm,
  voice: PipelineVoice,
  pass: number,
  stopTailMs: number,
  keyterms: string[]
): Promise<PipelineSession> {
  const settings = {
    ...liveVoiceSettings("", keyterms),
    transcriptionProvider: "grok" as const,
    xaiApiKey: runtime.xaiKey,
    openaiApiKey: runtime.openaiKey,
  };
  const correction = cleanupSettings(runtime.openaiKey, runtime.repo);
  const provider = new runtime.Provider(arm.tuning);
  const events: PipelineEvent[] = [];
  const draft = new DraftText();
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const attempts: CleanupAttempt[] = [];
  const usage: CleanupRecord["usage"] = [];
  let usageMissing = 0;
  let stopping = false;
  let prefetches = 0;
  let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  const sendCleanup = (text: string, uncertain: VoiceTextSpan[]) => {
    const controller = new AbortController();
    const aligner = new CorrectionStreamAligner(text);
    const codeNames = matchCodeNames(text, runtime.repo.codeNames);
    const request: VoiceCorrectionRequest = {
      rawText: text,
      reason: "stop",
      startsPrompt: true,
      ...(uncertain.length > 0 ? { uncertain } : {}),
      ...(codeNames.length > 0 ? { codeNames } : {}),
    };
    const attempt: CleanupAttempt = {
      text,
      controller,
      sentAt: at(),
      firstTextAt: null,
      doneAt: null,
      promise: Promise.resolve(null as unknown as VoiceCorrectionResult),
    };
    attempt.promise = runtime.service
      .correct(request, correction, controller.signal, (streamed) => {
        if (attempt.firstTextAt === null && aligner.advance(streamed)) attempt.firstTextAt = at();
      })
      .then((result) => {
        attempt.doneAt = at();
        // A replacement that streamed nothing showable appears whole as it lands.
        if (result.action === "replace" && attempt.firstTextAt === null) {
          attempt.firstTextAt = attempt.doneAt;
        }
        // One that went out and came back without usage was still billed.
        if (result.roundTrip?.usage) usage.push(result.roundTrip.usage);
        else if (result.roundTrip) usageMissing++;
        return result;
      });
    attempts.push(attempt);
    return attempt;
  };

  const prefetch = () => {
    prefetchTimer = null;
    const last = attempts.at(-1);
    if (stopping || !draft.text || last?.text === draft.text) return;
    // A later pause cancels the run the dictation moved past.
    last?.controller.abort();
    if (prefetches >= PREFETCHES_PER_SESSION || draft.text.length > PREFETCH_MAX_CHARS) return;
    prefetches++;
    sendCleanup(draft.text, [...draft.uncertain]);
  };

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
        incomplete: event.incomplete === true,
      });
      draft.add(event.text, event.uncertain);
      if (arm.speculate && !stopping && event.text.trim()) {
        if (prefetchTimer !== null) clearTimeout(prefetchTimer);
        prefetchTimer = setTimeout(prefetch, PREFETCH_SETTLE_MS);
      }
    } else if (event.type === "error") {
      events.push({
        at: at(),
        type: "error",
        code: event.error.code,
        severity: event.error.severity,
      });
    } else if (event.type === "status") {
      events.push({ at: at(), type: "status", status: event.status });
    } else if (event.type === "speech_started") {
      events.push({ at: at(), type: "speech_started" });
    }
  });

  let startError: string | null = null;
  try {
    // Production warms cleanup's prompt as the session starts.
    if (arm.cleanup) void runtime.service.warm(correction);
    const started = provider
      .start(settings, `pipeline-${pass}-${prepared.clip.id}`)
      .catch((error: unknown) => ({
        ok: false as const,
        error: formatErrorMessage(error, "start threw"),
      }));
    const tailSamples = Math.round((stopTailMs / 1000) * REPLAY_SAMPLE_RATE);
    const total = samples.length + tailSamples;
    let maxChunkLateMs = 0;
    for (let offset = 0; offset < total; offset += CHUNK_SAMPLES) {
      const end = Math.min(offset + CHUNK_SAMPLES, total);
      const due = t0 + (end / REPLAY_SAMPLE_RATE) * 1000;
      await sleep(due - performance.now());
      maxChunkLateMs = Math.max(maxChunkLateMs, performance.now() - due);
      const chunk = new Int16Array(end - offset);
      if (offset < samples.length) {
        chunk.set(samples.subarray(offset, Math.min(end, samples.length)));
      }
      provider.sendAudioChunk(chunk.buffer);
    }
    const stopMs = at();
    // Production prefetches nothing once the stop is pressed.
    stopping = true;
    if (prefetchTimer !== null) clearTimeout(prefetchTimer);
    // Production opens cleanup's socket while the stop drains.
    if (arm.cleanup) runtime.service.preconnect();
    const drained = provider.stopGracefully();
    const startResult = await started;
    if (!startResult.ok) startError = startResult.error;
    await drained;
    const drainEndMs = at();
    const stats = provider.getSessionStats();

    let cleanup: CleanupRecord | null = null;
    if (arm.cleanup && draft.text) {
      const last = attempts.at(-1);
      const adopted = last && last.text === draft.text ? last : null;
      if (last && !adopted) last.controller.abort();
      let attempt = adopted ?? sendCleanup(draft.text, [...draft.uncertain]);
      let result = await attempt.promise;
      // Production gives a stop whose prefetch failed a try of its own.
      if (adopted && result.failed) {
        attempt = sendCleanup(draft.text, [...draft.uncertain]);
        result = await attempt.promise;
      }
      // A prefetch's words can't show before the drain proves nothing followed.
      const firstTextAt =
        attempt.firstTextAt === null ? null : Math.max(attempt.firstTextAt, drainEndMs);
      cleanup = {
        sentAt: attempt.sentAt,
        firstTextAt,
        doneAt: Math.max(attempt.doneAt ?? at(), drainEndMs),
        verdict: result.verdict,
        text: result.action === "replace" ? result.correctedText.trim() : draft.text,
        ...(result.proposal ? { proposal: result.proposal } : {}),
        failed: result.failed === true,
        speculation: !arm.speculate
          ? "none"
          : adopted && attempt === adopted
            ? "adopted"
            : "missed",
        requests: attempts.length,
        usage,
      };
    }
    // Discarded prefetches finish on their own; let them settle before the next session.
    await Promise.allSettled(attempts.map((attempt) => attempt.promise));
    if (cleanup) cleanup.usageMissing = usageMissing;
    return {
      clip: prepared.clip.id,
      voice: voice.id,
      arm: arm.id,
      pass,
      startError,
      events,
      audioMs: prepared.audioMs,
      stopTailMs,
      stopMs,
      drainEndMs,
      maxChunkLateMs: Math.round(maxChunkLateMs),
      raw: draft.text,
      cleanup,
      reconnects: stats.reconnects,
      droppedConnect: stats.droppedConnect,
    };
  } finally {
    if (prefetchTimer !== null) clearTimeout(prefetchTimer);
    provider.destroy();
  }
}

interface RunRecord {
  schemaVersion: number;
  scoringVersion: number;
  complete: boolean;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  git: { revision: string; dirty: boolean };
  model: string;
  arms: string[];
  voices: string[];
  stopTails: number[];
  repeats: number;
  terms: boolean;
  repo?: boolean;
  seed: number;
  sessions: PipelineSession[];
  failures: Array<{ clip: string; voice: string; arm: string; error: string }>;
  summary?: ArmSummary[];
}

function referencesOf(clip: ReplayClip): string[] {
  return [clip.reference, ...(ACCEPTED_REFERENCES[clip.id] ?? [])];
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function scoreRun(run: RunRecord): ScoredPipelineSession[] {
  return run.sessions.flatMap((session) => {
    const clip = CLIPS.find((candidate) => candidate.id === session.clip);
    return clip ? [scorePipelineSession(session, referencesOf(clip), clip.terms, run.model)] : [];
  });
}

function renderReport(run: RunRecord, scored: readonly ScoredPipelineSession[]): string {
  const summary = summarisePipeline(scored, run.arms);
  const tails = [...new Set(run.sessions.map((session) => session.stopTailMs))];
  const lines = [
    `# voice-pipeline ${run.label}`,
    "",
    `${run.startedAt} · ${run.git.revision.slice(0, 10)}${run.git.dirty ? " (dirty)" : ""} · cleanup ${run.model} · voices ${run.voices.join(", ")} · stop tails ${run.stopTails.join(", ")} ms · ${run.repeats} pass(es)${run.terms ? " · clip terms as keyterms" : ""}${run.repo ? " · this repository's context" : ""}`,
    "",
    "Times in ms, p50 / p95. First preview is from the start; the rest from the stop press. Settled is when the draft holds its final text (the cleanup landed or gave up; the drain without one).",
    "",
    "## All sessions",
    "",
    renderPipelineTable(summary),
  ];
  for (const tail of tails) {
    lines.push(
      "",
      `## Stop ${tail} ms after the speech`,
      "",
      renderPipelineTable(
        summarisePipeline(
          scored.filter((s) => s.session.stopTailMs === tail),
          run.arms
        )
      )
    );
  }
  lines.push("", "## Per voice", "");
  for (const arm of run.arms) lines.push(renderVoiceTable(scored, arm, run.arms), "");
  lines.push("## Sessions whose final text differs from the reference", "");
  for (const clip of CLIPS) {
    const rows = scored.filter((s) => s.session.clip === clip.id && !s.finalForm.exact);
    if (rows.length === 0) continue;
    lines.push(`### ${clip.id}`, "", `Reference: ${clip.reference}`, "");
    for (const row of rows) {
      const { session } = row;
      lines.push(
        `- ${session.arm} · ${session.voice} · tail ${session.stopTailMs} · pass ${session.pass}`,
        `  - raw: ${session.raw}`,
        `  - final: ${session.cleanup?.text ?? "(no cleanup)"}${session.cleanup ? ` (${session.cleanup.verdict})` : ""}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[voice-pipeline] ${formatErrorMessage(error, "bad arguments")}\n\n${USAGE}`);
    return 1;
  }
  if (!options) {
    console.log(USAGE);
    return 0;
  }

  if (options.rescore) {
    const run = JSON.parse(readFileSync(options.rescore, "utf8")) as RunRecord;
    const report = renderReport(run, scoreRun(run));
    // Into the results directory whatever the input's path: it quotes transcripts.
    mkdirSync(RESULTS_DIR, { recursive: true });
    const out = path.join(
      RESULTS_DIR,
      `${path.basename(options.rescore).replace(/\.json$/, "")}-rescored.md`
    );
    writeFileSync(out, `${report}\n`);
    console.log(renderPipelineTable(summarisePipeline(scoreRun(run), run.arms)));
    console.error(`[voice-pipeline] wrote ${path.relative(REPO_ROOT, path.resolve(out))}`);
    return 0;
  }

  const xaiKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";
  if (!xaiKey || !openaiKey) {
    console.error("[voice-pipeline] needs GROK_API_KEY (or XAI_API_KEY) and OPENAI_API_KEY");
    return 1;
  }
  if (process.env.DAINTREE_GROK_WS_URL) {
    console.error("[voice-pipeline] DAINTREE_GROK_WS_URL points Grok at a mock; unset it");
    return 1;
  }
  const keys = {
    gemini: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "",
    replicate: process.env.REPLICATE_API_TOKEN ?? process.env.REPLICATE_API_KEY ?? "",
  };
  for (const voice of options.voices) {
    if (voice.engine === "gemini" && !keys.gemini) {
      console.error(`[voice-pipeline] ${voice.id} needs GOOGLE_API_KEY`);
      return 1;
    }
    if (voice.engine === "minimax" && !keys.replicate) {
      console.error(`[voice-pipeline] ${voice.id} needs REPLICATE_API_TOKEN`);
      return 1;
    }
  }

  const clips = options.clips.length
    ? CLIPS.filter((clip) => options.clips.includes(clip.id))
    : [...CLIPS];
  const prepared = new Map<string, { clip: PreparedClip; samples: Int16Array }>();
  for (const voice of options.voices) {
    for (const clip of clips) {
      const cacheDir = voice.engine === "say" ? SAY_CACHE_DIR : VOICE_CACHE_DIR;
      const ready = await prepareVoiceClip(clip, voice, cacheDir, keys);
      const pcm = readPcm16Wav(readFileSync(ready.wavPath));
      if (pcm.sampleRate !== REPLAY_SAMPLE_RATE) {
        throw new Error(`${ready.wavPath} is ${pcm.sampleRate} Hz, not ${REPLAY_SAMPLE_RATE}`);
      }
      prepared.set(`${clip.id}|${voice.id}`, { clip: ready, samples: pcm.samples });
    }
    console.error(`[voice-pipeline] ${voice.id}: ${clips.length} clips ready`);
  }

  await installLiveRuntime();
  // A computed specifier keeps the provider's import graph out of the perf
  // TypeScript program, which can't see the remote-service keys it reads.
  const providerModule = "../../electron/services/voice/GrokTranscriptionProvider";
  const { GrokTranscriptionProvider } = (await import(providerModule)) as {
    GrokTranscriptionProvider: ProviderClass;
  };
  const { VoiceCorrectionService } = await import("../../electron/services/VoiceCorrectionService");
  const runtime: Runtime = {
    Provider: GrokTranscriptionProvider,
    service: new VoiceCorrectionService(),
    xaiKey,
    openaiKey,
    repo: options.repo ? await readRepoContext() : NO_REPO_CONTEXT,
  };
  if (options.repo) {
    console.error(
      `[voice-pipeline] repository context: ${runtime.repo.keyterms.length} keyterms, ${runtime.repo.repositoryNames.length} names for cleanup, ${runtime.repo.codeNames.size} code names`
    );
  }

  const startedAt = new Date();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(
    RESULTS_DIR,
    `${options.label}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`
  );
  const run: RunRecord = {
    schemaVersion: VOICE_PIPELINE_SCHEMA_VERSION,
    scoringVersion: VOICE_PIPELINE_SCORING_VERSION,
    complete: false,
    label: options.label,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    git: { revision: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
    model: VOICE_CLEANUP_AI_MODEL,
    arms: options.arms.map((arm) => arm.id),
    voices: options.voices.map((voice) => voice.id),
    stopTails: options.stopTails,
    repeats: options.repeats,
    terms: options.terms,
    repo: options.repo,
    seed: options.seed,
    sessions: [],
    failures: [],
  };
  const save = () => {
    writeFileSync(`${jsonPath}.partial`, JSON.stringify(run, null, 2));
    renameSync(`${jsonPath}.partial`, jsonPath);
  };

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error("\n[voice-pipeline] finishing the session in flight; Ctrl+C again to quit");
  });

  let seed = options.seed;
  for (let pass = 1; pass <= options.repeats && !interrupted; pass++) {
    for (const clip of seededShuffle(clips, seed++)) {
      for (const voice of options.voices) {
        for (const tail of options.stopTails) {
          // Arms back to back, in an order shuffled per dictation, so a slow
          // minute on the network lands on all of them.
          for (const arm of seededShuffle(options.arms, seed++)) {
            if (interrupted) break;
            const ready = prepared.get(`${clip.id}|${voice.id}`)!;
            try {
              const session = await dictate(
                runtime,
                ready.clip,
                ready.samples,
                arm,
                voice,
                pass,
                tail,
                [...(options.terms ? clip.terms : []), ...runtime.repo.keyterms]
              );
              run.sessions.push(session);
              const scored = scorePipelineSession(
                session,
                referencesOf(clip),
                clip.terms,
                run.model
              );
              console.error(
                `[voice-pipeline] ${pass} · ${clip.id} · ${voice.id} · tail ${tail} · ${arm.id}: raw ${scored.rawScore.substitutions + scored.rawScore.deletions + scored.rawScore.insertions} edits, final ${scored.finalScore.substitutions + scored.finalScore.deletions + scored.finalScore.insertions}, settled ${scored.stopToSettledMs} ms${scored.errored ? " (errored)" : ""}`
              );
            } catch (error) {
              run.failures.push({
                clip: clip.id,
                voice: voice.id,
                arm: arm.id,
                error: formatErrorMessage(error, "session threw"),
              });
              console.error(`[voice-pipeline] ${clip.id} · ${voice.id} · ${arm.id} failed`, error);
            }
            save();
          }
        }
      }
    }
  }

  run.complete = !interrupted;
  run.finishedAt = new Date().toISOString();
  const scored = scoreRun(run);
  run.summary = summarisePipeline(scored, run.arms);
  save();
  const markdownPath = jsonPath.replace(/\.json$/, ".md");
  writeFileSync(markdownPath, `${renderReport(run, scored)}\n`);
  console.log(renderPipelineTable(run.summary));
  console.error(
    `\n[voice-pipeline] wrote ${path.relative(REPO_ROOT, jsonPath)} and .md (both quote transcripts; keep them in .tmp/)`
  );
  return interrupted ? 130 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[voice-pipeline] fatal:", error);
    process.exit(1);
  }
);
