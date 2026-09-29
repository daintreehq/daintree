/**
 * Voices the Daintree Tour and publishes the narration to the CDN.
 *
 *   npm run tour:audio                          # Inworld TTS for stale chapters
 *   npm run tour:audio -- --force               # re-voice every chapter
 *   npm run tour:audio -- --recordings <dir>    # use your own recordings
 *   npm run tour:audio -- --recordings <dir> --stt-model groq/whisper-large-v3
 *   npm run tour:audio -- --no-upload           # dry run: timings only, nothing published
 *
 * Audio never lands in the repo. Each chapter is encoded to Ogg Opus in a temp
 * dir, uploaded to R2 under a content-hashed key (immutable caching is then
 * safe), and only the timing manifest — cue times, captions, the audio URL —
 * is written back to `src/components/Tour/tourTiming.generated.ts`.
 *
 * Recordings mode: drop `<chapter-id>.{wav,mp3,m4a,ogg,flac}` files in a
 * folder (ids are in tourChapters.ts). A chapter that names a shortcut takes
 * one file per keyboard, `<chapter-id>.mac` and `<chapter-id>.pc`, each read
 * with that keyboard's key names. Read the narration text as written.
 * Word timestamps come from Inworld speech-to-text, so every scene cue lands
 * on the word you actually spoke — no hand-timing.
 *
 * The Inworld calls, encoding, duration and alignment are the plugin CLI's own
 * (`daintree-plugin tour voice|align`); only the chapters, the keyboard variants
 * and publishing to R2 are ours.
 *
 * Env: INWORLD_API_KEY (TTS and STT), CLOUDFLARE_API_TOKEN
 * (upload, via wrangler; CLOUDFLARE_ACCOUNT_ID if the token spans accounts).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  narrationFingerprint,
  parseNarration,
  tourMinutes,
  type TourTimingManifest,
  type WordAlignment,
} from "@daintreehq/tour";
import { encodeOggOpus, oggOpusDuration } from "../../packages/daintree-plugin/src/tour/audio";
import {
  DEFAULT_STT_MODEL,
  inworldKeyFromEnv,
  synthesizeSpeech,
  transcribeSpeech,
} from "../../packages/daintree-plugin/src/tour/inworld";
import { timeChapter } from "../../packages/daintree-plugin/src/tour/timing";
import { TOUR_CHAPTERS } from "../../src/components/Tour/tourChapters";
import { narrationVariants, TOUR_KEYBOARDS } from "../../src/components/Tour/tourKeys";
import { resolveTourTimings } from "../../src/components/Tour/tourTiming";
import { TOUR_TIMING_MANIFEST } from "../../src/components/Tour/tourTiming.generated";

// Inworld's "Simon" — articulate and steady, made for technical tutorials —
// read plainly, the way the tour was first voiced. The slug names its CDN
// folder and also marks chapters as current, so it changes with the voice.
const INWORLD_VOICE = "Simon";
const INWORLD_VOICE_SLUG = "simon";
const BUCKET = "daintree-assets";
const CDN_ORIGIN = "https://cdn.daintree.org";
const MANIFEST_PATH = resolve(
  import.meta.dirname,
  "../../src/components/Tour/tourTiming.generated.ts"
);
const SUMMARY_PATH = resolve(
  import.meta.dirname,
  "../../src/components/Tour/tourSummary.generated.ts"
);

interface Args {
  force: boolean;
  upload: boolean;
  recordings: string | null;
  only: string[] | null;
  sttModel: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    force: false,
    upload: true,
    recordings: null,
    only: null,
    sttModel: DEFAULT_STT_MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--no-upload") args.upload = false;
    else if (arg === "--recordings") args.recordings = resolve(argv[++i] ?? "");
    else if (arg === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--stt-model") args.sttModel = argv[++i] ?? DEFAULT_STT_MODEL;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function findRecording(dir: string, key: string): string | null {
  const match = readdirSync(dir).find(
    (name) => basename(name, extname(name)) === key && /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(name)
  );
  return match ? join(dir, match) : null;
}

/**
 * Publish once, never replace: shipped builds pin these URLs forever. Keys are
 * content-hashed, so an object already at the key normally holds these exact
 * bytes and the upload is skipped; different bytes mean a hash collision, and
 * the run stops rather than overwrite audio an older build plays.
 */
