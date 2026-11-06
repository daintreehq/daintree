/*
 * What a folder sent from this computer to a host may hold (#16247), beside
 * FOLDER_UPLOAD_MAX_FILES and FOLDER_UPLOAD_MAX_BYTES in remoteHosts.ts. The
 * Shell checks a dropped folder against these before anything is sent, and
 * the host checks the archive that arrives against them again, never trusting
 * the Shell's counts. Paths are the archive's: relative POSIX paths whose
 * first component is the dropped folder's own name (`Root/src/app.ts`).
 *
 * File and folder counts never include the root folder itself, so a folder
 * holding three subfolders counts three.
 */
import { FOLDER_UPLOAD_MAX_BYTES } from "./remoteHosts.js";

/** Folders below the root, so a tree of empty folders is bounded as files are. */
export const FOLDER_UPLOAD_MAX_FOLDERS = 5_000;

/** Components below the root: `Root/a.txt` is depth 1. */
export const FOLDER_UPLOAD_MAX_DEPTH = 32;

/**
 * UTF-8 bytes in one name, the root's included. Linux filesystems hold 255
 * bytes and APFS 255 UTF-16 units; a name within 255 UTF-8 bytes fits both.
 */
export const FOLDER_UPLOAD_MAX_NAME_BYTES = 255;

/**
 * UTF-8 bytes in a root-prefixed relative path, without a folder's trailing
 * `/`. macOS refuses any path past 1,024 bytes (`PATH_MAX`), and the folder
 * lands below the host inbox (`<tmpdir>/daintree-inbox/files/<stamp>-<id>/`,
 * about 100 bytes on a Mac), so this leaves room for that prefix and staging.
 */
export const FOLDER_UPLOAD_MAX_PATH_BYTES = 768;

/**
 * The stored archive's own ceiling: the content limit plus room for its
 * headers. Each of at most 10,001 entries costs under 1,800 bytes of local
 * header, central record and data descriptor at the longest path.
 */
export const FOLDER_UPLOAD_MAX_ARCHIVE_BYTES = FOLDER_UPLOAD_MAX_BYTES + 32 * 1024 * 1024;

/** The paths a problem names: enough to point at the cause without listing a whole tree. */
export const FOLDER_UPLOAD_MAX_PROBLEM_PATHS = 10;

export const FOLDER_UPLOAD_LIMITS = [
  "files",
  "folders",
  "bytes",
  "archive-bytes",
  "depth",
  "name-bytes",
  "path-bytes",
] as const;
export type FolderUploadLimit = (typeof FOLDER_UPLOAD_LIMITS)[number];

/**
 * Why a path can't be carried. Hosts are macOS or Linux, so names only
 * Windows refuses are kept: a backslash is refused because Windows reads it
 * as a separator, but `:` and Windows device names such as `aux.c` are not.
 */
export const FOLDER_UPLOAD_PATH_PROBLEMS = [
  /** The path or one of its components is empty (`a//b`). */
  "empty-name",
  /** A `.` or `..` component. */
  "dot-name",
  /** A backslash anywhere, or a `/` inside a single name. */
  "separator",
  /** C0 or C1 control characters, NUL and DEL included. */
  "control-character",
  /** An unpaired UTF-16 surrogate, which has no UTF-8 spelling. */
  "malformed-unicode",
  "absolute",
  /** `C:/x`, `C:x` and the like. */
  "drive-letter",
  /** The first component isn't the root, or a file stands where the root is. */
  "outside-root",
  /** A folder without its trailing `/`, or a file with one. */
  "entry-form",
] as const;
export type FolderUploadPathProblem = (typeof FOLDER_UPLOAD_PATH_PROBLEMS)[number];

/**
 * Why a folder can't be sent as it is. Every variant names the paths
 * responsible, each in the archive's root-prefixed form.
 */
export type FolderUploadProblem =
  | {
      kind: "limit";
      limit: FolderUploadLimit;
      maximum: number;
      /** What was counted when the limit was crossed: never clamped to the maximum. */
      actual: number;
      /**
       * The entries over a depth or length limit; for a count or size limit,
       * the largest contributors to it. Empty when the host only had counts.
       */
      paths: string[];
    }
  /**
   * Two names a case-insensitive disk would merge (`foldFileName`), or the
   * same name twice. A file and a folder count alike, as does a file named as
   * another entry's parent.
   */
  | { kind: "clash"; paths: [string, string] }
  | { kind: "path"; problem: FolderUploadPathProblem; path: string };

/** What a folder holds, as both sides count it. */
export interface FolderUploadTotals {
  /** Regular files, empty ones included. */
  fileCount: number;
  /** Folders below the root. */
  folderCount: number;
  /** Bytes of file content, archive headers not included. */
  totalBytes: number;
}

/** The most entries a folder summary lists in each of its lists. */
export const FOLDER_UPLOAD_SUMMARY_MAX_ITEMS = 20;
