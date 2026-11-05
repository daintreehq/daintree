import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  FOLDER_UPLOAD_MAX_PROBLEM_PATHS,
  FOLDER_UPLOAD_SUMMARY_MAX_ITEMS,
  type FolderUploadProblem,
} from "../../../shared/types/folderUpload.js";
import type {
  FolderNotCopiedReason,
  FolderSummaryItem,
  FolderUploadCheck,
  FolderUploadSummary,
} from "../../../shared/types/ipc/fileTransfer.js";
import {
  checkFolderUploadRootName,
  FolderUploadTally,
} from "../../../shared/utils/folderUpload.js";

/*
 * Walks a folder dropped in a remote window, on this machine, before anything
 * is sent: what the person is asked about, and exactly what the packer may
 * copy. Nothing is followed. A link, junction or other reparse point is listed
 * as not copied, as is anything that isn't a plain file or folder, so nothing
 * from outside the dropped folder is ever read.
 */

/**
 * Items looked at, copied or not, before the walk gives up. The content limits
 * bound what is copied; this bounds a folder of links or sockets that never
 * reaches them.
 */
export const FOLDER_WALK_MAX_ENTRIES = 20_000;

/** One copied entry of a summarized folder, as the packer copies it and checks it hasn't changed. */
export interface FolderSnapshotEntry {
  /** Archive form: `Root/`, `Root/src/`, `Root/src/app.ts`. */
  path: string;
  kind: "file" | "folder";
  /** Content bytes; 0 for a folder. */
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  /** Carried as 0700 rather than 0600. Never on Windows, which has no such bit. */
  executable: boolean;
}

/** Exactly what a ready summary counted. */
export interface FolderSnapshot {
  localPath: string;
  rootName: string;
  /** Sorted by path, so the root's own `Root/` comes first and each folder before what it holds. */
  entries: FolderSnapshotEntry[];
  /** Everything left out, not only the summary's first few, so a later listing can tell them from new arrivals. */
  notCopied: Array<{ path: string; reason: FolderNotCopiedReason }>;
}

type LocalFolderProblem = Extract<FolderUploadCheck, { status: "refused" }>["problem"];

export type LocalFolderWalkResult =
  | { status: "ready"; summary: FolderUploadSummary; snapshot: FolderSnapshot }
  | { status: "refused"; summary: FolderUploadSummary; problem: LocalFolderProblem };

/** The filesystem calls a walk makes, so tests can stand in for another platform. */
export interface LocalFolderWalkFs {
  opendir(
    folder: string,
    options: { bufferSize: number }
  ): Promise<AsyncIterable<Dirent> & { close(): Promise<void> }>;
  lstat(target: string): Promise<Stats>;
  readlink(target: string): Promise<string>;
  access(target: string, mode: number): Promise<void>;
}

export interface LocalFolderWalkOptions {
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  fs?: LocalFolderWalkFs;
}

export type LocalFolderWalkFailure =
  "cancelled" | "not-a-folder" | "link" | "unreadable" | "changed";

/**
 * A walk that couldn't produce a summary. Carries no path: callers word it
 * with the root's name, and nothing from inside the folder reaches a log.
 */
export class LocalFolderWalkError extends Error {
  constructor(readonly reason: LocalFolderWalkFailure) {
    super(`Folder walk failed: ${reason}`);
    this.name = "LocalFolderWalkError";
  }
}

const DIRECTORY_BUFFER = 64;
/** Items classified at once: enough to keep the disk busy without crowding the shared libuv pool. */
const CLASSIFY_BATCH = 16;

const nodeWalkFs: LocalFolderWalkFs = {
  opendir: (folder, options) => fs.opendir(folder, options),
  lstat: (target) => fs.lstat(target),
  readlink: (target) => fs.readlink(target),
  access: (target, mode) => fs.access(target, mode),
};

interface PendingFolder {
  local: string;
  /** Archive form, with its trailing `/`. */
  archive: string;
  stat: Stats;
  /** The name of the item directly inside the root this folder is in; null for the root. */
  top: string | null;
  hidden: boolean;
}