async function upload(file: string, key: string, url: string): Promise<void> {
  const current = await fetch(url);
  if (current.ok) {
    const bytes = Buffer.from(await current.arrayBuffer());
    if (!bytes.equals(readFileSync(file))) {
      throw new Error(`${url} already holds different audio; refusing to overwrite it.`);
    }
    console.log(`  already published ${url}`);
    return;
  }
  if (current.status !== 404) {
    throw new Error(`Could not check ${url} before uploading (${current.status}).`);
  }
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
  console.log(`  uploaded ${url}`);
}

/** HEAD with a few retries, so a network blip or edge propagation doesn't fail the run. */
async function headStatus(url: string): Promise<number | string> {
  let last: number | string = "unreachable";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.status === 200) return 200;
      last = response.status;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  return last;
}

/**
 * Every shipped build compiles in its own manifest and plays exactly the URLs
 * it names, so a manifest must never point at audio that isn't there. Checked
 * against the CDN itself, not the bucket, because that is what the app fetches.
 */
async function assertPublished(
  manifest: TourTimingManifest,
  expectedKeys: ReadonlySet<string>
): Promise<void> {
  const missing: string[] = [];
  for (const key of expectedKeys) {
    const url = manifest.chapters[key]?.audioUrl;
    if (!url) {
      missing.push(`${key}: no audio (a missing recording, or never voiced)`);
      continue;
    }
    const status = await headStatus(url);
    if (status !== 200) missing.push(`${key}: ${status} ${url}`);
  }
  if (missing.length > 0) {
    throw new Error(`Audio missing from the CDN; manifest not written:\n${missing.join("\n")}`);
  }
}

/** Writes the manifest and returns it as written, at the precision the app reads. */
function writeManifest(manifest: TourTimingManifest): TourTimingManifest {
  // Millisecond precision is finer than any cue needs; it keeps float noise
  // (20.486500000000003) out of the diff.
  const json = JSON.stringify(
    manifest,
    (_key, value: unknown) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value),
    2
  );
  const source = `// Generated by \`npm run tour:audio\` — do not edit by hand.
import type { TourTimingManifest } from "@daintreehq/tour";

export const TOUR_TIMING_MANIFEST: TourTimingManifest = ${json};
`;
  writeFileSync(MANIFEST_PATH, source);
  execFileSync("npx", ["prettier", "--write", MANIFEST_PATH], { stdio: "ignore" });
  return JSON.parse(json) as TourTimingManifest;
}

/**
 * What the invitation shows at startup, split out so the card never imports
 * the narration, the manifest or the parser just to quote a length.
 */
function writeSummary(manifest: TourTimingManifest): void {
  // One card for every platform, so it quotes the longer keyboard's cut.
  const minutes = Math.max(
    ...TOUR_KEYBOARDS.map((keyboard) =>
      tourMinutes(resolveTourTimings(keyboard, TOUR_CHAPTERS, manifest))
    )
  );
  const titles = JSON.stringify(
    TOUR_CHAPTERS.map((chapter) => chapter.title),
    null,
    2
  );
  const source = `// Generated by \`npm run tour:audio\` — do not edit by hand.

/** The tour's length in whole minutes, from the same timings the player uses. */
export const TOUR_MINUTES = ${minutes};

/** Chapter titles in play order. */
export const TOUR_CHAPTER_TITLES: readonly string[] = ${titles};
`;
  writeFileSync(SUMMARY_PATH, source);
  execFileSync("npx", ["prettier", "--write", SUMMARY_PATH], { stdio: "ignore" });
}

