import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SAFE_ID_PATTERN,
  TourChapterSchema,
  TourContributionSchema,
} from "../../../../electron/schemas/plugin.js";
import {
  narrationFingerprint,
  parseNarration,
  type ParsedNarration,
} from "../../../tour/src/tourNarration.js";
import type { TourChapterTiming } from "../../../tour/src/tourTypes.js";
import { encodeOggOpus, oggOpusDuration } from "../tour/audio.js";
import {
  DEFAULT_STT_MODEL,
  DEFAULT_TTS_MODEL,
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
  /** Inworld TTS model id (default: inworld-tts-2). */
  model?: string;
  /** Re-voice every chapter, even ones whose narration is unchanged. */
  force?: boolean;
}

export interface TourAlignOptions extends TourCommonOptions {
  /** Folder holding `<chapter-id>.{wav,mp3,m4a,ogg,flac,aac}` recordings. */
  recordings: string;
  /** An Inworld-routed STT model that returns word timestamps. */
  sttModel?: string;
}

export type TourChapterOutcome =
  "voiced" | "aligned" | "up-to-date" | "no-recording" | "not-selected";

export interface TourChapterReport {
  id: string;
  outcome: TourChapterOutcome;
  /** Timing no longer matches the narration and nothing replaced it on this run. */
  stale: boolean;
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
  /** plugin.json as last read or written, so an unchanged manifest is never rewritten. */
  written: string;
  /** Audio this run replaced; deleted once no written manifest references it. */
  superseded: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tour and chapter ids become file and folder names, so on top of the
 * manifest's id grammar they must not be `.`/`..` or hidden, and must not
 * collide on a case-insensitive filesystem.
 */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ? ` (${code})` : "";
}

function checkPathId(kind: string, id: string): void {
  if (!SAFE_ID_PATTERN.test(id) || id.length > 64 || id.startsWith(".")) {
    throw new Error(
      `${kind} id "${id}" must be 1–64 letters, digits, ".", "_" or "-", not starting with "."`
    );
  }
}

async function loadTour(opts: TourCommonOptions): Promise<TourContext> {
  const dir = path.resolve(opts.dir ?? process.cwd());
  const manifestPath = path.join(dir, "plugin.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Couldn't read plugin.json at ${manifestPath}${errorCode(error)}`, {
      cause: error,
    });
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
  const ids = declared.map((t) => t.id).join(", ");
  let tour: (typeof declared)[number] | undefined;
  if (opts.tour) {
    tour = declared.find((t) => t.id === opts.tour);
    if (!tour) throw new Error(`No tour "${opts.tour}" in plugin.json; declared: ${ids}`);
  } else if (declared.length === 1) {
    tour = declared[0]!;
  } else {
    throw new Error(`plugin.json declares several tours; pick one with --tour (${ids})`);
  }
  checkPathId("Tour", tour.id);
  const twin = declared.find((t) => t !== tour && t.id.toLowerCase() === tour.id.toLowerCase());
  if (twin) {
    throw new Error(
      `Tours "${tour.id}" and "${twin.id}" differ only in case and would share one audio folder; rename one`
    );
  }

  const narrationPath = path.resolve(dir, opts.narration ?? `tours/${tour.id}.narration.json`);
  const chapters = await loadNarration(narrationPath);

  // Only an entry the host would accept counts as timing; anything else is
  // treated as missing, so the coverage check catches it before a paid request.
  const entries = new Map<string, ChapterEntry>();
  if (Array.isArray(tour.chapters)) {
    for (const entry of tour.chapters) {
      if (isRecord(entry) && TourChapterSchema.safeParse(entry).success) {
        entries.set(entry.id as string, entry as ChapterEntry);
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
  return {
    dir,
    manifestPath,
    narrationPath,
    indent,
    manifest,
    tour,
    chapters,
    entries,
    written: raw,
    superseded: new Set(),
  };
}

async function loadNarration(file: string): Promise<NarrationChapter[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new Error(
      `Couldn't read narration at ${file}${errorCode(error)}; write { "chapters": [{ "id": "…", "narration": "…" }] } there or pass --narration`,
      { cause: error }
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
  const limit = 32;
  if (list.length > limit) throw new Error(`${file}: a tour holds at most ${limit} chapters`);
  const seen = new Set<string>();
  return list.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.narration !== "string") {
      throw new Error(`${file}: chapters[${index}] needs a string "id" and "narration"`);
    }
    const { id, narration } = item;
    checkPathId("Chapter", id);
    if (seen.has(id.toLowerCase())) throw new Error(`${file}: duplicate chapter id "${id}"`);
    seen.add(id.toLowerCase());
    let parsed: ParsedNarration;
    try {
      parsed = parseNarration(narration);
    } catch (error) {
      throw new Error(`${file}: chapter "${id}": ${(error as Error).message}`, { cause: error });
    }
    if (parsed.words.length === 0) throw new Error(`${file}: chapter "${id}" has no words`);
    return { id, parsed, hash: narrationFingerprint(parsed) };
  });
}

