import type { ConflictedFileEntry } from "../../../shared/types/git.js";

export const CONFLICT_LABELS: Record<string, string> = {
  UU: "both modified",
  AA: "both added",
  DD: "both deleted",
  AU: "added by us",
  UA: "added by them",
  DU: "deleted by us",
  UD: "deleted by them",
};

/**
 * `-z` is load-bearing: without it git C-quotes paths containing a tab, double
 * quote, newline or backslash even under core.quotepath=false.
 */
export const PORCELAIN_V2_CONFLICT_ARGS = [
  "-c",
  "core.quotepath=false",
  "status",
  "--porcelain=v2",
  "-z",
];

// "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
const UNMERGED_FIELDS_BEFORE_PATH = 10;

/** Parses `git status --porcelain=v2 -z`, keeping only unmerged records. */
export function parsePorcelainV2Conflicts(raw: string): ConflictedFileEntry[] {
  const records = raw.split("\0");
  const entries: ConflictedFileEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    // Rename/copy records carry their original path as the next NUL token.
    if (record.startsWith("2 ")) {
      i++;
      continue;
    }
    if (!record.startsWith("u ")) continue;
    let pathStart = 0;
    for (let field = 0; field < UNMERGED_FIELDS_BEFORE_PATH && pathStart !== -1; field++) {
      pathStart = record.indexOf(" ", pathStart);
      if (pathStart !== -1) pathStart++;
    }
    if (pathStart === -1) continue;
    const filePath = record.slice(pathStart);
    if (!filePath) continue;
    const xy = record.slice(2, record.indexOf(" ", 2));
    entries.push({
      path: filePath,
      xy,
      label: CONFLICT_LABELS[xy] ?? xy,
    });
  }
  return entries;
}