async function voiceVariant(
  args: Args,
  manifest: TourTimingManifest,
  key: string,
  narration: string,
  voice: string,
  workDir: string
): Promise<void> {
  const parsed = parseNarration(narration);
  const narrationHash = narrationFingerprint(parsed);
  const existing = manifest.chapters[key];
  // Per entry: a partial run (--only) must not vouch for chapters it never touched.
  const sameVoice = (existing?.voice ?? TOUR_TIMING_MANIFEST.voice) === voice;
  // A dry run records timing without a URL; a publishing run must not take
  // that entry as done, or the chapter would ship silent.
  const published = !args.upload || Boolean(existing?.audioUrl);
  const upToDate = sameVoice && existing?.narrationHash === narrationHash && published;
  if (!args.force && !args.recordings && upToDate) {
    console.log(`· ${key}: up to date`);
    return;
  }

  let encoded: string;
  let alignment: WordAlignment;
  if (args.recordings) {
    const recording = findRecording(args.recordings, key);
    if (!recording) {
      console.warn(`! ${key}: no recording found, keeping previous timing`);
      return;
    }
    console.log(`→ ${key}: transcribing ${basename(recording)}`);
    encoded = join(workDir, `${basename(recording, extname(recording))}.encoded.ogg`);
    await encodeOggOpus(recording, encoded);
    alignment = await transcribeSpeech({
      apiKey: inworldKeyFromEnv(),
      audio: readFileSync(encoded),
      model: args.sttModel,
    });
  } else {
    console.log(`→ ${key}: voicing with ${INWORLD_VOICE_SLUG}`);
    const result = await synthesizeSpeech({
      apiKey: inworldKeyFromEnv(),
      text: parsed.spoken,
      voice: INWORLD_VOICE,
    });
    encoded = join(workDir, `${key}.tts.ogg`);
    writeFileSync(encoded, result.audio);
    alignment = result.alignment;
  }

  const audioBytes = readFileSync(encoded);
  const contentHash = createHash("sha256").update(audioBytes).digest("hex").slice(0, 12);
  const objectKey = `tour/${voice}/${key}-${contentHash}.ogg`;
  const url = `${CDN_ORIGIN}/${objectKey}`;
  const { timing, matched, total } = timeChapter(
    key,
    parsed,
    alignment,
    oggOpusDuration(audioBytes),
    args.upload ? url : null
  );
  if (matched < total) {
    console.log(`  ${matched}/${total} words matched; the rest are interpolated`);
  }

  if (args.upload) await upload(encoded, objectKey, url);
  manifest.chapters[key] = { ...timing, narrationHash, voice };
}

/**
 * When a chapter gains a shortcut (one entry becomes `.mac`/`.pc`) or loses its
 * last one (the reverse), an old entry that already voices a new key's exact
 * text moves to that key, so unchanged audio is never re-voiced. Runs across
 * every chapter before `--only` filters anything, so a partial run can't drop
 * a sibling's reusable entry when the old key is pruned.
 */
function migrateEntries(manifest: TourTimingManifest): void {
  for (const chapter of TOUR_CHAPTERS) {
    const variants = narrationVariants(chapter);
    const predecessors = [chapter.id, ...TOUR_KEYBOARDS.map((k) => `${chapter.id}.${k}`)];
    for (const variant of variants) {
      if (manifest.chapters[variant.key]) continue;
      const hash = narrationFingerprint(parseNarration(variant.narration));
      const match = predecessors
        .map((key) => manifest.chapters[key])
        .find((entry) => entry?.narrationHash === hash);
      if (match) manifest.chapters[variant.key] = match;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.recordings && !existsSync(args.recordings)) {
    throw new Error(`Recordings folder not found: ${args.recordings}`);
  }
  if (args.upload) requireEnv("CLOUDFLARE_API_TOKEN");

  const voice = args.recordings ? "recorded" : `inworld-${INWORLD_VOICE_SLUG}`;
  const workDir = mkdtempSync(join(tmpdir(), "daintree-tour-"));
  const manifest: TourTimingManifest = {
    version: 1,
    voice,
    chapters: { ...TOUR_TIMING_MANIFEST.chapters },
  };

  const validKeys = new Set(
    TOUR_CHAPTERS.flatMap((chapter) => narrationVariants(chapter).map((variant) => variant.key))
  );
  const unknown = (args.only ?? []).filter(
    (id) => !validKeys.has(id) && !TOUR_CHAPTERS.some((chapter) => chapter.id === id)
  );
  if (unknown.length > 0)
    throw new Error(`--only names no chapter or variant: ${unknown.join(", ")}`);
  migrateEntries(manifest);

  for (const chapter of TOUR_CHAPTERS) {
    for (const variant of narrationVariants(chapter)) {
      if (args.only && !args.only.includes(chapter.id) && !args.only.includes(variant.key)) {
        continue;
      }
      await voiceVariant(args, manifest, variant.key, variant.narration, voice, workDir);
    }
  }

  for (const key of Object.keys(manifest.chapters)) {
    if (!validKeys.has(key)) delete manifest.chapters[key];
  }
  if (args.upload) await assertPublished(manifest, validKeys);
  writeSummary(writeManifest(manifest));
  console.log(`Wrote ${MANIFEST_PATH} and ${SUMMARY_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