/**
 * Every chapter the narration lists must end the run with real timing: a
 * chapter that never had any, and that this run won't produce, would leave a
 * manifest the host refuses. Checked before any paid request is made.
 */
function requireCoverage(ctx: TourContext, producing: ReadonlySet<string>, hint: string): void {
  const missing = ctx.chapters
    .filter((chapter) => !ctx.entries.has(chapter.id) && !producing.has(chapter.id))
    .map((chapter) => chapter.id);
  if (missing.length > 0) {
    throw new Error(`No timing yet for ${missing.join(", ")}; ${hint}`);
  }
}

/**
 * The tour with its chapters rebuilt in narration order (chapters the
 * narration no longer lists are dropped), checked against the host's own
 * schema so a run never leaves a manifest the host would refuse.
 */
function candidateTour(ctx: TourContext, entries: Map<string, ChapterEntry>) {
  const chapters = ctx.chapters.map((chapter) => entries.get(chapter.id)!);
  const tour = { ...ctx.tour, chapters };
  const checked = TourContributionSchema.safeParse(tour);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => `${issue.path.join(".") || "(tour)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`The tour's timing would not validate; plugin.json not written:\n${issues}`);
  }
  return chapters;
}

async function writeManifest(ctx: TourContext, chapters: ChapterEntry[]): Promise<void> {
  ctx.tour.chapters = chapters;
  const text = `${JSON.stringify(ctx.manifest, null, ctx.indent)}\n`;
  if (text !== ctx.written) {
    await writeAtomic(ctx.manifestPath, text);
    ctx.written = text;
  }
  // Any tour in the manifest may point at a take, not just this one.
  const referenced = new Set<unknown>();
  const tours = isRecord(ctx.manifest.contributes) ? ctx.manifest.contributes.tours : undefined;
  for (const tour of Array.isArray(tours) ? tours : []) {
    if (!isRecord(tour) || !Array.isArray(tour.chapters)) continue;
    for (const chapter of tour.chapters) {
      if (isRecord(chapter)) referenced.add(chapter.audioUrl);
    }
  }
  for (const audioPath of ctx.superseded) {
    if (referenced.has(audioPath) || !isGeneratedAudio(ctx.tour.id, audioPath)) continue;
    await fs.rm(path.join(ctx.dir, audioPath), { force: true });
    ctx.superseded.delete(audioPath);
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

/**
 * Commit one produced chapter: validate the whole tour with it, put its audio
 * at a new content-addressed path, then write plugin.json. The audio the
 * current manifest points at is never touched, so a failure at any step
 * leaves timing and audio agreeing; the old take is removed only after a
 * manifest without it is written. Until every chapter has timing, entries are
 * staged rather than written, since the host refuses a partial tour.
 */
async function commitChapter(
  ctx: TourContext,
  chapter: NarrationChapter,
  timing: TourChapterTiming,
  audio: Buffer,
  variant: string
): Promise<string> {
  const hash = createHash("sha256").update(audio).digest("hex").slice(0, 12);
  const audioPath = `tours/${ctx.tour.id}/${chapter.id}.${variant}.${hash}.ogg`;
  const next = new Map(ctx.entries);
  next.set(chapter.id, {
    id: chapter.id,
    ...roundTiming({ ...timing, audioUrl: audioPath }),
    narrationHash: chapter.hash,
  });
  const complete = ctx.chapters.every((c) => next.has(c.id));
  const chapters = complete ? candidateTour(ctx, next) : null;

  const target = path.join(ctx.dir, audioPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, audio);

  const previous = ctx.entries.get(chapter.id)?.audioUrl;
  if (typeof previous === "string" && previous !== audioPath) ctx.superseded.add(previous);
  ctx.entries = next;
  if (chapters) await writeManifest(ctx, chapters);
  return audioPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Only audio in this tool's own naming is ever deleted, never an author's file. */
function isGeneratedAudio(tourId: string, audioPath: string): boolean {
  return new RegExp(`^tours/${escapeRegExp(tourId)}/[^/]+\\.[a-z0-9-]+\\.[0-9a-f]{12}\\.ogg$`).test(
    audioPath
  );
}

/**
 * Whether `audioPath` is this chapter's take in this voice and is still the
 * audio it was named for: a regular file whose bytes match the hash in its name.
 */
async function isIntactTake(
  ctx: TourContext,
  chapterId: string,
  variant: string,
  audioPath: unknown
): Promise<boolean> {
  if (typeof audioPath !== "string") return false;
  const match = new RegExp(
    `^tours/${escapeRegExp(ctx.tour.id)}/${escapeRegExp(chapterId)}\\.${escapeRegExp(variant)}\\.([0-9a-f]{12})\\.ogg$`
  ).exec(audioPath);
  if (!match) return false;
  try {
    const bytes = await fs.readFile(path.join(ctx.dir, audioPath));
    return createHash("sha256").update(bytes).digest("hex").slice(0, 12) === match[1];
  } catch {
    return false;
  }
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
    ...extra,
  };
}

async function finish(ctx: TourContext, reports: TourChapterReport[]): Promise<TourCommandResult> {
  const listed = new Set(ctx.chapters.map((chapter) => chapter.id));
  for (const [id, entry] of ctx.entries) {
    if (!listed.has(id) && typeof entry.audioUrl === "string") ctx.superseded.add(entry.audioUrl);
  }
  await writeManifest(ctx, candidateTour(ctx, ctx.entries));
  return {
    tourId: ctx.tour.id,
    manifestPath: ctx.manifestPath,
    narrationPath: ctx.narrationPath,
    chapters: reports,
  };
}

/** Filename-safe spelling of a voice or model id. */
function slug(value: string, kind: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!out) throw new Error(`${kind} "${value}" has no usable letters or digits`);
  return out;
}

/**
 * The voice (and a non-default model) is part of each take's file name, so
 * switching either re-voices instead of passing for current.
 */
function voiceVariant(voice: string, model?: string): string {
  return model && model !== DEFAULT_TTS_MODEL
    ? `${slug(voice, "Voice")}-${slug(model, "Model")}`
    : slug(voice, "Voice");
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
  const variant = voiceVariant(voice, opts.model);
  const log = opts.log ?? (() => {});
  const selected = ctx.chapters.filter((c) => !opts.only || opts.only.includes(c.id));
  requireCoverage(
    ctx,
    new Set(selected.map((c) => c.id)),
    "voice them too (leave them out of --only)"
  );

  let apiKey = opts.apiKey;
  const reports: TourChapterReport[] = [];
  for (const chapter of ctx.chapters) {
    if (!selected.includes(chapter)) {
      reports.push(report(ctx, chapter, "not-selected"));
      continue;
    }
    const existing = ctx.entries.get(chapter.id);
    const upToDate =
      existing?.narrationHash === chapter.hash &&
      (await isIntactTake(ctx, chapter.id, variant, existing.audioUrl));
    if (upToDate && !opts.force) {
      log(`· ${chapter.id}: up to date`);
      reports.push(report(ctx, chapter, "up-to-date", { audioPath: existing!.audioUrl as string }));
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
      null
    );
    const audioPath = await commitChapter(ctx, chapter, timing, audio, variant);
    reports.push(report(ctx, chapter, "voiced", { matched, total, audioPath }));
  }
  return finish(ctx, reports);
}

async function findRecordings(dir: string): Promise<Map<string, string>> {
  const byChapter = new Map<string, string>();
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    const ext = path.extname(name);
    if (!RECORDING_EXTENSIONS.includes(ext.toLowerCase())) continue;
    const id = path.basename(name, ext);
    const other = byChapter.get(id);
    if (other) {
      throw new Error(`Two recordings for chapter "${id}": ${path.basename(other)} and ${name}`);
    }
    byChapter.set(id, path.join(dir, name));
  }
  return byChapter;
}

