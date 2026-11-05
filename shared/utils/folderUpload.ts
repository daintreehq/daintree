import {
  FOLDER_UPLOAD_MAX_ARCHIVE_BYTES,
  FOLDER_UPLOAD_MAX_DEPTH,
  FOLDER_UPLOAD_MAX_FOLDERS,
  FOLDER_UPLOAD_MAX_NAME_BYTES,
  FOLDER_UPLOAD_MAX_PATH_BYTES,
  type FolderUploadLimit,
  type FolderUploadPathProblem,
  type FolderUploadProblem,
  type FolderUploadTotals,
} from "../types/folderUpload.js";
import { FOLDER_UPLOAD_MAX_BYTES, FOLDER_UPLOAD_MAX_FILES } from "../types/remoteHosts.js";
import { foldFileName } from "./fileNameFold.js";

/*
 * The content rules for a folder sent to a host, as pure checks the Shell's
 * walker and packer and the host's unpacker all call, so both sides refuse
 * the same folders for the same reasons. They are lexical only: the host
 * still writes through its own containment and never trusts a path for being
 * accepted here.
 */

export type FolderUploadEntryKind = "file" | "folder";

/** One archive entry: a folder's path ends in `/`, a file's never does. */
export interface FolderUploadEntry {
  path: string;
  kind: FolderUploadEntryKind;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;

/** UTF-8 bytes in `text`; an unpaired surrogate counts as the 3-byte replacement it would become. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) i++;
    else if (isHighSurrogate(unit) || isLowSurrogate(unit)) return true;
  }
  return false;
}

function characterProblem(text: string): FolderUploadPathProblem | null {
  if (text.includes("\\")) return "separator";
  if (CONTROL_CHARACTER.test(text)) return "control-character";
  if (hasUnpairedSurrogate(text)) return "malformed-unicode";
  return null;
}

function overLimit(
  limit: FolderUploadLimit,
  maximum: number,
  actual: number,
  paths: string[]
): FolderUploadProblem {
  return { kind: "limit", limit, maximum, actual, paths };
}

function rootNameProblem(name: string): FolderUploadPathProblem | null {
  if (name === "") return "empty-name";
  if (name === "." || name === "..") return "dot-name";
  if (name.includes("/")) return "separator";
  if (DRIVE_LETTER.test(name)) return "drive-letter";
  return characterProblem(name);
}

/** The dropped folder's own name, which every archive entry starts with. */
export function checkFolderUploadRootName(name: string): FolderUploadProblem | null {
  const problem = rootNameProblem(name);
  if (problem) return { kind: "path", problem, path: name };
  const bytes = utf8ByteLength(name);
  if (bytes > FOLDER_UPLOAD_MAX_NAME_BYTES) {
    return overLimit("name-bytes", FOLDER_UPLOAD_MAX_NAME_BYTES, bytes, [name]);
  }
  return null;
}

function entryPathProblem(
  rootName: string,
  entry: FolderUploadEntry
): FolderUploadPathProblem | null {
  const { path, kind } = entry;
  if (path === "") return "empty-name";
  if (path.startsWith("/")) return "absolute";
  if (DRIVE_LETTER.test(path)) return "drive-letter";
  const characters = characterProblem(path);
  if (characters) return characters;
  const folderForm = path.endsWith("/");
  if (folderForm !== (kind === "folder")) return "entry-form";
  const components = (folderForm ? path.slice(0, -1) : path).split("/");
  if (components.some((component) => component === "")) return "empty-name";
  if (components.some((component) => component === "." || component === "..")) return "dot-name";
  if (components[0] !== rootName) return "outside-root";
  if (kind === "file" && components.length === 1) return "outside-root";
  return null;
}

/**
 * One entry's path as given, never normalized first: a path is carried with
 * the spelling it was checked in or not at all. The root folder's own entry
 * is `${rootName}/`.
 */
export function checkFolderUploadEntryPath(
  rootName: string,
  entry: FolderUploadEntry
): FolderUploadProblem | null {
  const problem = entryPathProblem(rootName, entry);
  if (problem) return { kind: "path", problem, path: entry.path };
  const relative = entry.kind === "folder" ? entry.path.slice(0, -1) : entry.path;
  const components = relative.split("/");
  const depth = components.length - 1;
  if (depth > FOLDER_UPLOAD_MAX_DEPTH) {
    return overLimit("depth", FOLDER_UPLOAD_MAX_DEPTH, depth, [entry.path]);
  }
  for (const component of components) {
    const bytes = utf8ByteLength(component);
    if (bytes > FOLDER_UPLOAD_MAX_NAME_BYTES) {
      return overLimit("name-bytes", FOLDER_UPLOAD_MAX_NAME_BYTES, bytes, [entry.path]);
    }
  }
  const bytes = utf8ByteLength(relative);
  if (bytes > FOLDER_UPLOAD_MAX_PATH_BYTES) {
    return overLimit("path-bytes", FOLDER_UPLOAD_MAX_PATH_BYTES, bytes, [entry.path]);
  }
  return null;
}

/**
 * The count and size limits, in that order. A limit problem's `paths` is left
 * empty: only the caller knows the largest contributors to fill it with. On a
 * walk that stopped early a crossing still holds, but a pass proves nothing.
 */
export function checkFolderUploadTotals(
  totals: FolderUploadTotals & { archiveBytes?: number }
): FolderUploadProblem | null {
  if (totals.fileCount > FOLDER_UPLOAD_MAX_FILES) {
    return overLimit("files", FOLDER_UPLOAD_MAX_FILES, totals.fileCount, []);
  }
  if (totals.folderCount > FOLDER_UPLOAD_MAX_FOLDERS) {
    return overLimit("folders", FOLDER_UPLOAD_MAX_FOLDERS, totals.folderCount, []);
  }
  if (totals.totalBytes > FOLDER_UPLOAD_MAX_BYTES) {
    return overLimit("bytes", FOLDER_UPLOAD_MAX_BYTES, totals.totalBytes, []);
  }
  if (totals.archiveBytes !== undefined && totals.archiveBytes > FOLDER_UPLOAD_MAX_ARCHIVE_BYTES) {
    return overLimit("archive-bytes", FOLDER_UPLOAD_MAX_ARCHIVE_BYTES, totals.archiveBytes, []);
  }
  return null;
}

interface NameNode {
  spelling: string;
  /** Where this name was first met, in archive form. */
  path: string;
  kind: FolderUploadEntryKind;
  /** A folder that has had an entry of its own, rather than only being a parent. */
  listed: boolean;
  children: Map<string, NameNode>;
}

function folderNode(spelling: string, path: string, listed: boolean): NameNode {
  return { spelling, path, kind: "folder", listed, children: new Map() };
}

/**
 * Everything one folder upload holds so far, entry by entry: the path rules,
 * the names a case-insensitive disk would merge, and the limits. The Shell
 * feeds it what its walk finds and the host what the archive lists, so a
 * folder either side refuses is refused by both.
 */
export class FolderUploadTally {
  private readonly root: NameNode;
  private readonly counted: FolderUploadTotals = { fileCount: 0, folderCount: 0, totalBytes: 0 };

