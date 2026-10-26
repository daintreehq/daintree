/**
 * Parsers for the NUL-separated (`-z`) records a review point is built from.
 *
 * Paths stay `Buffer`s: with `-z` git writes them verbatim, and any decoding
 * here would be the lossy step the byte-level spawn exists to avoid.
 */

const SPACE = 0x20;
const NUL = 0x00;

function splitNul(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== NUL) continue;
    records.push(output.subarray(start, i));
    start = i + 1;
  }
  if (start < output.length) records.push(output.subarray(start));
  return records;
}

/** The first `count` space-separated fields as text, and the bytes after them. */
function splitFields(record: Buffer, count: number): { fields: string[]; rest: Buffer } | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < record.length && fields.length < count; i++) {
    if (record[i] !== SPACE) continue;
    fields.push(record.toString("latin1", start, i));
    start = i + 1;
  }
  if (fields.length < count) return null;
  return { fields, rest: record.subarray(start) };
}

export interface StatusChangedRecord {
  kind: "changed";
  /** Index status then worktree status, `.` for unchanged. */
  xy: string;
  /** `N...` for a non-submodule, else `S<c><m><u>`. */
  sub: string;
  modeHead: string;
  modeIndex: string;
  modeWorktree: string;
  oidHead: string;
  oidIndex: string;
  path: Buffer;
}

export interface StatusUnmergedRecord {
  kind: "unmerged";
  xy: string;
  sub: string;
  stages: Array<{ stage: 1 | 2 | 3; mode: string; oid: string }>;
  modeWorktree: string;
  path: Buffer;
}

export interface StatusUntrackedRecord {
  kind: "untracked";
  path: Buffer;
}

export type StatusRecord = StatusChangedRecord | StatusUnmergedRecord | StatusUntrackedRecord;

export interface ParsedStatus {
  /** `# branch.oid`: the HEAD commit, or `null` on an unborn branch. */
  headOid: string | null;
  /** `# branch.head`: the branch name, or `null` when detached. */
  headBranch: string | null;
  records: StatusRecord[];
}

/**
 * `git status --porcelain=v2 -z --branch`.
 *
 * Throws on anything it does not recognise: a record misread here becomes a
 * path the review point silently fails to cover.
 */
export function parsePorcelainV2(output: Buffer): ParsedStatus {
  const parts = splitNul(output);
  let headOid: string | null = null;
  let headBranch: string | null = null;
  let sawHeadOid = false;
  let sawHeadBranch = false;
  const records: StatusRecord[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length === 0) continue;
    const tag = String.fromCharCode(part[0]);

    if (tag === "#") {
      const header = part.toString("utf8");
      if (header.startsWith("# branch.oid ")) {
        const value = header.slice("# branch.oid ".length);
        headOid = value === "(initial)" ? null : value;
        sawHeadOid = true;
      } else if (header.startsWith("# branch.head ")) {
        const value = header.slice("# branch.head ".length);
        headBranch = value === "(detached)" ? null : value;
        sawHeadBranch = true;
      }
      continue;
    }

    if (tag === "1") {
      const split = splitFields(part, 8);
      if (!split) throw new Error("Malformed status record");
      const [, xy, sub, modeHead, modeIndex, modeWorktree, oidHead, oidIndex] = split.fields;
      records.push({
        kind: "changed",
        xy,
        sub,
        modeHead,
        modeIndex,
        modeWorktree,
        oidHead,
        oidIndex,
        path: split.rest,
      });
      continue;
    }

    if (tag === "u") {
      const split = splitFields(part, 10);
      if (!split) throw new Error("Malformed status record");
      const [, xy, sub, m1, m2, m3, modeWorktree, h1, h2, h3] = split.fields;
      const stages: StatusUnmergedRecord["stages"] = [];
      if (!/^0+$/.test(m1)) stages.push({ stage: 1, mode: m1, oid: h1 });
      if (!/^0+$/.test(m2)) stages.push({ stage: 2, mode: m2, oid: h2 });
      if (!/^0+$/.test(m3)) stages.push({ stage: 3, mode: m3, oid: h3 });
      records.push({ kind: "unmerged", xy, sub, stages, modeWorktree, path: split.rest });
      continue;
    }

    if (tag === "?") {
      if (part.length < 3 || part[1] !== SPACE) throw new Error("Malformed status record");
      records.push({ kind: "untracked", path: part.subarray(2) });
      continue;
    }

    // `2` (rename) cannot appear under `--no-renames` and `!` (ignored) is
    // never requested, so either one means the command was not the one this
    // parser was written for.
    throw new Error("Unrecognised status record");
  }

  if (!sawHeadOid || !sawHeadBranch) throw new Error("Status output had no branch headers");
  return { headOid, headBranch, records };
}

export interface TreeDiffRecord {
  srcMode: string;
  dstMode: string;
  srcOid: string;
  dstOid: string;
  status: string;
  path: Buffer;
}

/**
 * `git diff-tree -r -z --no-renames <a> <b>` in raw format. Plumbing never
 * detects renames unless asked, so every record names exactly one path.
 */
export function parseDiffTreeRaw(output: Buffer): TreeDiffRecord[] {
  const parts = splitNul(output);
  const records: TreeDiffRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const header = parts[i];
    if (header.length === 0) continue;
    const fields = header[0] === 0x3a ? header.toString("latin1").slice(1).split(" ") : [];
    const path = parts[i + 1];
    if (fields.length !== 5 || path === undefined || !/^[ADMT]$/.test(fields[4])) {
      throw new Error("Malformed tree diff record");
    }
    i++;
    const [srcMode, dstMode, srcOid, dstOid, status] = fields;
    records.push({ srcMode, dstMode, srcOid, dstOid, status, path });
  }
  return records;
}

export interface IndexListingRecord {
  /** `-v` tag: lowercase is assume-unchanged, `S`/`s` skip-worktree, `M` unmerged. */
  tag: string;
  mode: string;
  oid: string;
  stage: number;
  path: Buffer;
}

/** `git ls-files -s -v -z`: `<tag> <mode> <oid> <stage>\t<path>`. */
export function parseIndexListing(output: Buffer): IndexListingRecord[] {
  const records: IndexListingRecord[] = [];
  for (const record of splitNul(output)) {
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    const fields = tab > 0 ? record.toString("latin1", 0, tab).split(" ") : [];
    if (fields.length !== 4 || !/^[0-3]$/.test(fields[3])) {
      throw new Error("Malformed index record");
    }
    const [tag, mode, oid, stage] = fields;
    records.push({ tag, mode, oid, stage: Number(stage), path: record.subarray(tab + 1) });
  }
  return records;
}

/**
 * `git config -z --get-regexp`: `<key>\n<value>`, or a bare `<key>` for a
 * value-less boolean. Section and variable names come back lowercased;
 * subsection names keep their case.
 */
export function parseConfigListing(output: Buffer): Array<{ key: string; value: string | null }> {
  const entries: Array<{ key: string; value: string | null }> = [];
  for (const record of splitNul(output)) {
    if (record.length === 0) continue;
    const text = record.toString("utf8");
    const newline = text.indexOf("\n");
    entries.push(
      newline === -1
        ? { key: text, value: null }
        : { key: text.slice(0, newline), value: text.slice(newline + 1) }
    );
  }
  return entries;
}
