/**
 * Voices the Daintree Tour and publishes the narration to the CDN.
 *
 *   npm run tour:audio                          # Inworld TTS for stale chapters
 *   npm run tour:audio -- --force               # re-voice every chapter
 *   npm run tour:audio -- --recordings <dir>    # use your own recordings
 *   npm run tour:audio -- --no-upload           # dry run: timings only, nothing published
 *
 * Audio never lands in the repo. Each chapter is encoded to Ogg Opus in a temp
 * dir, uploaded to R2 under a content-hashed key (immutable caching is then
 * safe), and only the timing manifest — cue times, captions, the audio URL —
 * is written back to `src/components/Tour/tourTiming.generated.ts`.
 *
 * Recordings mode: drop `<chapter-id>.{wav,mp3,m4a,ogg,flac}` files in a
 * folder (ids are in tourChapters.ts). Read the narration text as written.
 * Word timestamps come from OpenAI transcription, so every scene cue lands on
 * the word you actually spoke — no hand-timing.
 *
 * Env: INWORLD_API_KEY (TTS), OPENAI_API_KEY (recordings), CLOUDFLARE_API_TOKEN
 * (upload, via wrangler; CLOUDFLARE_ACCOUNT_ID if the token spans accounts).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { TOUR_CHAPTERS } from "../../src/components/Tour/tourChapters";
import {
  alignWordStarts,
  buildTiming,
  narrationFingerprint,
  parseNarration,
  type WordAlignment,
} from "../../src/components/Tour/tourNarration";
import { TOUR_TIMING_MANIFEST } from "../../src/components/Tour/tourTiming.generated";
import type { TourTimingManifest } from "../../src/components/Tour/tourTypes";

const INWORLD_VOICE = "Simon";
const INWORLD_MODEL = "inworld-tts-2";
const BUCKET = "daintree-assets";
const CDN_ORIGIN = "https://cdn.daintree.org";
const MANIFEST_PATH = resolve(
  import.meta.dirname,
  "../../src/components/Tour/tourTiming.generated.ts"
);
const TAIL_SECONDS = 0.6;
/** Below this share of words pinned to real speech, the cues can't be trusted. */
const MIN_ALIGNED_SHARE = 0.6;

