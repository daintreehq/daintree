import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  lstat,
  lutimes,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  parseAnswers,
  parseMessages,
  type InjectionIntent,
  type PhoneImageFile,
  type PhoneImageStore,
  type QuestionRow,
} from "@daintreehq/decisions-client";
import type { ImageMime } from "@daintreehq/decisions-protocol";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  OWNER_RW_FILE_MODE,
  OWNER_RWX_DIR_MODE,
  ensureOwnerOnlyDir,
  resilientAtomicWriteFile,
  resilientUnlink,
  syncParentDirectory,
} from "../../utils/fs.js";
import { isTypedImagePath } from "./answerNotice.js";
import { isHandled, readHandledAnswers, type MetaStore } from "./attentionList.js";

/**
 * Photos a person attaches on their phone (#16233), stored where the agent
 * that asked can open them:
 *
 *   <launch cwd>/.daintree/decisions/.gitignore            ("*", so Git ignores it all)
 *   <launch cwd>/.daintree/decisions/images/<store>/<question>/<attachment>.<png|jpg|webp>
 *
 * The launch cwd is the origin's `worktree_root`, the directory the agent
 * started in: Claude Code reads there without asking, where a file outside
 * its working directories needs a person to approve it, and Codex's sandbox
 * reads anywhere. Gemini CLI refuses every Git-ignored file, so it can't open
 * these. `<store>` is this installation's own id, so another Daintree using
 * the same checkout (a development build) never has its images swept.
 *
 * Every directory below the launch cwd is checked with `lstat` (the agent
 * can write there, and a repository can commit a symlink), the ones this
 * makes are owner-only, and each image is written to a part file opened
 * O_EXCL|O_NOFOLLOW at 0600, synced, then renamed into place and checked
 * again. Deleting takes only Daintree's own file names, from a directory
 * that is still the one checked. Path checks narrow a race with a directory
 * swapped for a link but can't close it; Node has no `openat`. The launch
 * roots that hold images are recorded beside the keys, so the images can be
 * found after their rows are gone.
 *
 * A question's images are kept while anything of it may still be typed in,
 * and for {@link PHONE_IMAGE_RETENTION_MS} after that; they go sooner when
 * the relay deletes the question, and with Decisions' local data. A sweep
 * runs when the store opens, after each deletion and every hour.
 */

/** How long an image stays once nothing of its question is waiting to be typed in. */
export const PHONE_IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How often a running store sweeps. A sweep touches what still waits, so an
 * image goes only once this much more than the retention has passed: what
 * waited was typed in at most one sweep after the last one that saw it wait.
 */
export const PHONE_IMAGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** A root missing this long went with its worktree; one missing less long may be a drive not mounted. */
const MISSING_ROOT_MS = 90 * 24 * 60 * 60 * 1000;

const DECISIONS_DIR = [".daintree", "decisions"] as const;
const IMAGES_DIR = "images";
const IGNORE_FILE = ".gitignore";
const IGNORE_ALL = "*\n";
/** Question and attachment ids as the library and the relay mint them: never free text. */
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const STORE_ID = /^[0-9a-f]{32}$/;
const PART = /^\.part-[0-9a-f]{16}$/;
/** The only files a sweep or a deletion takes: the images this writes, and its part files. */
const OWN_FILE = /^(?:[A-Za-z0-9_-]{1,80}\.(?:png|jpg|webp)|\.part-[0-9a-f]{16})$/;
const MAX_ROOTS = 1_000;
const EXTENSIONS: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Where this installation records the launch roots that hold its images. */
export function phoneImageRootsFile(keyFilePath: string): string {
  return join(dirname(keyFilePath), "phone-images.json");
}

/** What the sweep reads of the store: the rows, the injections not yet settled and the relay's deletions. */
export interface PhoneImageFacts extends MetaStore {
  listQuestions(): Promise<QuestionRow[]>;
  openIntents(): Promise<InjectionIntent[]>;
  /** Questions whose deletion by the relay has been applied here. */
  deletedQuestionIds(): Promise<ReadonlySet<string>>;
}

