import type { SimpleGit } from "simple-git";
import { readBlobs, readBlobSizes } from "./catFileBatch.js";

export const STAGED_FILE_SIZE_CAP = 1_000_000;

// Bounds what one `cat-file --batch` holds in memory at once.
const BATCH_READ_BYTES = 16 * STAGED_FILE_SIZE_CAP;

const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const SPACE = 0x20;
const MIN_MARKER_LENGTH = 7;

// Only the markers git writes at a region's edges: the opener, the diff3 base,
// and the closer. The `=======` divider is left out on purpose: alone it is a
// Setext heading underline or a text separator in ordinary Markdown and plain
// text, and a real region always carries an opener the scan reports first.
const OPENER = 0x3c; // <
const MARKER_BYTES = new Set([
  OPENER,
  0x7c, // |
  0x3e, // >
]);

const UTF8_BOM = [0xef, 0xbb, 0xbf];

// Gitlinks (160000) name a submodule commit rather than a blob, so `cat-file`
// can't read them as one; deletions and unmerged entries (000000) have no stage-0
// blob to read, and `git commit` refuses the latter on its own.
const BLOB_MODES = new Set(["100644", "100755", "120000"]);

// `--no-relative` overrides `diff.relative`, which would otherwise drop files
// outside a subdirectory cwd.
const STAGED_DIFF_ARGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--cached",
  "--no-renames",
  "--no-relative",
  "-z",
];

// `--raw -z` emits `:<src mode> <dst mode> <src oid> <dst oid> <status>` and the
// path as separate NUL-terminated fields; `--no-renames` keeps it to one path
// and `--no-abbrev` gives the index blob's full id to read it by.
interface StagedBlob {
  path: string;
  oid: string;
}

function parseStagedBlobs(raw: string): StagedBlob[] {
  const blobs: StagedBlob[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const header = fields[i];
    if (!header.startsWith(":")) break;
    const [, dstMode, , dstOid] = header.slice(1).split(" ");
    const filePath = fields[i + 1];
    if (filePath && dstOid && BLOB_MODES.has(dstMode)) blobs.push({ path: filePath, oid: dstOid });
  }
  return blobs;
}

// Numstat binary paths: binary diffs report tab-separated `-` placeholders.
function parseBinaryPathsFromNumstat(raw: string): Set<string> {
  const binary = new Set<string>();
  for (const record of raw.split("\0")) {
    if (record.startsWith("-\t-\t")) binary.add(record.slice(4));
  }
  return binary;
}

// A run of at least seven marker characters at the start of a line, then
// whitespace or the end of the line. Git writes seven, but widens them for some
// merges (eight for a rename/rename content conflict) and to any width a
// `conflict-marker-size` attribute names, so the width is a floor. Text glued to
// the run (`<<<<<<<HEAD`) is not one: git always separates its label.
function isMarkerLineAt(blob: Buffer, start: number): boolean {
  const first = blob[start];
  if (!MARKER_BYTES.has(first)) return false;
  let end = start + 1;
  while (blob[end] === first) end++;
  if (end - start < MIN_MARKER_LENGTH) return false;
  const after = blob[end];
  return after === undefined || after === SPACE || after === TAB || after === CR || after === LF;
}

// Walks the raw bytes, so a megabyte blob is never decoded or split into lines.
function findFirstConflictMarkerLine(blob: Buffer): number | null {
  let start = UTF8_BOM.every((byte, i) => blob[i] === byte) ? UTF8_BOM.length : 0;
  let line = 1;
  while (start < blob.length) {
    if (isMarkerLineAt(blob, start)) return line;
    const lineEnd = blob.indexOf(LF, start);
    if (lineEnd === -1) return null;
    start = lineEnd + 1;
    line++;
  }
  return null;
}