type Classified =
  | { kind: "file"; stat: Stats }
  | { kind: "folder"; stat: Stats }
  | { kind: "skip"; reason: FolderNotCopiedReason };

function isSpecialDirent(dirent: Dirent): boolean {
  return (
    dirent.isFIFO() || dirent.isSocket() || dirent.isBlockDevice() || dirent.isCharacterDevice()
  );
}

/**
 * What one listed item is, without following it. Windows lists every reparse
 * point as a link, and lstat follows any it can't read as one (a WSL socket, a
 * placeholder some filter owns) to whatever it presents, so a listed reparse
 * point is never stat'ed: readlink, which never follows, reads symlinks,
 * junctions, WSL links and app execution aliases and refuses the rest. Node
 * can't tell a junction from a directory symlink, so both are `symlink`. A
 * folder counts only once it opens, so one that can't be listed is left out
 * rather than sent empty.
 */
async function classify(
  walkFs: LocalFolderWalkFs,
  platform: NodeJS.Platform,
  local: string,
  dirent: Dirent
): Promise<Classified> {
  if (dirent.isSymbolicLink()) {
    if (platform !== "win32") return { kind: "skip", reason: "symlink" };
    const target = await walkFs.readlink(local).catch(() => null);
    return { kind: "skip", reason: target === null ? "reparse-point" : "symlink" };
  }
  if (isSpecialDirent(dirent)) return { kind: "skip", reason: "special-file" };
  let stat: Stats;
  try {
    stat = await walkFs.lstat(local);
  } catch {
    return { kind: "skip", reason: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { kind: "skip", reason: "symlink" };
  if (stat.isDirectory()) {
    try {
      const probe = await walkFs.opendir(local, { bufferSize: 1 });
      await probe.close();
    } catch {
      return { kind: "skip", reason: "unreadable" };
    }
    return { kind: "folder", stat };
  }
  if (!stat.isFile()) return { kind: "skip", reason: "special-file" };
  try {
    await walkFs.access(local, fsConstants.R_OK);
  } catch {
    return { kind: "skip", reason: "unreadable" };
  }
  return { kind: "file", stat };
}

/** Whether a tally problem left the entry counted: only a count or size limit does. */
function countedDespite(problem: FolderUploadProblem | null): boolean {
  return (
    problem === null ||
    (problem.kind === "limit" &&
      (problem.limit === "files" || problem.limit === "folders" || problem.limit === "bytes"))
  );
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byBytes(a: FolderSummaryItem, b: FolderSummaryItem): number {
  return b.totalBytes - a.totalBytes || comparePaths(a.path, b.path);
}

function sameEntry(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && b.isDirectory() && !b.isSymbolicLink();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalFolderWalkError("cancelled");
}

/**
 * Whether the dropped folder is itself a Windows reparse point. Only its
 * parent's listing can say: lstat would follow one it can't read as a link.
 * A parent that can't be listed leaves it to lstat, which still catches
 * symlinks and junctions.
 */
async function isListedAsReparsePoint(
  walkFs: LocalFolderWalkFs,
  localPath: string,
  signal: AbortSignal
): Promise<boolean> {
  const parent = path.dirname(localPath);
  if (parent === localPath) return false;
  const name = path.basename(localPath).toLowerCase();
  let dir: Awaited<ReturnType<LocalFolderWalkFs["opendir"]>>;
  try {
    dir = await walkFs.opendir(parent, { bufferSize: DIRECTORY_BUFFER });
  } catch {
    return false;
  }
  try {
    for await (const dirent of dir) {
      throwIfAborted(signal);
      if (dirent.name.toLowerCase() === name) return dirent.isSymbolicLink();
    }
  } catch (error) {
    if (error instanceof LocalFolderWalkError) throw error;
  }
  return false;
}

/**
 * Summarizes the folder at `localPath`, stopping at the first thing that
 * proves it can't be sent: a limit crossed, a clash, a name the host can't
 * keep. Breadth first, so a refusal's largest contributors are spread across
 * the folder's items rather than all taken from the first one walked.
 */
export async function walkLocalFolder(
  localPath: string,
  options: LocalFolderWalkOptions
): Promise<LocalFolderWalkResult> {
  const { signal } = options;
  const platform = options.platform ?? process.platform;
  const walkFs = options.fs ?? nodeWalkFs;
  const rootName = path.basename(localPath);

  throwIfAborted(signal);
  // The dropped item itself is never followed either: a link to a folder is
  // not the folder.
  if (platform === "win32" && (await isListedAsReparsePoint(walkFs, localPath, signal))) {
    throw new LocalFolderWalkError("link");
  }
  let rootStat: Stats;
  try {
    rootStat = await walkFs.lstat(localPath);
  } catch {
    throw new LocalFolderWalkError("unreadable");
  }
  if (rootStat.isSymbolicLink()) throw new LocalFolderWalkError("link");
  if (!rootStat.isDirectory()) throw new LocalFolderWalkError("not-a-folder");

  const tally = new FolderUploadTally(rootName);
  const entries: FolderSnapshotEntry[] = [];
  const notCopied: FolderSnapshot["notCopied"] = [];
  const topItems = new Map<string, FolderSummaryItem>();
  /** Per item inside the root, everything looked at under it, copied or not. */
  const topExamined = new Map<string, { path: string; count: number }>();
  const hidden = { fileCount: 0, folderCount: 0, totalBytes: 0, paths: [] as string[] };
  let examined = 0;

  const record = (
    entryPath: string,
    kind: "file" | "folder",
    stat: Stats,
    top: string | null,
    isHidden: boolean,
    parentHidden: boolean
  ): void => {
    const size = kind === "file" ? stat.size : 0;
    entries.push({
      path: entryPath,
      kind,
      size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      executable: kind === "file" && platform !== "win32" && (stat.mode & 0o111) !== 0,
    });
    if (top !== null) {
      let item = topItems.get(top);
      if (!item) {
        item = { path: entryPath, kind, fileCount: 0, folderCount: 0, totalBytes: 0 };
        topItems.set(top, item);
      }
      if (kind === "file") item.fileCount += 1;
      else item.folderCount += 1;
      item.totalBytes += size;
    }
    if (isHidden) {
      if (kind === "file") hidden.fileCount += 1;
      else hidden.folderCount += 1;
      hidden.totalBytes += size;
      if (!parentHidden && hidden.paths.length < FOLDER_UPLOAD_SUMMARY_MAX_ITEMS) {
        hidden.paths.push(entryPath);
      }
    }
  };

  const summary = (lowerBound: boolean): FolderUploadSummary => ({
    rootName,
    totals: tally.totals,
    lowerBound,
    hidden: { ...hidden, paths: [...hidden.paths].sort(comparePaths) },
    largest: [...topItems.values()].sort(byBytes).slice(0, FOLDER_UPLOAD_SUMMARY_MAX_ITEMS),
    notCopied: {
      count: notCopied.length,
      items: notCopied.slice(0, FOLDER_UPLOAD_SUMMARY_MAX_ITEMS),
    },
  });

  const contributors = <T extends { path: string }>(items: T[], measure: (item: T) => number) =>
    items
      .filter((item) => measure(item) > 0)
      .sort((a, b) => measure(b) - measure(a) || comparePaths(a.path, b.path))
      .slice(0, FOLDER_UPLOAD_MAX_PROBLEM_PATHS)
      .map((item) => item.path);

  const refuse = (problem: LocalFolderProblem): LocalFolderWalkResult => {
    let named = problem;
    if (problem.kind === "limit" && problem.paths.length === 0) {
      const measure =
        problem.limit === "files"
          ? (item: FolderSummaryItem) => item.fileCount
          : problem.limit === "folders"
            ? (item: FolderSummaryItem) => item.folderCount
            : (item: FolderSummaryItem) => item.totalBytes;
      named = { ...problem, paths: contributors([...topItems.values()], measure) };
    }
    return { status: "refused", summary: summary(true), problem: named };
  };

  const rootProblem = checkFolderUploadRootName(rootName);
  if (rootProblem) return refuse(rootProblem);

  const rootArchive = `${rootName}/`;
  const rootEntryProblem = tally.add({ path: rootArchive, kind: "folder" });
  if (rootEntryProblem) return refuse(rootEntryProblem);
  record(rootArchive, "folder", rootStat, null, false, false);

  const queue: PendingFolder[] = [
    { local: localPath, archive: rootArchive, stat: rootStat, top: null, hidden: false },
  ];
  // A folder swapped for another (or for a link) since it was found: listing
  // it would read what the drop never named. Checked before it is listed and
  // again before anything read from it is reported, ready or refused.
  const verify = async (folder: PendingFolder): Promise<void> => {
    const now = await walkFs.lstat(folder.local).catch(() => null);
    if (!now || !sameEntry(folder.stat, now)) throw new LocalFolderWalkError("changed");
  };

  for (let next = 0; next < queue.length; next++) {
    const folder = queue[next]!;
    throwIfAborted(signal);
    if (folder.top !== null) await verify(folder);
    let dir: Awaited<ReturnType<LocalFolderWalkFs["opendir"]>>;
    try {
      dir = await walkFs.opendir(folder.local, { bufferSize: DIRECTORY_BUFFER });
    } catch {
      // It opened when it was found, so it has changed since.
      throw new LocalFolderWalkError(folder.top === null ? "unreadable" : "changed");
    }
    let batch: Dirent[] = [];
    const flush = async (): Promise<LocalFolderProblem | null> => {
      const dirents = batch;
      batch = [];
      throwIfAborted(signal);
      const found = await Promise.all(
        dirents.map((dirent) =>
          classify(walkFs, platform, path.join(folder.local, dirent.name), dirent)
        )
      );
      throwIfAborted(signal);
      for (let i = 0; i < dirents.length; i++) {
        const name = dirents[i]!.name;
        const classified = found[i]!;
        const entryPath = `${folder.archive}${name}`;
        const top = folder.top ?? name;
        examined += 1;
        const examinedUnder = topExamined.get(top) ?? { path: entryPath, count: 0 };
        examinedUnder.count += 1;
        topExamined.set(top, examinedUnder);
        if (classified.kind === "skip") {
          notCopied.push({ path: entryPath, reason: classified.reason });
        } else {
          const archive = classified.kind === "folder" ? `${entryPath}/` : entryPath;
          if (classified.kind === "folder" && folder.top === null) examinedUnder.path = archive;
          const problem = tally.add({
            path: archive,
            kind: classified.kind,
            bytes: classified.kind === "file" ? classified.stat.size : 0,
          });
          const isHidden = folder.hidden || name.startsWith(".");
          if (countedDespite(problem)) {
            record(archive, classified.kind, classified.stat, top, isHidden, folder.hidden);
          }
          if (problem) return problem;
          if (classified.kind === "folder") {
            queue.push({
              local: path.join(folder.local, name),
              archive,
              stat: classified.stat,
              top,
              hidden: isHidden,
            });
          }
        }
        if (examined > FOLDER_WALK_MAX_ENTRIES) {
          return {
            kind: "walk-limit",
            maximum: FOLDER_WALK_MAX_ENTRIES,
            actual: examined,
            paths: contributors([...topExamined.values()], (item) => item.count),
          };
        }
      }
      return null;
    };
    let problem: LocalFolderProblem | null = null;
    try {
      for await (const dirent of dir) {
        batch.push(dirent);
        if (batch.length < CLASSIFY_BATCH) continue;
        problem = await flush();
        if (problem) break;
      }
      problem ??= await flush();
    } catch (error) {
      if (error instanceof LocalFolderWalkError) throw error;
      throw new LocalFolderWalkError("changed");
    }
    await verify(folder);
    if (problem) return refuse(problem);
  }

  entries.sort((a, b) => comparePaths(a.path, b.path));
  return {
    status: "ready",
    summary: summary(false),
    snapshot: { localPath, rootName, entries, notCopied },
  };
}