/**
 * Time the author's own recordings: each `<chapter-id>.<ext>` in `recordings`
 * is encoded to mono Ogg Opus, transcribed with word timestamps by an
 * Inworld-routed STT model, and aligned back to the narration's cue markers;
 * the encoded audio is what ships in the plugin. Every chapter with a
 * recording is re-timed, since a new take of the same words is still a new
 * take; chapters without one keep their timing.
 */
export async function runTourAlign(opts: TourAlignOptions): Promise<TourCommandResult> {
  const recordingsDir = path.resolve(opts.recordings);
  let isDir = false;
  try {
    isDir = (await fs.stat(recordingsDir)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Couldn't read recordings folder ${recordingsDir}${errorCode(error)}`, {
        cause: error,
      });
    }
  }
  if (!isDir) throw new Error(`Recordings folder not found: ${recordingsDir}`);

  const ctx = await loadTour(opts);
  const recordings = await findRecordings(recordingsDir);
  const log = opts.log ?? (() => {});
  const selected = ctx.chapters.filter(
    (c) => (!opts.only || opts.only.includes(c.id)) && recordings.has(c.id)
  );
  if (selected.length === 0) {
    throw new Error(`No recording in ${recordingsDir} matches a selected chapter id`);
  }
  requireCoverage(
    ctx,
    new Set(selected.map((c) => c.id)),
    `add their recordings to ${recordingsDir}`
  );

  let apiKey = opts.apiKey;
  const reports: TourChapterReport[] = [];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-align-"));
  try {
    for (const chapter of ctx.chapters) {
      if (opts.only && !opts.only.includes(chapter.id)) {
        reports.push(report(ctx, chapter, "not-selected"));
        continue;
      }
      const recording = recordings.get(chapter.id);
      if (!recording) {
        log(`! ${chapter.id}: no recording found, keeping previous timing`);
        reports.push(report(ctx, chapter, "no-recording"));
        continue;
      }

      apiKey ??= inworldKeyFromEnv();
      log(`→ ${chapter.id}: transcribing ${path.basename(recording)}`);
      // Encoded outside the plugin; only a take that aligns is copied in.
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
        null
      );
      const audioPath = await commitChapter(ctx, chapter, timing, audio, "recorded");
      reports.push(report(ctx, chapter, "aligned", { matched, total, audioPath }));
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  return finish(ctx, reports);
}
