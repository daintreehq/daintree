import type { SimpleGit } from "simple-git";
import { readBlobs, readBlobSizes } from "./catFileBatch.js";

export const STAGED_FILE_SIZE_CAP = 1_000_000;

// Bounds what one `cat-file --batch` holds in memory at once.
const BATCH_READ_BYTES = 16 * STAGED_FILE_SIZE_CAP;

const CONFLICT_MARKER_RE = /^(?:<{7}|\|{7}|={7}|>{7})[ \t\r]?/m;

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

function assertNoConflictMarkers(filePath: string, blob: Buffer): void {
  const content = blob.toString("utf8");
  const probe = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (CONFLICT_MARKER_RE.test(probe)) {
    throw new Error(
      `Unresolved conflict markers found in ${filePath}. Resolve all conflicts before committing.`
    );
  }
}

/**
 * Rejects when a staged text blob of at most `STAGED_FILE_SIZE_CAP` bytes
 * carries a conflict marker line. Blobs are sized first, so one past the cap is
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