interface Args {
  force: boolean;
  upload: boolean;
  recordings: string | null;
  only: string[] | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, upload: true, recordings: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--no-upload") args.upload = false;
    else if (arg === "--recordings") args.recordings = resolve(argv[++i] ?? "");
    else if (arg === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function synthesize(text: string): Promise<{ audio: Buffer; alignment: WordAlignment }> {
  const response = await fetch("https://api.inworld.ai/tts/v1/voice", {
    method: "POST",
    headers: {
      Authorization: `Basic ${requireEnv("INWORLD_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voiceId: INWORLD_VOICE,
      modelId: INWORLD_MODEL,
      audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 48000 },
      timestampType: "WORD",
    }),
  });
  if (!response.ok) {
    throw new Error(`Inworld TTS failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    audioContent: string;
    timestampInfo?: { wordAlignment?: WordAlignment };
  };
  const alignment = body.timestampInfo?.wordAlignment;
  if (!alignment) throw new Error("Inworld response carried no word alignment");
  return { audio: Buffer.from(body.audioContent, "base64"), alignment };
}

async function transcribeWords(file: string): Promise<WordAlignment> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Transcription failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as {
    words?: { word: string; start: number; end: number }[];
  };
  const words = body.words ?? [];
  return {
    words: words.map((w) => w.word),
    wordStartTimeSeconds: words.map((w) => w.start),
    wordEndTimeSeconds: words.map((w) => w.end),
  };
}

function toOggOpus(input: string, workDir: string): string {
  const out = join(workDir, `${basename(input, extname(input))}.encoded.ogg`);
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", input, "-ac", "1", "-c:a", "libopus", "-b:a", "48k", out],
    { stdio: "inherit" }
  );
  return out;
}

function probeDuration(file: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" }
  );
  const duration = Number.parseFloat(out.trim());
  if (!Number.isFinite(duration)) throw new Error(`Could not read duration of ${file}`);
  return duration;
}

function findRecording(dir: string, chapterId: string): string | null {
  const match = readdirSync(dir).find(
    (name) =>
      basename(name, extname(name)) === chapterId && /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(name)
  );
  return match ? join(dir, match) : null;
}

function upload(file: string, key: string): void {
  execFileSync(
    "wrangler",
    [
      "r2",
      "object",
      "put",
      `${BUCKET}/${key}`,
      "--file",
      file,
      "--content-type",
      "audio/ogg",
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--remote",
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
}

function writeManifest(manifest: TourTimingManifest): void {
  // Millisecond precision is finer than any cue needs; it keeps float noise
  // (20.486500000000003) out of the diff.
  const json = JSON.stringify(
    manifest,
    (_key, value: unknown) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value),
    2
  );
  const source = `// Generated by \`npm run tour:audio\` — do not edit by hand.
import type { TourTimingManifest } from "./tourTypes";

export const TOUR_TIMING_MANIFEST: TourTimingManifest = ${json};
`;
  writeFileSync(MANIFEST_PATH, source);
  execFileSync("npx", ["prettier", "--write", MANIFEST_PATH], { stdio: "ignore" });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.recordings && !existsSync(args.recordings)) {
    throw new Error(`Recordings folder not found: ${args.recordings}`);
  }
  if (args.upload) requireEnv("CLOUDFLARE_API_TOKEN");

  const voice = args.recordings ? "recorded" : `inworld-${INWORLD_VOICE.toLowerCase()}`;
  const workDir = mkdtempSync(join(tmpdir(), "daintree-tour-"));
  const manifest: TourTimingManifest = {
    version: 1,
    voice,
    chapters: { ...TOUR_TIMING_MANIFEST.chapters },
  };

  for (const chapter of TOUR_CHAPTERS) {
    if (args.only && !args.only.includes(chapter.id)) continue;
    const parsed = parseNarration(chapter.narration);
    const narrationHash = narrationFingerprint(parsed);
    const existing = manifest.chapters[chapter.id];
    const sameVoice = TOUR_TIMING_MANIFEST.voice === voice;
    // A dry run records timing without a URL; a publishing run must not take
    // that entry as done, or the chapter would ship silent.
    const published = !args.upload || Boolean(existing?.audioUrl);
    const upToDate = sameVoice && existing?.narrationHash === narrationHash && published;
    if (!args.force && !args.recordings && upToDate) {
      console.log(`· ${chapter.id}: up to date`);
      continue;
    }

    let encoded: string;
    let alignment: WordAlignment;
    if (args.recordings) {
      const recording = findRecording(args.recordings, chapter.id);
      if (!recording) {
        console.warn(`! ${chapter.id}: no recording found, keeping previous timing`);
        continue;
      }
      console.log(`→ ${chapter.id}: transcribing ${basename(recording)}`);
      alignment = await transcribeWords(recording);
      encoded = toOggOpus(recording, workDir);
    } else {
      console.log(`→ ${chapter.id}: voicing with ${INWORLD_VOICE}`);
      const result = await synthesize(parsed.text);
      const raw = join(workDir, `${chapter.id}.tts.ogg`);
      writeFileSync(raw, result.audio);
      alignment = result.alignment;
      encoded = raw;
    }

    const audioBytes = readFileSync(encoded);
    const contentHash = createHash("sha256").update(audioBytes).digest("hex").slice(0, 12);
    const key = `tour/${voice}/${chapter.id}-${contentHash}.ogg`;
    const duration = probeDuration(encoded) + TAIL_SECONDS;
    const { starts, matched } = alignWordStarts(parsed.words, alignment);
    const share = matched / parsed.words.length;
    if (alignment.words.length === 0 || share < MIN_ALIGNED_SHARE) {
      throw new Error(
        `${chapter.id}: only ${matched}/${parsed.words.length} words lined up with the audio — ` +
          "check the recording reads the narration as written. Nothing was published for it."
      );
    }
    if (matched < parsed.words.length) {
      console.log(`  ${matched}/${parsed.words.length} words matched; the rest are interpolated`);
    }
    const url = `${CDN_ORIGIN}/${key}`;

    if (args.upload) {
      upload(encoded, key);
      console.log(`  uploaded ${url}`);
    }
    manifest.chapters[chapter.id] = {
      ...buildTiming(parsed, starts, duration, args.upload ? url : null),
      narrationHash,
    };
  }

  for (const id of Object.keys(manifest.chapters)) {
    if (!TOUR_CHAPTERS.some((chapter) => chapter.id === id)) delete manifest.chapters[id];
  }
  writeManifest(manifest);
  console.log(`Wrote ${MANIFEST_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