export interface ConflictMarkerTextScan {
  /** Opening `<<<<<<<` lines: one per conflict region. */
  hunkCount: number;
  /** Any marker line at all, so a region whose opener was edited away still counts. */
  hasMarkers: boolean;
  /** 1-based line of the first marker of any kind, `null` when there is none. */
  firstMarkerLine: number | null;
}

/**
 * Reads conflict markers the way the commit scan does. The region count and
 * whether the file is safe to stage are separate answers: deleting a region's
 * opener leaves its closer behind with no region left to count.
 */
export function scanConflictMarkerText(content: Buffer | string): ConflictMarkerTextScan {
  const blob = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const bodyStart = UTF8_BOM.every((byte, i) => blob[i] === byte) ? UTF8_BOM.length : 0;
  let start = bodyStart;
  let hunkCount = 0;
  let firstStart = -1;
  while (start < blob.length) {
    if (isMarkerLineAt(blob, start)) {
      if (firstStart === -1) firstStart = start;
      if (blob[start] === OPENER) hunkCount++;
    }
    const lineEnd = blob.indexOf(LF, start);
    if (lineEnd === -1) break;
    start = lineEnd + 1;
  }
  if (firstStart === -1) return { hunkCount: 0, hasMarkers: false, firstMarkerLine: null };
  // Markers only follow an LF, as git splits lines, but editors also end a line
  // at a bare CR; CRLF is one break.
  let firstMarkerLine = 1;
  for (let i = bodyStart; i < firstStart; i++) {
    const byte = blob[i];
    if (byte === LF || (byte === CR && blob[i + 1] !== LF)) firstMarkerLine++;
  }
  return { hunkCount, hasMarkers: true, firstMarkerLine };
}

function assertNoConflictMarkers(filePath: string, blob: Buffer): void {
  const line = findFirstConflictMarkerLine(blob);
  if (line !== null) {
    throw new Error(
      `Unresolved conflict markers found in ${filePath} (line ${line}). Resolve all conflicts before committing.`
    );
  }
}

/**
 * Rejects when a staged text blob of at most `STAGED_FILE_SIZE_CAP` bytes
 * carries a conflict opener, base, or closer marker line. Blobs are sized first, so one past the cap is
 * never read, and the rest are read in a few `cat-file --batch` runs bounded by
 * total bytes rather than one process per file. `cwd` is where `git` runs.
 */
export async function scanStagedFilesForConflictMarkers(
  git: Pick<SimpleGit, "diff">,
  cwd: string
): Promise<void> {
  const candidates = parseStagedBlobs(
    await git.diff([...STAGED_DIFF_ARGS, "--raw", "--no-abbrev"])
  );
  if (candidates.length === 0) return;

  const numstatRaw = await git.diff([...STAGED_DIFF_ARGS, "--numstat"]);
  const binaryPaths = parseBinaryPathsFromNumstat(numstatRaw);
  const textual = candidates.filter((blob) => !binaryPaths.has(blob.path));
  if (textual.length === 0) return;

  // Sized first, so a blob past the cap is never read at all.
  const sizes = await readBlobSizes(
    cwd,
    textual.map((blob) => blob.oid)
  );

  let batch = new Map<string, number>();
  let batchBytes = 0;
  let pending: StagedBlob[] = [];
  const flush = async (): Promise<void> => {
    const contents = await readBlobs(cwd, batch);
    for (const blob of pending) assertNoConflictMarkers(blob.path, contents.get(blob.oid)!);
    batch = new Map();
    batchBytes = 0;
    pending = [];
  };
  for (const blob of textual) {
    const size = sizes.get(blob.oid)!;
    if (size > STAGED_FILE_SIZE_CAP) continue;
    if (!batch.has(blob.oid)) {
      if (batch.size > 0 && batchBytes + size > BATCH_READ_BYTES) await flush();
      batch.set(blob.oid, size);
      batchBytes += size;
    }
    pending.push(blob);
  }
  if (pending.length > 0) await flush();
}