  constructor(private readonly rootName: string) {
    this.root = folderNode(rootName, `${rootName}/`, false);
  }

  get totals(): FolderUploadTotals {
    return { ...this.counted };
  }

  /**
   * The first problem this entry makes, or null. A path or clash problem
   * leaves the tally as it was; an entry over a count or size limit is still
   * counted, so the limit reports what was actually there.
   */
  add(entry: FolderUploadEntry & { bytes?: number }): FolderUploadProblem | null {
    const problem = checkFolderUploadEntryPath(this.rootName, entry) ?? this.place(entry);
    if (problem) return problem;
    return checkFolderUploadTotals(this.counted);
  }

  private place(entry: FolderUploadEntry & { bytes?: number }): FolderUploadProblem | null {
    const components = (entry.kind === "folder" ? entry.path.slice(0, -1) : entry.path).split("/");
    let node = this.root;
    if (components.length === 1) {
      if (node.listed) return { kind: "clash", paths: [node.path, entry.path] };
      node.listed = true;
      return null;
    }
    let prefix = components[0]!;
    // A clash can only be met along names already there: once a name is added,
    // everything below it is new, so a clash never leaves part of an entry behind.
    for (let i = 1; i < components.length; i++) {
      const name = components[i]!;
      prefix = `${prefix}/${name}`;
      const last = i === components.length - 1;
      const kind = last ? entry.kind : "folder";
      const path = last ? entry.path : `${prefix}/`;
      const key = foldFileName(name);
      const found = node.children.get(key);
      if (!found) {
        const created: NameNode =
          kind === "folder"
            ? folderNode(name, path, last)
            : { spelling: name, path, kind, listed: true, children: new Map() };
        node.children.set(key, created);
        if (kind === "folder") this.counted.folderCount++;
        else {
          this.counted.fileCount++;
          this.counted.totalBytes += entry.bytes ?? 0;
        }
        node = created;
        continue;
      }
      if (found.spelling !== name || found.kind === "file" || kind === "file") {
        return { kind: "clash", paths: [found.path, path] };
      }
      if (last) {
        if (found.listed) return { kind: "clash", paths: [found.path, path] };
        found.listed = true;
      }
      node = found;
    }
    return null;
  }
}