export interface DecisionsPhoneImagesOptions {
  rootsFile: string;
  facts: PhoneImageFacts;
  now?: () => number;
  retentionMs?: number;
  /** 0 leaves sweeping to `sweep()` alone. */
  sweepIntervalMs?: number;
}

interface RootsRecord {
  v: 1;
  /** This installation's directory under each root's images directory; kept, so it never changes. */
  id: string;
  roots: string[];
  /** When a sweep first found a root missing, by root. */
  missing?: Record<string, number>;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

const isMissing = (error: unknown) => codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR";

const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** Ours to write in or delete from: a real directory or file, owned by this user. */
function owned(stats: Stats): boolean {
  const uid = ownUid();
  return process.platform === "win32" || uid === null || stats.uid === uid;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function imagesDir(root: string, storeId: string): string {
  return join(root, ...DECISIONS_DIR, IMAGES_DIR, storeId);
}

/**
 * Each of `parts` below `root`, as a real directory owned by this user,
 * made owner-only when missing. `tighten` also makes existing ones
 * owner-only: the ones only Daintree makes. Throws on a symlink or anything
 * else in the way, so nothing is ever written through one.
 */
async function directoryChain(
  root: string,
  parts: readonly string[],
  tighten: (index: number) => boolean
): Promise<string> {
  let dir = root;
  for (const [index, part] of parts.entries()) {
    dir = join(dir, part);
    let stats = await lstatOrNull(dir);
    if (stats === null) {
      try {
        await mkdir(dir, { mode: OWNER_RWX_DIR_MODE });
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      stats = await lstat(dir);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() || !owned(stats)) {
      throw new Error("A phone image's directory isn't a real directory of this user's");
    }
    if (tighten(index) && process.platform !== "win32" && (stats.mode & 0o777) !== 0o700) {
      await ensureOwnerOnlyDir(dir);
    }
  }
  return dir;
}

/** `<root>/.daintree/decisions` and below, as real directories, without making any: null when one isn't. */
async function existingChain(root: string, parts: readonly string[]): Promise<string | null> {
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    const stats = await lstatOrNull(dir);
    if (stats === null || stats.isSymbolicLink() || !stats.isDirectory() || !owned(stats)) {
      return null;
    }
  }
  return dir;
}

/** The ignore file that keeps every image out of Git, written once and never replaced. */
async function ensureIgnoreFile(dir: string): Promise<void> {
  const path = join(dir, IGNORE_FILE);
  const stats = await lstatOrNull(path);
  if (stats !== null) {
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (await readFile(path, "utf8")) !== IGNORE_ALL
    ) {
      throw new Error("The phone images' .gitignore isn't Daintree's");
    }
    return;
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    OWNER_RW_FILE_MODE
  );
  try {
    await handle.writeFile(IGNORE_ALL);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParentDirectory(path);
}

async function sha256OfFile(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    return createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** A real directory of this user's, or null. */
async function ownDirectory(dir: string): Promise<Stats | null> {
  const stats = await lstatOrNull(dir);
  return stats !== null && !stats.isSymbolicLink() && stats.isDirectory() && owned(stats)
    ? stats
    : null;
}

/** Still the directory `checked` was: not swapped for a link, or for another directory. */
async function stillDirectory(dir: string, checked: Stats): Promise<boolean> {
  const now = await ownDirectory(dir);
  return now !== null && now.ino === checked.ino && now.dev === checked.dev;
}

/**
 * Each of Daintree's own files in a question's directory, while it is still
 * the directory first checked: what else is in it, a directory Daintree never
 * makes included, is left alone with its parent.
 */
async function ownEntries(
  dir: string,
  each: (entry: string, name: string, stats: Stats) => Promise<void>
): Promise<void> {
  const checked = await ownDirectory(dir);
  if (checked === null) return;
  for (const name of await readdir(dir)) {
    if (!OWN_FILE.test(name)) continue;
    if (!(await stillDirectory(dir, checked))) return;
    const entry = join(dir, name);
    const stats = await lstatOrNull(entry);
    if (stats === null || stats.isDirectory()) continue;
    await each(entry, name, stats);
  }
}

/** Unlinks a link as a link, never what it points to. */
async function unlinkQuietly(entry: string): Promise<void> {
  await unlink(entry).catch(() => {});
}

/** Deletes Daintree's files in a question's directory, then the directory if that empties it. */
async function removeQuestionDir(dir: string): Promise<void> {
  await ownEntries(dir, (entry) => unlinkQuietly(entry));
  await rmdirIfEmpty(dir);
}

async function rmdirIfEmpty(dir: string): Promise<boolean> {
  try {
    await rmdir(dir);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    return false;
  }
}

async function readRecord(file: string): Promise<RootsRecord | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<RootsRecord> | null;
  if (
    parsed?.v !== 1 ||
    typeof parsed.id !== "string" ||
    !STORE_ID.test(parsed.id) ||
    !Array.isArray(parsed.roots)
  ) {
    throw new Error("The phone images' record is damaged");
  }
  const roots = [
    ...new Set(
      parsed.roots.filter((root): root is string => typeof root === "string" && isAbsolute(root))
    ),
  ].slice(0, MAX_ROOTS);
  const missing: Record<string, number> = {};
  for (const root of roots) {
    const since = parsed.missing?.[root];
    if (typeof since === "number" && Number.isFinite(since)) missing[root] = since;
  }
  return { v: 1, id: parsed.id, roots, missing };
}

/** Writes the record, keeping its id; `drop` removes the file instead once no root is left. */
async function writeRecord(file: string, record: RootsRecord, drop = false): Promise<void> {
  if (drop && record.roots.length === 0) {
    try {
      await resilientUnlink(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await syncParentDirectory(file).catch(() => {});
    return;
  }
  await ensureOwnerOnlyDir(dirname(file));
  await resilientAtomicWriteFile(file, JSON.stringify(record), "utf-8", {
    mode: OWNER_RW_FILE_MODE,
  });
}

/** Still wanted by something that may type it in: an answer or follow-up waiting, or an injection unsettled. */
function questionsInUse(
  rows: readonly QuestionRow[],
  intents: readonly InjectionIntent[],
  handled: ReadonlyMap<string, number>
): Set<string> {
  const inUse = new Set<string>();
  const unsettled = new Set(intents.map((intent) => intent.question_id));
  for (const row of rows) {
    if (row.history_only) continue;
    // A handled answer is never typed in; a follow-up after it still may be.
    const answerWaits =
      !isHandled(row, handled) &&
      parseAnswers(row.answers_json).some((entry) => entry.deliver && !entry.delivered);
    const messageWaits = parseMessages(row.messages_json).some(
      (message) =>
        message.side === "human" &&
        message.delivery?.deliver === true &&
        message.delivery.status !== "terminal-delivered"
    );
    if (answerWaits || messageWaits || unsettled.has(row.question_id)) inUse.add(row.question_id);
  }
  return inUse;
}

/**
 * The library's `PhoneImageStore` for one open store, and the sweeps that
 * keep what it wrote in bounds. Stores, deletions and sweeps take turns on
 * one gate, so a sweep never sees a part file mid-write.
 */
export class DecisionsPhoneImages implements PhoneImageStore {
  private gate: Promise<unknown> = Promise.resolve();
  private closed = false;
  private sweepQueued: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval> | null;
  private readonly now: () => number;
  private readonly retentionMs: number;

  constructor(private readonly o: DecisionsPhoneImagesOptions) {
    this.now = o.now ?? Date.now;
    this.retentionMs = o.retentionMs ?? PHONE_IMAGE_RETENTION_MS;
    const interval = o.sweepIntervalMs ?? PHONE_IMAGE_SWEEP_INTERVAL_MS;
    this.timer = interval > 0 ? setInterval(() => void this.sweep(), interval) : null;
    this.timer?.unref?.();
    void this.sweep();
  }

  store(image: PhoneImageFile): Promise<{ path: string }> {
    return this.run(async () => ({ path: await this.write(image) }));
  }

  /** Sweeps once the turn before it is done; a sweep already waiting is joined. */
  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.sweepQueued ??= this.run(async () => {
      this.sweepQueued = null;
      try {
        await this.sweepNow();
      } catch (error) {
        console.warn(
          `[Decisions] Phone images weren't swept: ${formatErrorMessage(error, "unknown error")}`
        );
      }
    }).catch(() => {});
    return this.sweepQueued;
  }

  /** Takes no more images, and settles once the one being written, or the sweep running, has. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    await this.gate.catch(() => {});
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.gate.then(() => {
      if (this.closed) throw new Error("Decisions has stopped storing phone images here");
      return task();
    });
    this.gate = next.catch(() => {});
    return next;
  }

  private async write(image: PhoneImageFile): Promise<string> {
    const root = image.origin.worktree_root;
    const ext = EXTENSIONS[image.mime];
    if (typeof root !== "string" || !isAbsolute(root) || ext === undefined) {
      throw new Error("This pane has no directory a phone image can go in");
    }
    // A network share would take the photo off this computer.
    if (process.platform === "win32" && /^[\\/]{2}/.test(root)) {
      throw new Error("Phone images aren't stored on a network share");
    }
    if (!ID.test(image.questionId) || !ID.test(image.attachmentId)) {
      throw new Error("A phone image's ids can't name a file");
    }
    const digest = createHash("sha256").update(image.bytes).digest("hex");
    if (digest !== image.sha256) throw new Error("A phone image doesn't match its digest");
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) throw new Error("A pane's directory isn't a directory");

    const record = (await readRecord(this.o.rootsFile)) ?? {
      v: 1 as const,
      id: randomBytes(16).toString("hex"),
      roots: [],
    };
    const target = join(
      imagesDir(root, record.id),
      image.questionId,
      `${image.attachmentId}.${ext}`
    );
    // One the library types verbatim and Daintree's block takes as it is, or the words would be refused too.
    if (!isTypedImagePath(target)) throw new Error("A phone image's path can't be typed");
    // Recorded before any file exists, so nothing written can go unfound.
    if (!record.roots.includes(root)) {
      if (record.roots.length >= MAX_ROOTS) throw new Error("Too many directories hold images");
      await writeRecord(this.o.rootsFile, { ...record, roots: [...record.roots, root] });
    }

    const decisions = await directoryChain(root, DECISIONS_DIR, (index) => index > 0);
    await ensureIgnoreFile(decisions);
    const dir = await directoryChain(
      decisions,
      [IMAGES_DIR, record.id, image.questionId],
      () => true
    );

    const existing = await lstatOrNull(target);
    if (
      existing?.isFile() &&
      existing.nlink === 1 &&
      owned(existing) &&
      (await sha256OfFile(target)) === image.sha256
    ) {
      return target;
    }
    const part = join(dir, `.part-${randomBytes(8).toString("hex")}`);
    const handle = await open(
      part,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      OWNER_RW_FILE_MODE
    );
    let written: Stats;
    try {
      try {
        await handle.writeFile(image.bytes);
        // The umask can take away the owner's read too.
        if (process.platform !== "win32") await handle.chmod(OWNER_RW_FILE_MODE);
        await handle.sync();
        written = await handle.stat();
      } finally {
        await handle.close();
      }
      // Replaces a damaged or planted file there, never following a link.
      await rename(part, target);
    } catch (error) {
      await unlinkQuietly(part);
      throw error;
    }
    // A directory swapped for a link meanwhile took the file elsewhere: it goes, and the store fails.
    const placed = await lstatOrNull(target);
    const same = placed !== null && placed.ino === written.ino && placed.dev === written.dev;
    if (
      !same ||
      (await existingChain(decisions, [IMAGES_DIR, record.id, image.questionId])) !== dir
    ) {
      if (same) await unlinkQuietly(target);
      throw new Error("A phone image's directory changed while it was written");
    }
    await syncParentDirectory(target);
    return target;
  }

  private async sweepNow(): Promise<void> {
    const record = await readRecord(this.o.rootsFile);
    if (record === null) return;
    // Facts that can't be read delete nothing.
    const [rows, intents, deleted, handled] = await Promise.all([
      this.o.facts.listQuestions(),
      this.o.facts.openIntents(),
      this.o.facts.deletedQuestionIds(),
      readHandledAnswers(this.o.facts),
    ]);
    const known = new Set(rows.map((row) => row.question_id));
    const inUse = questionsInUse(rows, intents, handled);
    const now = this.now();
    const roots: string[] = [];
    const missing: Record<string, number> = {};
    for (const root of record.roots) {
      const swept = await this.sweepRoot(root, record.id, { known, deleted, inUse, now });
      if (swept === "missing") {
        const since = record.missing?.[root] ?? now;
        if (now - since >= MISSING_ROOT_MS) continue;
        missing[root] = since;
      }
      if (swept !== "empty") roots.push(root);
    }
    const before = JSON.stringify([record.roots, record.missing ?? {}]);
    if (JSON.stringify([roots, missing]) !== before) {
      await writeRecord(this.o.rootsFile, { ...record, roots, missing });
    }
  }

  /**
   * `empty` once the root is reached and holds none of this installation's
   * images, `missing` when the root itself isn't there (gone with its
   * worktree, or a drive not mounted), `kept` otherwise.
   */
  private async sweepRoot(
    root: string,
    storeId: string,
    facts: {
      known: ReadonlySet<string>;
      deleted: ReadonlySet<string>;
      inUse: ReadonlySet<string>;
      now: number;
    }
  ): Promise<"empty" | "missing" | "kept"> {
    let rootStats: Stats;
    try {
      rootStats = await stat(root);
    } catch (error) {
      return isMissing(error) ? "missing" : "kept";
    }
    if (!rootStats.isDirectory()) return "missing";
    const dir = await existingChain(root, [...DECISIONS_DIR, IMAGES_DIR, storeId]);
    if (dir === null)
      return (await lstatOrNull(imagesDir(root, storeId))) === null ? "empty" : "kept";
    for (const name of await readdir(dir)) {
      if (!ID.test(name)) continue;
      const question = join(dir, name);
      if (!facts.known.has(name) || facts.deleted.has(name)) {
        await removeQuestionDir(question);
        continue;
      }
      await this.ageQuestionDir(question, facts.inUse.has(name), facts.now);
    }
    return (await rmdirIfEmpty(dir)) ? "empty" : "kept";
  }

  /**
   * An image waiting to be typed in is touched, so its time starts once
   * nothing waits; one that has had its time goes, and so does a part file
   * no write is making.
   */
  private async ageQuestionDir(dir: string, inUse: boolean, now: number): Promise<void> {
    await ownEntries(dir, async (entry, name, stats) => {
      if (PART.test(name) || stats.isSymbolicLink()) {
        await unlinkQuietly(entry);
      } else if (inUse) {
        const at = new Date(now);
        await lutimes(entry, at, at).catch(() => {});
      } else if (now - stats.mtimeMs >= this.retentionMs + PHONE_IMAGE_SWEEP_INTERVAL_MS) {
        await unlinkQuietly(entry);
      }
    });
    await rmdirIfEmpty(dir);
  }
}

/**
 * Deletes every phone image this installation stored, wherever its record
 * says (#16025): run once Decisions' rows are gone, with no store of images
 * open. A root out of reach (a drive not mounted) stays recorded, so the next
 * sweep deletes it once it's back; true when nothing was left.
 */
export async function erasePhoneImages(rootsFile: string): Promise<boolean> {
  let record: RootsRecord | null;
  try {
    record = await readRecord(rootsFile);
  } catch {
    return false;
  }
  if (record === null) return true;
  const left: string[] = [];
  for (const root of record.roots) {
    try {
      // A root not there may be a drive not mounted: kept for a sweep to find.
      if (!(await stat(root)).isDirectory()) continue;
      const dir = await existingChain(root, [...DECISIONS_DIR, IMAGES_DIR, record.id]);
      if (dir === null) {
        if ((await lstatOrNull(imagesDir(root, record.id))) !== null) left.push(root);
        continue;
      }
      for (const name of await readdir(dir)) {
        if (ID.test(name)) await removeQuestionDir(join(dir, name));
      }
      if (!(await rmdirIfEmpty(dir))) left.push(root);
    } catch {
      left.push(root);
    }
  }
  const missing = Object.fromEntries(
    Object.entries(record.missing ?? {}).filter(([root]) => left.includes(root))
  );
  try {
    await writeRecord(rootsFile, { ...record, roots: left, missing }, true);
  } catch {
    return false;
  }
  return left.length === 0;
}
