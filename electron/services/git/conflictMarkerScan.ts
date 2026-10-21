import type { SimpleGit } from "simple-git";

export const STAGED_FILE_SIZE_CAP = 1_000_000;

const CONFLICT_MARKER_RE = /^(?:<{7}|\|{7}|={7}|>{7})[ \t\r]?/m;

// Gitlinks (160000) name a submodule commit rather than a blob, so `cat-file
// blob` rejects them; deletions and unmerged entries (000000) have no stage-0
// blob to read, and `git commit` refuses the latter on its own.
const BLOB_MODES = new Set(["100644", "100755", "120000"]);

// `--no-relative` overrides `diff.relative`, which would otherwise drop files
// outside a subdirectory cwd and print paths `cat-file :path` can't resolve.
const STAGED_DIFF_ARGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--cached",
  "--no-renames",
  "--no-relative",
  "-z",
];

// `--raw -z` emits `:<src mode> <dst mode> <src oid> <dst oid> <status>` and the
// path as separate NUL-terminated fields; `--no-renames` keeps it to one path.
function parseStagedBlobPaths(raw: string): string[] {
  const paths: string[] = [];
  const fields = raw.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const header = fields[i];
    if (!header.startsWith(":")) break;
    const dstMode = header.slice(1).split(" ")[1];
    const filePath = fields[i + 1];
    if (filePath && BLOB_MODES.has(dstMode)) paths.push(filePath);
  }
  return paths;
}

// Numstat binary paths: binary diffs report tab-separated `-` placeholders.
function parseBinaryPathsFromNumstat(raw: string): Set<string> {
  const binary = new Set<string>();
  for (const record of raw.split("\0")) {
    if (record.startsWith("-\t-\t")) binary.add(record.slice(4));
  }
  return binary;
}

export async function scanStagedFilesForConflictMarkers(git: SimpleGit): Promise<void> {
  const candidates = parseStagedBlobPaths(await git.diff([...STAGED_DIFF_ARGS, "--raw"]));
  if (candidates.length === 0) return;

  const numstatRaw = await git.diff([...STAGED_DIFF_ARGS, "--numstat"]);
  const binaryPaths = parseBinaryPathsFromNumstat(numstatRaw);

  for (const filePath of candidates) {
    if (binaryPaths.has(filePath)) continue;
    const content = await git.raw(["cat-file", "blob", "--end-of-options", `:${filePath}`]);
    if (typeof content !== "string") continue;
    if (Buffer.byteLength(content, "utf8") > STAGED_FILE_SIZE_CAP) continue;
    const probe = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    if (CONFLICT_MARKER_RE.test(probe)) {
      throw new Error(
        `Unresolved conflict markers found in ${filePath}. Resolve all conflicts before committing.`
      );
    }
  }
}
