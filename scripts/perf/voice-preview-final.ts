import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { seededShuffle } from "./lib/voiceCleanupScore";
import { dictate, liveVoiceSettings, loadLiveProviderHost } from "./lib/voiceLiveSession";
import {
  LIVE_TRANSCRIBE_USD_PER_MINUTE,
  renderHeadline,
  renderReport,
  scoreRun,
  VOICE_PREVIEW_FINAL_SCHEMA_VERSION,
  VOICE_PREVIEW_FINAL_SCORING_VERSION,
  type RunSummary,
  type SessionObservation,
} from "./lib/voicePreviewFinalScore";
import { REPO_ROOT } from "./registry";

const RESULTS_DIR = path.join(REPO_ROOT, ".tmp", "perf-results", "voice-preview-final");
const CLIP_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "voice-replay", "clips");

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

  const host = await loadLiveProviderHost();
  const keyterms = options.terms ? allFixtureTerms() : [];
  const settings = liveVoiceSettings(apiKey, keyterms);
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
      const session = await dictate(host, prepared, samples.get(prepared.clip.id)!, {
        pass,
        name: `voice-preview-final-${pass}-${prepared.clip.id}`,
        settings,
      });
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
