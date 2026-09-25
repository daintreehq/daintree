import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SAFE_ID_PATTERN, TourContributionSchema } from "../../../../electron/schemas/plugin.js";
import {
  estimateTiming,
  narrationFingerprint,
  parseNarration,
  type ParsedNarration,
} from "../../../tour/src/tourNarration.js";
import { encodeOggOpus, oggOpusDuration } from "../tour/audio.js";
import {
  DEFAULT_STT_MODEL,
  DEFAULT_TTS_VOICE,
  inworldKeyFromEnv,
  synthesizeSpeech,
  transcribeSpeech,
} from "../tour/inworld.js";
import { roundTiming, timeChapter } from "../tour/timing.js";

const RECORDING_EXTENSIONS = [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac"];

interface TourCommonOptions {
  /** Plugin project directory (default: cwd). */
  dir?: string;
  /** Which `contributes.tours` entry; optional when the plugin declares one tour. */
  tour?: string;
  /** Narration file (default: `tours/<tourId>.narration.json`). */
  narration?: string;
  /** Only these chapter ids. */
  only?: string[];
  /** Inworld credential; defaults to `INWORLD_API_KEY`. */
  apiKey?: string;
  /** Progress lines, one per chapter. */
  log?: (line: string) => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export interface TourVoiceOptions extends TourCommonOptions {
  /** Inworld voice id (default: Simon). */
  voice?: string;
  model?: string;
  /** Re-voice every chapter, even ones whose narration is unchanged. */
  force?: boolean;
}

export interface TourAlignOptions extends TourCommonOptions {
  /** Folder holding `<chapter-id>.{wav,mp3,m4a,ogg,flac,aac}` recordings. */
  recordings: string;
  sttModel?: string;
}

export type TourChapterOutcome =
  "voiced" | "aligned" | "up-to-date" | "no-recording" | "not-selected";

export interface TourChapterReport {
  id: string;
  outcome: TourChapterOutcome;
  /** Timing no longer matches the narration and nothing replaced it on this run. */
  stale: boolean;
  /** No timing existed, so the chapter carries an estimate and no audio. */
  estimated: boolean;
  matched?: number;
  total?: number;
  audioPath?: string;
}

export interface TourCommandResult {
  tourId: string;
  manifestPath: string;
  narrationPath: string;
  chapters: TourChapterReport[];
}

interface NarrationChapter {
  id: string;
  narration: string;
  parsed: ParsedNarration;
  hash: string;
}

type ChapterEntry = Record<string, unknown> & { id: string };

interface TourContext {
  dir: string;
  manifestPath: string;
  narrationPath: string;
  indent: string;
  manifest: Record<string, unknown>;
  tour: Record<string, unknown> & { id: string };
  chapters: NarrationChapter[];
  /** Current timing entries by chapter id, updated as chapters are produced. */
  entries: Map<string, ChapterEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadTour(opts: TourCommonOptions): Promise<TourContext> {
  const dir = path.resolve(opts.dir ?? process.cwd());
  const manifestPath = path.join(dir, "plugin.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`Couldn't read plugin.json at ${manifestPath}`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error("plugin.json is not valid JSON");
  }
  if (!isRecord(manifest)) throw new Error("plugin.json must be a JSON object");

  const tours = isRecord(manifest.contributes) ? manifest.contributes.tours : undefined;
  const declared = Array.isArray(tours)
    ? tours.filter((t): t is Record<string, unknown> & { id: string } => {
        return isRecord(t) && typeof t.id === "string";
      })
    : [];
  if (declared.length === 0) {
    throw new Error(
      "plugin.json declares no contributes.tours entry; add one (id, title, componentPath) first"
    );
  }
  let tour: (typeof declared)[number] | undefined;
  if (opts.tour) {
    tour = declared.find((t) => t.id === opts.tour);
    if (!tour) {
      throw new Error(
        `No tour "${opts.tour}" in plugin.json; declared: ${declared.map((t) => t.id).join(", ")}`
      );
    }
  } else if (declared.length === 1) {
    tour = declared[0];
  } else {
    throw new Error(
      `plugin.json declares several tours; pick one with --tour (${declared.map((t) => t.id).join(", ")})`
    );
  }
  tour = tour!;

  const narrationPath = path.resolve(dir, opts.narration ?? `tours/${tour.id}.narration.json`);
  const chapters = await loadNarration(narrationPath);

  const entries = new Map<string, ChapterEntry>();
  if (Array.isArray(tour.chapters)) {
    for (const entry of tour.chapters) {
      if (isRecord(entry) && typeof entry.id === "string") {
        entries.set(entry.id, entry as ChapterEntry);
      }
    }
  }

  if (opts.only) {
    const known = new Set(chapters.map((c) => c.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`--only names no chapter in ${narrationPath}: ${unknown.join(", ")}`);
    }
  }

  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? "  ";
  return { dir, manifestPath, narrationPath, indent, manifest, tour, chapters, entries };
}

async function loadNarration(file: string): Promise<NarrationChapter[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(
      `Couldn't read narration at ${file}; write { "chapters": [{ "id": "…", "narration": "…" }] } there or pass --narration`
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const list = isRecord(json) ? json.chapters : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${file} must have a non-empty "chapters" array`);
  }
  const seen = new Set<string>();
  return list.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.narration !== "string") {
      throw new Error(`${file}: chapters[${index}] needs a string "id" and "narration"`);
    }
    const { id, narration } = item;
    if (!SAFE_ID_PATTERN.test(id) || id.length > 64) {
      throw new Error(`${file}: chapter id "${id}" must match ${SAFE_ID_PATTERN}`);
    }
    if (seen.has(id)) throw new Error(`${file}: duplicate chapter id "${id}"`);
    seen.add(id);
    let parsed: ParsedNarration;
    try {
      parsed = parseNarration(narration);
    } catch (error) {
      throw new Error(`${file}: chapter "${id}": ${(error as Error).message}`);
    }
    if (parsed.words.length === 0) throw new Error(`${file}: chapter "${id}" has no words`);
    return { id, narration, parsed, hash: narrationFingerprint(parsed) };
  });
}

/**
 * Rebuild the tour's chapters in narration order and write plugin.json. A
 * chapter with no timing yet gets an estimate and no audio so the manifest
 * stays loadable; chapters the narration no longer lists are dropped. The tour
 * is checked against the host's own schema first, so a run never leaves a
 * manifest the host would refuse.
 */
async function save(ctx: TourContext): Promise<void> {
  ctx.tour.chapters = ctx.chapters.map((chapter) => {
    const entry = ctx.entries.get(chapter.id);
    if (entry) return entry;
    return {
      id: chapter.id,
      ...roundTiming(estimateTiming(chapter.narration)),
      narrationHash: chapter.hash,
    };
  });
  const checked = TourContributionSchema.safeParse(ctx.tour);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => `${issue.path.join(".") || "(tour)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`The tour's timing would not validate; plugin.json not written:\n${issues}`);
  }
  await fs.writeFile(ctx.manifestPath, `${JSON.stringify(ctx.manifest, null, ctx.indent)}\n`);
}

function record(ctx: TourContext, chapter: NarrationChapter, timing: object, audioPath: string) {
  ctx.entries.set(chapter.id, {
    id: chapter.id,
    ...roundTiming(timing),
    audioUrl: audioPath,
    narrationHash: chapter.hash,
  });
}

function report(
  ctx: TourContext,
  chapter: NarrationChapter,
  outcome: TourChapterOutcome,
  extra: Partial<TourChapterReport> = {}
): TourChapterReport {
  const entry = ctx.entries.get(chapter.id);
  return {
    id: chapter.id,
    outcome,
    stale: entry !== undefined && entry.narrationHash !== chapter.hash,
    estimated: entry === undefined,
    ...extra,
  };
}

function audioPathFor(tourId: string, chapterId: string, variant: string): string {
  return `tours/${tourId}/${chapterId}.${variant}.ogg`;
}

/** Filename-safe spelling of a voice id, so each voice's audio has its own path. */
function voiceSlug(voice: string): string {
  const slug = voice
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Voice "${voice}" has no usable letters or digits`);
  return slug;
}

/**
 * Voice each chapter's narration with Inworld TTS, write the Ogg Opus audio
 * into the plugin, and time every cue from the voice's own word timestamps.
 * A chapter is skipped when its timing was already made from this narration,
 * in this voice, and its audio is still on disk.
 */
export async function runTourVoice(opts: TourVoiceOptions = {}): Promise<TourCommandResult> {
  const ctx = await loadTour(opts);
  const voice = opts.voice ?? DEFAULT_TTS_VOICE;
  const slug = voiceSlug(voice);
  let apiKey = opts.apiKey;
  const log = opts.log ?? (() => {});
  const reports: TourChapterReport[] = [];

  for (const chapter of ctx.chapters) {
    if (opts.only && !opts.only.includes(chapter.id)) {
      reports.push(report(ctx, chapter, "not-selected"));
      continue;
    }
    const audioPath = audioPathFor(ctx.tour.id, chapter.id, slug);
    const existing = ctx.entries.get(chapter.id);
    const upToDate =
      existing?.narrationHash === chapter.hash &&
      existing.audioUrl === audioPath &&
      existsSync(path.join(ctx.dir, audioPath));
    if (upToDate && !opts.force) {
      log(`· ${chapter.id}: up to date`);
      reports.push(report(ctx, chapter, "up-to-date", { audioPath }));
      continue;
    }

    apiKey ??= inworldKeyFromEnv();
    log(`→ ${chapter.id}: voicing with ${voice}`);
    const { audio, alignment } = await synthesizeSpeech({
      apiKey,
      fetch: opts.fetch,
      text: chapter.parsed.spoken,
      voice,
      model: opts.model,
    });
    const { timing, matched, total } = timeChapter(
      chapter.id,
      chapter.parsed,
      alignment,
      oggOpusDuration(audio),
      audioPath
    );
    const target = path.join(ctx.dir, audioPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, audio);
    record(ctx, chapter, timing, audioPath);
    await save(ctx);
    reports.push(report(ctx, chapter, "voiced", { matched, total, audioPath }));
  }

  await save(ctx);
  return {
    tourId: ctx.tour.id,
    manifestPath: ctx.manifestPath,
    narrationPath: ctx.narrationPath,
    chapters: reports,
  };
}

async function findRecording(dir: string, chapterId: string): Promise<string | null> {
  const names = await fs.readdir(dir);
  const match = names.find((name) => {
    const ext = path.extname(name).toLowerCase();
    return (
      RECORDING_EXTENSIONS.includes(ext) && path.basename(name, path.extname(name)) === chapterId
    );
  });
  return match ? path.join(dir, match) : null;
}

/**
 * Time the author's own recordings: each `<chapter-id>.<ext>` in `recordings`
 * is encoded to mono Ogg Opus inside the plugin, transcribed with word
 * timestamps by Inworld STT, and aligned back to the narration's cue markers.
 * Every chapter with a recording is re-timed, since a new take of the same
 * words is still a new take; chapters without one keep their timing.
 */
export async function runTourAlign(opts: TourAlignOptions): Promise<TourCommandResult> {
  const recordings = path.resolve(opts.recordings);
  let isDir = false;
  try {
    isDir = (await fs.stat(recordings)).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`Recordings folder not found: ${recordings}`);

  const ctx = await loadTour(opts);
  let apiKey = opts.apiKey;
  const log = opts.log ?? (() => {});
  const reports: TourChapterReport[] = [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-align-"));
  try {
    for (const chapter of ctx.chapters) {
      if (opts.only && !opts.only.includes(chapter.id)) {
        reports.push(report(ctx, chapter, "not-selected"));
        continue;
      }
      const recording = await findRecording(recordings, chapter.id);
      if (!recording) {
        log(`! ${chapter.id}: no recording found, keeping previous timing`);
        reports.push(report(ctx, chapter, "no-recording"));
        continue;
      }

      apiKey ??= inworldKeyFromEnv();
      log(`→ ${chapter.id}: transcribing ${path.basename(recording)}`);
      const audioPath = audioPathFor(ctx.tour.id, chapter.id, "recorded");
      // Encoded outside the plugin, so a take that fails to align never
      // replaces the audio the current timing was made from.
      const encoded = path.join(workDir, `${chapter.id}.ogg`);
      await encodeOggOpus(recording, encoded);
      const audio = await fs.readFile(encoded);
      const alignment = await transcribeSpeech({
        apiKey,
        fetch: opts.fetch,
        audio,
        model: opts.sttModel ?? DEFAULT_STT_MODEL,
      });
      const { timing, matched, total } = timeChapter(
        chapter.id,
        chapter.parsed,
        alignment,
        oggOpusDuration(audio),
        audioPath
      );
      const target = path.join(ctx.dir, audioPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(encoded, target);
      record(ctx, chapter, timing, audioPath);
      await save(ctx);
      reports.push(report(ctx, chapter, "aligned", { matched, total, audioPath }));
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }

  await save(ctx);
  return {
    tourId: ctx.tour.id,
    manifestPath: ctx.manifestPath,
    narrationPath: ctx.narrationPath,
    chapters: reports,
  };
}
