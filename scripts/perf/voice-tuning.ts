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
import type { OpenAITranscriptionTuning } from "../../electron/services/voice/openaiTranscriptionTuning";
import { formatErrorMessage } from "../../shared/utils/errorMessage";
import { seededShuffle } from "./lib/voiceCleanupScore";
import { dictate, liveVoiceSettings, loadLiveProviderHost } from "./lib/voiceLiveSession";
import { LIVE_TRANSCRIBE_USD_PER_MINUTE } from "./lib/voicePreviewFinalScore";
import {
  isExcluded,
  parseTuningArm,
  renderTuningTable,
  scoreTuningSession,
  summariseTuning,
  VOICE_TUNING_SCHEMA_VERSION,
  VOICE_TUNING_SCORING_VERSION,
  type ScoredTuningSession,
  type TuningArm,
  type TuningSession,
  type TuningSummary,
} from "./lib/voiceTuningScore";
import { REPO_ROOT } from "./registry";

const RESULTS_DIR = path.join(REPO_ROOT, ".tmp", "perf-results", "voice-tuning");
const CLIP_CACHE_DIR = path.join(REPO_ROOT, ".tmp", "voice-replay", "clips");
const DEFAULT_ARMS = ["low", "medium", "high"];

const USAGE = `usage: npm run perf voice-tuning -- [options]

Plays every replay clip into the real OpenAITranscriptionProvider under each arm's
delay tier and segmentation, with its real VAD and the live OpenAI socket (needs
OPENAI_API_KEY; costs cents), and scores the finals against the clip's reference.

  --arms <list>         arms to compare, the first is the reference (default ${DEFAULT_ARMS.join(",")})
                        <delay>             production's segmentation at that tier
                        <delay>:cap<s>      cut continuous speech only at <s> seconds
                        <delay>:gap<a>-<b>  cut it at the first short pause after <a> s, or at <b> s
  --repeats <n>         passes over the clips (default 3)
  --clips <list>        only these clip ids
  --terms               send every fixture term as a bias term (default none)
  --seed <n>            clip and arm order seed (default 14625)
  --label <name>        result file prefix (default run)
  --rescore <run.json>  score a saved run again with today's references and scoring, sending nothing`;

interface Options {
  arms: TuningArm[];
  repeats: number;
  clips: string[];
  terms: boolean;
  seed: number;
  label: string;
  rescore: string | null;
}

function parseArgs(argv: readonly string[]): Options | null {
  const options: Options = {
    arms: DEFAULT_ARMS.map(parseTuningArm),
    repeats: 3,
    clips: [],
    terms: false,
    seed: 14625,
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
    const list = () =>
      value()
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    switch (flag) {
      case "--help":
      case "-h":
        return null;
      case "--arms":
        options.arms = list().map(parseTuningArm);
        break;
      case "--repeats":
        options.repeats = count(1);
        break;
      case "--clips":
        options.clips = list();
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
  if (options.arms.length === 0) throw new Error("--arms needs at least one arm");
  const ids = options.arms.map((arm) => arm.id);
  if (new Set(ids).size !== ids.length) throw new Error("--arms names an arm twice");
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
  arms: Array<{ id: string; tuning: OpenAITranscriptionTuning }>;
  clips: Array<{
    id: string;
    source: PreparedClip["source"];
    audioMs: number;
    audioHash: string;
    reference: string;
  }>;
  sessions: TuningSession[];
  summary: TuningSummary | null;
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
  if (run.schemaVersion !== VOICE_TUNING_SCHEMA_VERSION) {
    throw new Error(
      `${file}: schema ${run.schemaVersion}, this script reads ${VOICE_TUNING_SCHEMA_VERSION}`
    );
  }
  return run;
}

/**
 * The comparison, then every clip with its reference and what each arm made
 * of it, for reading (and listening) through where the arms differ.
 */
function writeReport(run: RunRecord, file: string): TuningSummary {
  // Today's references and terms, so a corrected reference reaches a rescore.
  const clips = new Map(REPLAY_CLIPS.map((clip) => [clip.id, clip]));
  const results = run.sessions.flatMap((session) => {
    const clip = clips.get(session.clip);
    return clip ? [scoreTuningSession(session, clip.reference, clip.terms)] : [];
  });
  const summary = summariseTuning(
    run.arms.map((arm) => arm.id),
    results
  );
  const lines = [
    `# voice-tuning · ${run.label}`,
    "",
    `${run.startedAt} · ${run.git.revision.slice(0, 10)}${run.git.dirty ? " (dirty)" : ""} · ${run.repeats} passes · terms ${run.keyterms.length > 0 ? "on" : "off"}${run.complete ? "" : " · INCOMPLETE"}`,
    "",
    ...run.arms.map(
      (arm) =>
        `- \`${arm.id}\`: delay ${arm.tuning.delay}, ${arm.tuning.minSegmentMs === null ? `cut at ${arm.tuning.maxSegmentMs} ms` : `cut at the first pause after ${arm.tuning.minSegmentMs} ms, or at ${arm.tuning.maxSegmentMs} ms`}`
    ),
    "",
    ...renderTuningTable(summary),
  ];
  if (summary.excluded.length > 0) {
    lines.push("", "## Excluded", "");
    for (const session of summary.excluded) {
      lines.push(
        `- ${session.arm} · ${session.clip} · pass ${session.pass}: ${session.reasons.join(", ")}`
      );
    }
  }
  lines.push("", "## Clips", "");
  const scored = results.filter((result): result is ScoredTuningSession => !isExcluded(result));
  for (const clip of run.clips) {
    const reference = clips.get(clip.id)?.reference ?? clip.reference;
    lines.push(`### ${clip.id} (${(clip.audioMs / 1000).toFixed(1)} s)`, "", `> ${reference}`, "");
    for (const arm of run.arms) {
      for (const result of scored.filter((r) => r.arm === arm.id && r.clip === clip.id)) {
        const { score } = result;
        lines.push(
          `- **${arm.id}** pass ${result.pass}, ${score.substitutions + score.deletions + score.insertions} edits, ${result.segments} segment(s)${score.missedTerms.length ? `, missed ${score.missedTerms.join(", ")}` : ""}: ${result.hypothesis}`
        );
      }
    }
    lines.push("");
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return summary;
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[voice-tuning] ${formatErrorMessage(error, "bad arguments")}\n\n${USAGE}`);
    return 1;
  }
  if (!options) {
    console.log(USAGE);
    return 0;
  }

  // The report quotes finals, so only the table reaches the terminal.
  if (options.rescore) {
    const run = load(options.rescore);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const out = path.join(
      RESULTS_DIR,
      `${path.basename(options.rescore).replace(/\.json$/, "")}-rescored.md`
    );
    const summary = writeReport(run, out);
    console.log(renderTuningTable(summary).join("\n"));
    console.error(`\n[voice-tuning] wrote ${path.relative(REPO_ROOT, path.resolve(out))}`);
    return 0;
  }

  // The provider honours it, and a mock's numbers would pass for OpenAI's.
  if (process.env.DAINTREE_REALTIME_WS_URL) {
    console.error(
      "[voice-tuning] DAINTREE_REALTIME_WS_URL is set: unset it to measure the real provider"
    );
    return 1;
  }
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("[voice-tuning] OPENAI_API_KEY is not set");
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
        `[voice-tuning] ${prepared.wavPath} is ${pcm.sampleRate} Hz; the provider takes ${REPLAY_SAMPLE_RATE} Hz`
      );
      return 1;
    }
    samples.set(prepared.clip.id, pcm.samples);
  }
  const arms = options.arms;
  const audioMinutes =
    (clips.reduce((n, clip) => n + clip.audioMs, 0) * options.repeats * arms.length) / 60_000;
  console.error(
    `[voice-tuning] ${clips.length * options.repeats * arms.length} sessions, ${audioMinutes.toFixed(1)} min of audio, about $${(audioMinutes * LIVE_TRANSCRIBE_USD_PER_MINUTE).toFixed(2)}`
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
    schemaVersion: VOICE_TUNING_SCHEMA_VERSION,
    scoringVersion: VOICE_TUNING_SCORING_VERSION,
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
    arms: arms.map((arm) => ({ id: arm.id, tuning: { ...arm.tuning } })),
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
      console.error(`\n[voice-tuning] interrupted; kept ${run.sessions.length} sessions`);
      process.exit(130);
    }
    interrupted = true;
    console.error(
      "\n[voice-tuning] stopping after the session in flight (Ctrl+C again to quit now)"
    );
  });

  // Passes outermost, so a run cut short has every clip it reached equally
  // often. Every arm plays a clip back to back, so a slow minute on the
  // network lands on all of them, in an order shuffled per clip.
  let stopped = false;
  let clipIndex = 0;
  for (let pass = 1; pass <= options.repeats && !interrupted && !stopped; pass++) {
    for (const prepared of seededShuffle(clips, options.seed + pass)) {
      clipIndex++;
      for (const arm of seededShuffle(arms, options.seed * 31 + clipIndex)) {
        if (interrupted || stopped) break;
        const observation = await dictate(host, prepared, samples.get(prepared.clip.id)!, {
          pass,
          name: `voice-tuning-${pass}-${arm.id}-${prepared.clip.id}`,
          settings,
          tuning: arm.tuning,
        });
        const session: TuningSession = { ...observation, arm: arm.id };
        run.sessions.push(session);
        save();
        const scored = scoreTuningSession(session, prepared.clip.reference, prepared.clip.terms);
        console.error(
          `[voice-tuning] pass ${pass} · ${prepared.clip.id} · ${arm.id}: ${isExcluded(scored) ? `excluded (${scored.reasons.join(", ")})` : `${scored.score.substitutions + scored.score.deletions + scored.score.insertions} edits, ${scored.segments} segment(s)`}`
        );
        // A VAD still running would share the next session's CPU and timing.
        if (session.vad.leftRunning) {
          console.error(`[voice-tuning] a VAD process outlived its session; stopping`);
          stopped = true;
        }
      }
    }
  }

  run.complete = !interrupted && !stopped;
  run.finishedAt = new Date().toISOString();
  const markdownPath = jsonPath.replace(/\.json$/, ".md");
  run.summary = writeReport(run, markdownPath);
  save();
  console.log(renderTuningTable(run.summary).join("\n"));
  console.error(
    `\n[voice-tuning] wrote ${path.relative(REPO_ROOT, jsonPath)} and .md (both quote transcripts; keep them in .tmp/)`
  );
  return interrupted ? 130 : stopped ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[voice-tuning] fatal:", error);
    process.exit(1);
  }
);
