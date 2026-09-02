import { readFile, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import type {
  SubmoduleAtRiskCommit,
  SubmoduleDeleteRisk,
  SubmoduleEntry,
  SubmoduleState,
} from "../../shared/types/submodule.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { createHardenedGit } from "./hardenedGit.js";
import { logDebug } from "./logger.js";
import { withTimeout } from "./withTimeout.js";

/**
 * Read-only submodule inventory for a worktree, at depth 1.
 *
 * Nothing here mutates. In particular `git submodule deinit` is never run: in a
 * linked worktree it strips `[submodule "..."]` from the SHARED `.git/config`,
 * unregistering the module for every other worktree of the repository.
 *
 * The roster authority is the parent index (mode `160000` entries), never
 * `.gitmodules` — a gitlink with no stanza is malformed but still a real
 * repository holding real work, and a stanza with no gitlink is stale config.
 * `.gitmodules` supplies name, URL and policy only.
 */

const GITLINK_MODE = "160000";

/** Per git invocation. A safety probe must not hang the delete confirmation. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** `stat`/`readFile`/`readdir` take no AbortSignal, so they are raced instead. */
const FS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Preview caps. Generous on purpose: the D2 rule requires the delete preview to
 * show real nested content, and a silently short list reads as complete. Both
 * sit far above any list a human will read, so hitting one means the inventory
 * genuinely could not be presented — which is why truncation sets `incomplete`.
 */
const DEFAULT_MAX_FILES_PER_MODULE = 1000;
const DEFAULT_MAX_FILES_TOTAL = 5000;

/**
 * At-risk commits are a *sample*, not an exhaustive list — the existence of one
 * unpushed commit is already the maximal signal, so hitting this bound is not
 * incompleteness.
 */
const DEFAULT_MAX_AT_RISK_COMMITS = 50;

/** `gitdir:` pointers can in principle chain; bound the walk rather than trust it. */
const MAX_GITDIR_HOPS = 4;

/** Field separator inside the at-risk commit `--format`; cannot occur in a subject. */
const UNIT_SEPARATOR = "\u001f";

/** Errno values that mean "definitively not there", as opposed to "cannot tell". */
const MISSING_ERRNO = new Set(["ENOENT", "ENOTDIR"]);

/** Every tree-entry mode git emits is six octal digits. */
const OCTAL_MODE = /^[0-7]{6}$/;

/** SHA-1 (40) through SHA-256 (64). Deliberately not a fixed width. */
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** Porcelain v2 field 3: `N...` for an ordinary path, `S<c><m><u>` for a gitlink. */
const SUB_STATE_FIELD = /^(N\.\.\.|S[C.][M.][U.])$/;

/**
 * Raised when git's own output does not match the framing it documents.
 *
 * Skipping an unparsable record is the wrong move for a safety gate: the
 * records are positional, so one corrupt record means every record after it is
 * suspect, and a parser that quietly drops them hands the caller a SHORT list
 * that looks complete. Every parse here therefore rejects the whole output, and
 * every call site turns that rejection into `incomplete`.
 */
export class MalformedGitOutputError extends Error {
  constructor(source: string, detail: string) {
    super(`malformed \`git ${source}\` output: ${detail}`);
    this.name = "MalformedGitOutputError";
  }
}

/**
 * Split `-z` output into records.
 *
 * NUL is a TERMINATOR, not a separator, so well-formed output either is empty
 * or ends with one. A trailing partial record is the signature of output that
 * was cut short — a truncated pipe, a killed process, a `2` header sitting at
 * the buffer edge — and must never be parsed as if it were whole.
 */
function splitNulRecords(stdout: string, source: string): string[] {
  if (stdout === "") return [];
  if (!stdout.endsWith("\0")) {
    throw new MalformedGitOutputError(source, "output does not end in NUL");
  }
  const records = stdout.slice(0, -1).split("\0");
  for (const record of records) {
    if (!record) throw new MalformedGitOutputError(source, "empty record");
  }
  return records;
}

export interface IndexGitlink {
  path: string;
  oid: string;
  /** 0 for a resolved entry; 1/2/3 for base/ours/theirs during a merge conflict. */
  stage: number;
}

export interface SubmoduleSubState {
  /** v2 `SC..` — the submodule HEAD is off the OID the parent records. */
  commitChanged: boolean;
  /** v2 `S.M.` — modified tracked content in the submodule working tree. */
  modifiedContent: boolean;
  /** v2 `S..U` — untracked content in the submodule working tree. */
  untrackedContent: boolean;
  /** The record was an unmerged (`u`) one, so the gitlink itself is conflicted. */
  conflicted: boolean;
}

export interface GitmodulesStanza {
  path?: string;
  url?: string;
  branch?: string;
  ignore?: string;
  shallow?: string;
  update?: string;
}

export interface SubmoduleDeleteRiskOptions {
  signal?: AbortSignal;
  /** Bound applied to every git invocation individually. */
  timeoutMs?: number;
  maxFilesPerModule?: number;
  maxFilesTotal?: number;
  maxAtRiskCommits?: number;
}

/**
 * Parse `git ls-files --stage -z` into its gitlink entries.
 *
 * Records are `<mode> <oid> <stage>\t<path>`. The tab is the only safe
 * separator: `-z` emits the path literally, so it may itself contain spaces,
 * tabs, newlines and backslashes — but the metadata before the FIRST tab never
 * does. All conflict stages are preserved; a path present at stages 1/2/3 is a
 * conflicted gitlink and the caller needs every stage to say so.
 *
 * Throws `MalformedGitOutputError` rather than skipping a record it cannot
 * read: the roster is the authority for the whole inventory, so a partial
 * roster is indistinguishable from a repository with fewer submodules.
 */
export function parseIndexGitlinks(stdout: string): IndexGitlink[] {
  const source = "ls-files";
  const out: IndexGitlink[] = [];
  for (const record of splitNulRecords(stdout, source)) {
    const tab = record.indexOf("\t");
    if (tab === -1) throw new MalformedGitOutputError(source, "record has no tab separator");
    const meta = record.slice(0, tab).split(" ");
    if (meta.length !== 3 || !OCTAL_MODE.test(meta[0]) || !OBJECT_ID.test(meta[1])) {
      throw new MalformedGitOutputError(source, "unreadable entry metadata");
    }
    const stage = Number.parseInt(meta[2], 10);
    if (!Number.isInteger(stage) || stage < 0 || stage > 3) {
      throw new MalformedGitOutputError(source, `stage out of range: ${meta[2]}`);
    }
    const entryPath = record.slice(tab + 1);
    if (!entryPath) throw new MalformedGitOutputError(source, "record has no path");
    // Blobs and trees are not malformed, just not gitlinks.
    if (meta[0] !== GITLINK_MODE) continue;
    out.push({ path: entryPath, oid: meta[1], stage });
  }
  return out;
}

/**
 * Parse `git ls-tree -r -z <rev>` into its gitlink entries (path → OID).
 *
 * Same tab framing as the index listing, but the metadata is
 * `<mode> <type> <oid>`.
 */
export function parseTreeGitlinks(stdout: string): Map<string, string> {
  const source = "ls-tree";
  const out = new Map<string, string>();
  for (const record of splitNulRecords(stdout, source)) {
    const tab = record.indexOf("\t");
    if (tab === -1) throw new MalformedGitOutputError(source, "record has no tab separator");
    const meta = record.slice(0, tab).split(" ");
    if (meta.length !== 3 || !OCTAL_MODE.test(meta[0]) || !OBJECT_ID.test(meta[2])) {
      throw new MalformedGitOutputError(source, "unreadable entry metadata");
    }
    const entryPath = record.slice(tab + 1);
    if (!entryPath) throw new MalformedGitOutputError(source, "record has no path");
    if (meta[0] !== GITLINK_MODE) continue;
    out.set(entryPath, meta[2]);
  }
  return out;
}

interface StatusRecord {
  kind: "1" | "2" | "u" | "?" | "!";
  fields: string[];
  path: string;
}

/**
 * Walk NUL-framed `git status --porcelain=v2 -z` output.
 *
 * The framing trap is the `2` (rename/copy) record: its path field is TWO
 * NUL-separated values, `<path>` then `<origPath>`. Consuming only the first
 * leaves the origin path to be read as the next record header, desynchronising
 * every record after it — a rename anywhere in the parent would silently
 * corrupt the submodule sub-states that follow.
 *
 * A record that does not parse rejects the WHOLE output. Skipping it and
 * carrying on cannot be right here: the `2` framing means position is state, so
 * one unreadable record makes every following record's identity a guess — and a
 * guessed-short list of at-risk files reads exactly like a clean one.
 */
function* iterateStatusRecords(stdout: string): Generator<StatusRecord> {
  const source = "status";
  const tokens = splitNulRecords(stdout, source);
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    // `#` header lines (`# branch.oid <oid>`) carry no path.
    if (record[0] === "#") continue;
    if (record[1] !== " ") {
      throw new MalformedGitOutputError(source, `unreadable record header: ${headOf(record)}`);
    }
    const kind = record[0];
    let leadingFields: number;
    switch (kind) {
      case "1":
        leadingFields = 8;
        break;
      case "2":
        leadingFields = 9;
        break;
      case "u":
        leadingFields = 10;
        break;
      case "?":
      case "!":
        leadingFields = 1;
        break;
      default:
        throw new MalformedGitOutputError(source, `unknown record kind: ${headOf(record)}`);
    }
    const split = splitLeadingFields(record, leadingFields);
    if (!split) {
      throw new MalformedGitOutputError(source, `truncated \`${kind}\` record: ${headOf(record)}`);
    }
    if (kind === "2") {
      // The rename origin is its own NUL-terminated token. A `2` header sitting
      // at the buffer edge has none, which means the output was cut mid-record.
      if (!tokens[i + 1]) {
        throw new MalformedGitOutputError(source, "rename record has no origin path");
      }
      i += 1;
    }
    yield { kind, fields: split.fields, path: split.rest };
  }
}

/** A bounded prefix of a record, for error messages. */
function headOf(record: string): string {
  return JSON.stringify(record.length > 40 ? `${record.slice(0, 40)}…` : record);
}

/**
 * Split exactly `count` space-delimited leading fields off a record, returning
 * the remainder verbatim. Index-based rather than `split(" ")` so a path that
 * contains (or starts with) a space survives intact.
 */
function splitLeadingFields(
  record: string,
  count: number
): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let f = 0; f < count; f++) {
    const space = record.indexOf(" ", start);
    if (space === -1) return null;
    fields.push(record.slice(start, space));
    start = space + 1;
  }
  const rest = record.slice(start);
  return rest ? { fields, rest } : null;
}

/**
 * Extract the per-submodule `S<c><m><u>` sub-state from porcelain v2 output.
 *
 * The sub-state is field 3 (index 2) of `1`, `2` and `u` records alike. A
 * non-submodule entry carries `....` there and is skipped.
 *
 * Two facts the caller must not forget: a CLEAN submodule emits no record at
 * all, and an UNINITIALIZED one is invisible to status entirely — so this map
 * enriches a roster, it can never produce one.
 */
export function parseSubmoduleSubStates(stdout: string): Map<string, SubmoduleSubState> {
  const states = new Map<string, SubmoduleSubState>();
  for (const record of iterateStatusRecords(stdout)) {
    if (record.kind !== "1" && record.kind !== "2" && record.kind !== "u") continue;
    const sub = record.fields[2] ?? "";
    if (!SUB_STATE_FIELD.test(sub)) {
      throw new MalformedGitOutputError("status", `unreadable sub-state field: ${headOf(sub)}`);
    }
    if (sub[0] !== "S") continue;
    states.set(record.path, {
      commitChanged: sub[1] === "C",
      modifiedContent: sub[2] === "M",
      untrackedContent: sub[3] === "U",
      conflicted: record.kind === "u",
    });
  }
  return states;
}

/** Tracked-change and untracked paths from one repository's porcelain v2 output. */
function parseStatusPaths(stdout: string): { dirty: string[]; untracked: string[] } {
  const dirty: string[] = [];
  const untracked: string[] = [];
  for (const record of iterateStatusRecords(stdout)) {
    if (record.kind === "?") untracked.push(record.path);
    // An unmerged path is work in progress the delete would discard too.
    else if (record.kind !== "!") dirty.push(record.path);
  }
  return { dirty, untracked };
}

const GITMODULES_PROPERTIES = ["path", "url", "branch", "ignore", "shallow", "update"] as const;
type GitmodulesProperty = (typeof GITMODULES_PROPERTIES)[number];

/**
 * Parse NUL-framed `git config` output into `submodule.<name>` stanzas.
 *
 * Framing is `<key>\n<value>\0`, with a valueless key emitted bare. Accepts
 * `--list` and `--get-regexp` output alike; keys outside the `submodule.`
 * namespace are ignored. Submodule names routinely contain dots
 * (`vendor/lib.js`), so the property is taken from the LAST dot, never the
 * second.
 */
export function parseGitmodulesConfig(stdout: string): Map<string, GitmodulesStanza> {
  const prefix = "submodule.";
  const stanzas = new Map<string, GitmodulesStanza>();
  for (const record of splitNulRecords(stdout, "config")) {
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
    // Every key git emits is at least `<section>.<name>`; anything else means
    // the record boundaries have slipped.
    if (!key.includes(".")) {
      throw new MalformedGitOutputError("config", `unreadable key: ${headOf(key)}`);
    }
    if (!key.startsWith(prefix)) continue;
    const lastDot = key.lastIndexOf(".");
    if (lastDot <= prefix.length) continue;
    const property = key.slice(lastDot + 1).toLowerCase();
    if (!isGitmodulesProperty(property)) continue;
    const name = key.slice(prefix.length, lastDot);
    if (!name) continue;
    let stanza = stanzas.get(name);
    if (!stanza) {
      stanza = {};
      stanzas.set(name, stanza);
    }
    stanza[property] = value;
  }
  return stanzas;
}

function isGitmodulesProperty(value: string): value is GitmodulesProperty {
  return (GITMODULES_PROPERTIES as readonly string[]).includes(value);
}

/**
 * Resolve a submodule checkout's git directory, or `null` when it is not
 * initialized.
 *
 * Handles both layouts: the absorbed pointer FILE (`gitdir: <target>`, relative
 * or absolute, and relative to the checkout that holds it) and the old-form
 * embedded `.git` DIRECTORY. In a LINKED worktree the pointer lands in
 * `<common>/.git/worktrees/<id>/modules/<name>` — a per-worktree module with
 * its own object store and no `objects/info/alternates`, which is exactly why
 * work inside it is unrecoverable once the worktree is gone.
 *
 * Rejects (rather than answering `null`) when the filesystem could not answer
 * at all — a timeout or a permission error is an unknown, never an absence.
 */
export async function resolveModuleGitDir(
  worktreePath: string,
  submodulePath: string
): Promise<string | null> {
  const resolution = await inspectModuleGitDir(worktreePath, submodulePath);
  return resolution.kind === "resolved" ? resolution.gitDir : null;
}

/**
 * The three answers `resolveModuleGitDir` collapses into `null`.
 *
 * The collapse is what makes a nonempty, un-inspectable checkout look like an
 * empty one: "there is no `.git` here" and "the `.git` here is broken" both read
 * as `uninitialized`, and `uninitialized` is the one state where the inventory
 * skips file inspection entirely. An uninitialized submodule is also invisible
 * to the parent's `git status`, so nothing downstream can rescue the mistake.
 */
export type ModuleGitDirResolution =
  | { kind: "resolved"; gitDir: string }
  /** No `.git` entry in the checkout at all — never initialized, or deinit'd. */
  | { kind: "absent" }
  /** A `.git` entry exists but does not lead to a usable repository. */
  | { kind: "malformed"; reason: string };

export async function inspectModuleGitDir(
  worktreePath: string,
  submodulePath: string
): Promise<ModuleGitDirResolution> {
  const checkout = path.resolve(worktreePath, submodulePath);
  let pointer = path.join(checkout, ".git");
  for (let hop = 0; hop < MAX_GITDIR_HOPS; hop++) {
    const info = await statOrMissing(pointer);
    if (!info) {
      return hop === 0
        ? { kind: "absent" }
        : { kind: "malformed", reason: `gitdir pointer leads nowhere (${pointer})` };
    }
    if (info.isDirectory()) return { kind: "resolved", gitDir: pointer };
    if (!info.isFile()) {
      return { kind: "malformed", reason: "`.git` is neither a file nor a directory" };
    }
    const contents = await readFileOrMissing(pointer);
    const match = contents?.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match) return { kind: "malformed", reason: "`.git` file is not a gitdir pointer" };
    pointer = path.resolve(path.dirname(pointer), match[1]);
  }
  return { kind: "malformed", reason: "gitdir pointer chain too deep" };
}

/** One module git directory found under `<worktree gitdir>/modules`. */
interface ScannedModule {
  /**
   * The submodule's LOGICAL name — the path under `modules/`. It equals the
   * checkout path only by default convention; `git submodule add --name` breaks
   * that, so it must never be used as a repo path without being mapped first.
   */
  name: string;
  gitDir: string;
  /**
   * The directory holds a repository skeleton (`objects`/`refs`/`config`) but no
   * `HEAD`. Its objects die with the worktree exactly like a healthy store's, so
   * it is reported — it must never be walked into as if it were a namespace
   * directory holding modules.
   */
  malformed?: boolean;
  /**
   * The store holds its own `modules/` directory, so this submodule has nested
   * submodules whose object stores also live under this worktree's gitdir and
   * also die with it. The inventory is depth 1 and cannot enumerate them, so
   * the caller marks the answer incomplete rather than reporting it clean.
   */
  hasNestedModules?: boolean;
}

/**
 * Inventory the submodule work that deleting `worktreePath` would destroy.
 *
 * Strictly read-only, and never throws: an inventory that could not be
 * completed comes back with `incomplete: true` so callers stay on their
 * fail-closed branch. Reporting an empty risk for an unknown one is the single
 * failure mode this function must not have.
 */
export async function buildSubmoduleDeleteRisk(
  worktreePath: string,
  opts: SubmoduleDeleteRiskOptions = {}
): Promise<SubmoduleDeleteRisk> {
  const timeoutMs = clampCount(opts.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 1);
  const maxFilesPerModule = clampCount(opts.maxFilesPerModule, DEFAULT_MAX_FILES_PER_MODULE, 0);
  const maxFilesTotal = clampCount(opts.maxFilesTotal, DEFAULT_MAX_FILES_TOTAL, 0);
  const maxAtRiskCommits = clampCount(opts.maxAtRiskCommits, DEFAULT_MAX_AT_RISK_COMMITS, 1);
  const root = path.resolve(worktreePath);

  let incomplete = false;
  const markIncomplete = (reason: string, error?: unknown): void => {
    incomplete = true;
    logDebug(
      `Submodule inventory incomplete for ${root}: ${reason}` +
        (error === undefined ? "" : ` — ${formatErrorMessage(error, "unknown failure")}`)
    );
  };

  // `git worktree remove` refuses purely on the existence of this directory —
  // not on dirtiness, and not on the index gitlink. Resolved from the pointer
  // file rather than `rev-parse --git-dir` so the cheap path stays subprocess
  // free.
  let modulesDir: string | null = null;
  let hasModulesDir = false;
  try {
    const worktreeGitDir = await resolveWorktreeGitDir(root);
    if (worktreeGitDir) {
      modulesDir = path.join(worktreeGitDir, "modules");
      hasModulesDir = await isDirectory(modulesDir);
    }
  } catch (error) {
    markIncomplete("worktree git directory unreadable", error);
  }

  try {
    // A probe that cannot answer must never read as absence, so this is
    // deliberately compared against a definite `false` below.
    let hasGitmodulesFile: boolean | null = null;
    try {
      hasGitmodulesFile = await isFile(path.join(root, ".gitmodules"));
    } catch (error) {
      markIncomplete(".gitmodules unreadable", error);
    }

    const git = await createHardenedGit(root, opts.signal);

    let indexGitlinks: IndexGitlink[] = [];
    let indexRead = false;
    try {
      indexGitlinks = parseIndexGitlinks(
        await runGit(git, ["ls-files", "--stage", "-z"], timeoutMs)
      );
      indexRead = true;
    } catch (error) {
      markIncomplete("ls-files failed", error);
    }

    // Cost gate. A repository with no submodule signal whatsoever pays exactly
    // one `ls-files` plus two stats and stops. The two stats are what keep the
    // gate honest: a staged-away submodule has no index gitlink, yet its module
    // directory still holds commits that exist nowhere else, so gating on the
    // index alone would report "nothing at stake" for the orphan case this
    // whole type exists to catch.
    //
    // Residual gap, accepted deliberately: a nested repository that is
    // simultaneously absent from the index and has no `.gitmodules` stanza is
    // invisible here, because finding it would cost a `ls-tree HEAD` on every
    // submodule-free repository. That covers two layouts — an OLD-FORM embedded
    // `.git` directory (`git submodule add` has not produced one since git
    // 1.7.8), and a `.git` POINTER FILE aimed at a store somewhere other than
    // `<worktree gitdir>/modules`, which nothing in this repository creates but
    // a hand-run `git init --separate-git-dir` would.
    //
    // The gate also passes a gitlink that is in HEAD but staged away, with
    // `.gitmodules` deleted and the module never initialized — the HEAD roster
    // read is below it. That one is genuinely covered elsewhere rather than
    // merely accepted: with no index gitlink, no stanza and no nested `.git`,
    // the checkout is ordinary untracked content of the PARENT, which the
    // parent's own delete preview enumerates. The moment any of those three
    // exists the gate does not fire.
    if (
      indexRead &&
      !incomplete &&
      indexGitlinks.length === 0 &&
      !hasModulesDir &&
      hasGitmodulesFile === false
    ) {
      return emptyRisk();
    }

    const headGitlinks = await readHeadGitlinks(git, timeoutMs);
    if (!headGitlinks) markIncomplete("ls-tree HEAD failed");

    let stanzas = new Map<string, GitmodulesStanza>();
    if (hasGitmodulesFile !== false) {
      const parsed = await readGitmodulesStanzas(git, root, timeoutMs);
      if (parsed) stanzas = parsed;
      else markIncomplete(".gitmodules could not be read");
    }

    let scannedModules: ScannedModule[] = [];
    if (modulesDir && hasModulesDir) {
      const scanned = await collectModuleGitDirs(modulesDir);
      if (scanned) scannedModules = scanned;
      else markIncomplete("module directory scan failed");
    }

    let subStates = new Map<string, SubmoduleSubState>();
    try {
      subStates = parseSubmoduleSubStates(
        await runGit(
          git,
          [
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            // Mandatory. With `submodule.<name>.ignore = all` configured, the
            // submodule line vanishes from v2 output entirely and returns only
            // with this flag — without it, repository configuration silently
            // blinds the delete gate.
            "--ignore-submodules=none",
          ],
          timeoutMs
        )
      );
    } catch (error) {
      markIncomplete("parent status failed", error);
    }

    // The deletion roster is deliberately broader than a display roster: every
    // source that can EVIDENCE a nested repository, unioned, so orphans are
    // found rather than only the well-formed entries.
    //
    // A `.gitmodules` stanza is deliberately not such a source. It is tracked,
    // attacker-influenceable content in a cloned repository, and a stanza with
    // no gitlink and no module store is stale config naming a directory the
    // index never called a submodule — letting it create roster membership
    // points every probe below (stat, status, `log`) at a path of the config
    // author's choosing, which is the opposite of the index-authority contract.
    const rosterPaths = new Set<string>();
    for (const gitlink of indexGitlinks) rosterPaths.add(gitlink.path);
    for (const treePath of headGitlinks?.keys() ?? []) rosterPaths.add(treePath);

    // Git canonicalises paths independently of the caller. On macOS that is
    // commonly `/private/tmp/...` versus `/tmp/...`; on Windows it can be a
    // long temp path versus its 8.3 spelling. Comparing a store's
    // `core.worktree` against the lexical caller path therefore makes the same
    // checkout look external and turns an otherwise complete inventory into a
    // refusal. Resolve the root once and use that identity for both store
    // binding and the containment check below.
    let realRoot: string | null = null;
    if (rosterPaths.size > 0 || scannedModules.length > 0) {
      try {
        realRoot = await realpathOrMissing(root);
      } catch (error) {
        markIncomplete("worktree path could not be resolved", error);
      }
    }

    // A scanned module's directory name is its LOGICAL name, which only equals
    // the checkout path by default convention — `--name` decouples them. Bind
    // each one to a real path before it can enter the roster, and keep EVERY
    // store that lands on a given path rather than the last one seen: two
    // stores claiming one checkout means `worktree remove` deletes both, so
    // inventorying only one reports a clean risk for a repository that has one.
    const scannedByPath = new Map<string, ScannedModule[]>();
    const unboundStores: ScannedModule[] = [];
    /** Roster paths that came from a guess rather than the store's own claim. */
    const inferredBindings = new Set<string>();
    for (const module of scannedModules) {
      if (module.malformed) markIncomplete(`module store ${module.name} has no HEAD`);
      if (module.hasNestedModules) {
        markIncomplete(`module store ${module.name} holds nested submodules`);
      }
      const binding = await resolveModuleCheckoutPath(
        git,
        root,
        realRoot,
        module,
        stanzas,
        timeoutMs
      );
      if (binding.kind !== "bound") {
        markIncomplete(`module ${module.name}: ${binding.reason}`, binding.error);
        unboundStores.push(module);
        continue;
      }
      if (binding.conflict) markIncomplete(`module ${module.name}: ${binding.conflict}`);
      if (binding.inferred) inferredBindings.add(binding.checkoutPath);
      rosterPaths.add(binding.checkoutPath);
      const bucket = scannedByPath.get(binding.checkoutPath);
      if (bucket) bucket.push(module);
      else scannedByPath.set(binding.checkoutPath, [module]);
    }

    const entries: SubmoduleEntry[] = [];
    const dirtyFiles: string[] = [];
    const untrackedFiles: string[] = [];
    const atRiskCommits: SubmoduleAtRiskCommit[] = [];
    const seenAtRiskOids = new Set<string>();
    let collectedFiles = 0;

    const collectAtRisk = async (gitDir: string, label: string): Promise<void> => {
      const walk = await readAtRiskCommits(gitDir, opts.signal, timeoutMs, maxAtRiskCommits);
      if (!walk) {
        markIncomplete(`${label}: rev walk failed`);
        return;
      }
      // A capped walk is an undercount, and the preview states this list's
      // length as a fact ("N commits are on no remote..."). Reporting 50 when
      // there are 200 is the same class of lie as the single `M vendor/lib`
      // row this whole inventory exists to replace, so a walk that hit the
      // ceiling is incomplete rather than a shorter truth.
      if (walk.truncated) {
        markIncomplete(`${label}: more than ${maxAtRiskCommits} at-risk commits`);
      }
      for (const commit of walk.commits) {
        if (seenAtRiskOids.has(commit.oid)) continue;
        seenAtRiskOids.add(commit.oid);
        atRiskCommits.push(commit);
      }
    };

    for (const submodulePath of [...rosterPaths].sort()) {
      const stages = indexGitlinks.filter((gitlink) => gitlink.path === submodulePath);
      const subState = subStates.get(submodulePath);
      const conflicted = stages.some((stage) => stage.stage > 0) || subState?.conflicted === true;
      const recordedOid =
        stages.find((stage) => stage.stage === 0)?.oid ??
        // Stage 2 is "ours" — the closest thing to a recorded OID mid-conflict.
        stages.find((stage) => stage.stage === 2)?.oid ??
        headGitlinks?.get(submodulePath) ??
        "";

      const name = resolveStanzaName(stanzas, submodulePath);
      const stanza = name ? stanzas.get(name) : undefined;

      const checkoutDir = path.resolve(root, submodulePath);
      // Lexical containment is not enough. The checkout path — or any directory
      // above it — can be a symlink or junction pointing at an unrelated
      // repository, and every probe below would then read that repository's
      // files, refs and commit subjects and report them as this worktree's
      // at-risk work.
      const containment = await classifyCheckout(realRoot, checkoutDir);
      if (containment === "escaped") {
        markIncomplete(`${submodulePath}: checkout resolves outside the worktree`);
      } else if (containment === "unknown") {
        markIncomplete(`${submodulePath}: checkout could not be resolved`);
      }
      const checkoutUsable = containment === "contained" || containment === "absent";

      // A checkout deleted out from under an absorbed module leaves no pointer
      // to follow, but the module — and its objects — are still there, which is
      // what the scanned stores below cover.
      let pointerGitDir: string | null = null;
      if (checkoutUsable) {
        try {
          const resolution = await inspectModuleGitDir(root, submodulePath);
          if (resolution.kind === "resolved") pointerGitDir = resolution.gitDir;
          else if (resolution.kind === "malformed") {
            markIncomplete(`${submodulePath}: ${resolution.reason}`);
          }
        } catch (error) {
          markIncomplete(`${submodulePath}: git directory unreadable`, error);
        }
      }

      const candidateGitDirs: string[] = [];
      const candidateIdentities = new Set<string>();
      const addCandidate = async (dir: string): Promise<void> => {
        const resolved = path.resolve(dir);
        let identity = resolved;
        try {
          identity = (await realpathOrMissing(resolved)) ?? resolved;
        } catch (error) {
          markIncomplete(`${submodulePath}: module git directory could not be resolved`, error);
        }
        if (candidateIdentities.has(identity)) return;
        candidateIdentities.add(identity);
        candidateGitDirs.push(resolved);
      };
      if (pointerGitDir) await addCandidate(pointerGitDir);
      for (const module of scannedByPath.get(submodulePath) ?? [])
        await addCandidate(module.gitDir);
      if (candidateGitDirs.length > 1) {
        // Preferring the checkout's own pointer and dropping the rest is
        // precisely how a worktree-owned store gets skipped: `worktree remove`
        // deletes every store under the worktree gitdir, agreement or not.
        markIncomplete(
          `${submodulePath}: ${candidateGitDirs.length} module git directories claim this checkout`
        );
      }
      const moduleGitDir = candidateGitDirs[0] ?? null;

      let headOid: string | undefined;
      let branch: string | undefined;
      for (const [index, candidate] of candidateGitDirs.entries()) {
        const head = await readModuleHead(candidate, opts.signal, timeoutMs);
        if (!head) {
          markIncomplete(`${submodulePath}: HEAD unreadable in ${candidate}`);
          continue;
        }
        if (index === 0) {
          headOid = head.oid;
          branch = head.branch;
        }
        // Skipped without a HEAD: an unborn module has no commits to strand,
        // and the failed read above has already flagged the inventory.
        await collectAtRisk(candidate, submodulePath);
      }

      let state: SubmoduleState;
      if (conflicted) state = "conflicted";
      else if (!moduleGitDir) state = "uninitialized";
      else if (subState?.commitChanged || (headOid && headOid !== recordedOid)) {
        // An orphan has no recorded OID at all, so its HEAD is by definition not
        // at one. "moved" is the only honest member of the frozen union for it.
        state = "moved";
      } else state = "at-recorded-commit";

      let hasModifiedContent = subState?.modifiedContent ?? false;
      let hasUntrackedContent = subState?.untrackedContent ?? false;

      let checkoutExists = false;
      if (checkoutUsable) {
        try {
          const info = await statOrMissing(checkoutDir);
          checkoutExists = info?.isDirectory() === true;
          // A regular file (or a device, or a pipe) where a checkout belongs
          // holds content the delete takes, and neither inventory branch below
          // can read it: `<file>/.git` answers ENOTDIR, which reads as "no
          // metadata", and the file itself is never enumerated.
          if (info && !checkoutExists) {
            markIncomplete(`${submodulePath}: checkout is not a directory`);
          }
          // An inferred path that turns out to hold nothing is not evidence
          // that nothing is checked out. The store declared no `core.worktree`,
          // so this path came from `.gitmodules` or the directory name, and a
          // checkout moved elsewhere in the worktree keeps its `.git` pointer
          // to this store while never entering the roster — its dirty files
          // would go unread and the answer would still say complete.
          if (!info && inferredBindings.has(submodulePath)) {
            markIncomplete(`${submodulePath}: inferred checkout path is absent`);
          }
        } catch (error) {
          markIncomplete(`${submodulePath}: checkout unreadable`, error);
        }
      }

      let files: { dirty: string[]; untracked: string[] } | null = null;
      if (checkoutExists && moduleGitDir) {
        files = await readModuleFiles(moduleGitDir, checkoutDir, opts.signal, timeoutMs);
        if (!files) markIncomplete(`${submodulePath}: status failed`);
      } else if (checkoutExists) {
        // A checkout with no usable git metadata is the blind spot this gate
        // cannot afford: nothing on disk can say which of these files are
        // recoverable, and the parent cannot help either because an
        // uninitialized submodule emits no `git status` record at all. So every
        // file present is reported as content the delete would take.
        const listed = await listCheckoutFiles(checkoutDir, maxFilesPerModule + 1);
        if (listed) files = { dirty: [], untracked: listed };
        else markIncomplete(`${submodulePath}: checkout could not be listed`);
      }

      if (files) {
        hasModifiedContent ||= files.dirty.length > 0;
        hasUntrackedContent ||= files.untracked.length > 0;
        // The per-module budget is shared between the two lists, as is the
        // global one; a truncated dirty list must not suppress collection of
        // the untracked one.
        let moduleBudget = maxFilesPerModule;
        let truncated = false;
        for (const [target, collected] of [
          [dirtyFiles, files.dirty],
          [untrackedFiles, files.untracked],
        ] as const) {
          const room = Math.min(moduleBudget, maxFilesTotal - collectedFiles);
          const added = appendPrefixed(target, collected, submodulePath, room);
          collectedFiles += added;
          moduleBudget -= added;
          if (added < collected.length) truncated = true;
        }
        if (truncated) markIncomplete(`${submodulePath}: file list truncated`);
      }

      entries.push({
        path: submodulePath,
        ...(name ? { name } : {}),
        state,
        recordedOid,
        ...(headOid ? { headOid } : {}),
        ...(branch ? { branch } : {}),
        ...(stanza?.branch ? { configuredBranch: stanza.branch } : {}),
        ...(stanza?.url ? { url: stanza.url } : {}),
        hasModifiedContent,
        hasUntrackedContent,
      });
    }

    // A store nobody could bind to a checkout path is still deleted with the
    // worktree, so its unreachable commits are still at risk. Failing to NAME
    // it is not a reason to leave its contents out of the answer.
    for (const store of unboundStores) {
      const head = await readModuleHead(store.gitDir, opts.signal, timeoutMs);
      if (!head) continue;
      await collectAtRisk(store.gitDir, `module ${store.name}`);
    }

    return {
      entries,
      dirtyFiles,
      untrackedFiles,
      atRiskCommits,
      requiresMechanicalForce: hasModulesDir,
      incomplete,
    };
  } catch (error) {
    logDebug(
      `Submodule inventory failed for ${root}: ${formatErrorMessage(error, "unknown failure")}`
    );
    return {
      entries: [],
      dirtyFiles: [],
      untrackedFiles: [],
      atRiskCommits: [],
      requiresMechanicalForce: hasModulesDir,
      incomplete: true,
    };
  }
}

function emptyRisk(): SubmoduleDeleteRisk {
  return {
    entries: [],
    dirtyFiles: [],
    untrackedFiles: [],
    atRiskCommits: [],
    requiresMechanicalForce: false,
    incomplete: false,
  };
}

async function readHeadGitlinks(
  git: SimpleGit,
  timeoutMs: number
): Promise<Map<string, string> | null> {
  try {
    return parseTreeGitlinks(await runGit(git, ["ls-tree", "-r", "-z", "HEAD"], timeoutMs));
  } catch {
    return null;
  }
}

/**
 * Read `.gitmodules` through git's own config reader, never a bespoke regex.
 *
 * `--list` rather than `--get-regexp` on purpose. `--get-regexp` reads a second
 * positional as a VALUE pattern, so `--get-regexp <pattern> -z` silently
 * matches nothing and exits 0 — an empty stanza map indistinguishable from an
 * unconfigured repository. `--list` exits 0 for any readable, well-formed file
 * including an empty one, which makes EVERY error here a genuine failure that
 * must fail closed. `.gitmodules` is small; filtering the namespace in the
 * parser costs nothing.
 */
async function readGitmodulesStanzas(
  git: SimpleGit,
  root: string,
  timeoutMs: number
): Promise<Map<string, GitmodulesStanza> | null> {
  try {
    return parseGitmodulesConfig(
      await runGit(git, ["config", "-f", path.join(root, ".gitmodules"), "-z", "--list"], timeoutMs)
    );
  } catch {
    return null;
  }
}

async function readModuleHead(
  moduleGitDir: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ oid: string; branch?: string } | null> {
  try {
    const git = await createHardenedGit(moduleGitDir, signal);
    const output = await runGit(
      git,
      ["--git-dir", moduleGitDir, "rev-parse", "HEAD", "--abbrev-ref", "HEAD"],
      timeoutMs
    );
    const [oid, ref] = output.split("\n").map((line) => line.trim());
    if (!oid) return null;
    // `--abbrev-ref HEAD` answers a literal "HEAD" when detached, which is the
    // healthy resting state of a submodule and therefore not a branch.
    return { oid, ...(ref && ref !== "HEAD" ? { branch: ref } : {}) };
  } catch {
    return null;
  }
}

/**
 * Status inside one module's working tree.
 *
 * Both repositories are bound explicitly rather than discovered: when a
 * checkout's `.git` pointer is missing but its module store survives, upward
 * discovery from the checkout finds the SUPERPROJECT instead and reports the
 * parent's paths — which then get prefixed with the submodule path into
 * fabricated entries while the module's real work goes unreported.
 */
async function readModuleFiles(
  moduleGitDir: string,
  checkoutDir: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ dirty: string[]; untracked: string[] } | null> {
  try {
    const git = await createHardenedGit(checkoutDir, signal);
    return parseStatusPaths(
      await runGit(
        git,
        [
          "--git-dir",
          moduleGitDir,
          "--work-tree",
          checkoutDir,
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        timeoutMs
      )
    );
  } catch {
    return null;
  }
}

/**
 * Commits reachable in the module but on no remote.
 *
 * `--reflog --all HEAD` rather than `--branches`: a healthy submodule sits on a
 * detached HEAD, so an agent that commits into it leaves the commit on no
 * branch at all. Verified on git 2.50.1 — committing on a detached HEAD and
 * then checking the recorded gitlink back out makes
 * `rev-list --branches --not --remotes` return EMPTY while the commit is still
 * live in the module's object store and reflog. `--reflog` is a revision
 * pseudo-option (not `--walk-reflogs`), so the negative `--remotes` still
 * applies. Two residual gaps, both accepted:
 *
 *  - A commit whose reflog entry has expired or was never written
 *    (`core.logAllRefUpdates=false`) and which no ref reaches is findable only
 *    by `fsck`, which is far too slow for this path.
 *  - `--all` does not cover pseudo-refs (`ORIG_HEAD`, `MERGE_HEAD`,
 *    `CHERRY_PICK_HEAD`, `FETCH_HEAD`). A commit held ONLY by one of those,
 *    with its reflog entry already expired, is missed. Adding them means
 *    probing each for existence first, since `log` fails on a ref that is not
 *    there, and the combination that reaches this gap is narrow enough that the
 *    per-module cost was not judged worth it.
 */
async function readAtRiskCommits(
  moduleGitDir: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxCount: number
): Promise<{ commits: SubmoduleAtRiskCommit[]; truncated: boolean } | null> {
  try {
    const git = await createHardenedGit(moduleGitDir, signal);
    const output = await runGit(
      git,
      [
        "--git-dir",
        moduleGitDir,
        "log",
        `--format=%H${UNIT_SEPARATOR}%s`,
        // One more than we keep, so a walk that hit the ceiling is
        // distinguishable from one that simply ran out of commits.
        `--max-count=${maxCount + 1}`,
        "--reflog",
        "--all",
        "HEAD",
        "--not",
        "--remotes",
      ],
      timeoutMs
    );
    const commits: SubmoduleAtRiskCommit[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const line of output.split("\n")) {
      if (!line) continue;
      const separator = line.indexOf(UNIT_SEPARATOR);
      // The `--format` puts one on every line, so its absence means the walk
      // did not answer what was asked — a failure, not a line to drop.
      if (separator === -1) return null;
      const oid = line.slice(0, separator);
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (commits.length === maxCount) {
        truncated = true;
        break;
      }
      commits.push({ oid, subject: line.slice(separator + 1) });
    }
    return { commits, truncated };
  } catch {
    return null;
  }
}

/**
 * Append at most `room` of `files` to `target`, each prefixed with its
 * submodule path. Returns how many were appended.
 */
function appendPrefixed(
  target: string[],
  files: string[],
  submodulePath: string,
  room: number
): number {
  const take = Math.max(0, Math.min(room, files.length));
  for (let i = 0; i < take; i++) target.push(`${submodulePath}/${files[i]}`);
  return take;
}

/**
 * A stanza name usually equals the submodule path, but `submodule.<name>.path`
 * is what actually binds the two, so match on that first. A stanza that names
 * an explicit, different path must not then claim a same-named one.
 */
function resolveStanzaName(
  stanzas: Map<string, GitmodulesStanza>,
  submodulePath: string
): string | undefined {
  for (const [name, stanza] of stanzas) {
    if (stanza.path && toRosterPath(stanza.path) === submodulePath) return name;
  }
  const own = stanzas.get(submodulePath);
  return own && !own.path ? submodulePath : undefined;
}

/**
 * Bind a scanned module directory to the checkout path it belongs to.
 *
 * `git submodule add --name <logical> <url> <path>` puts the module at
 * `modules/<logical>` while the checkout lives at `<path>`, so the directory
 * name is only a path by default convention. Order is the store's OWN
 * `core.worktree` first, and only if it declares none, the `.gitmodules` stanza
 * and then the conventional name.
 *
 * `core.worktree` goes first because it is the only claim the store itself
 * makes — everything else is a claim ABOUT it. A stale stanza
 * (`submodule.logical-name.path = probe`) otherwise binds the store to a path
 * the index never vouched for while the real checkout at `vendor/lib` is never
 * inspected: the same fail-open by another route, `.gitmodules` deciding roster
 * membership.
 *
 * A FAILED read is not evidence of anything, and must never fall through to the
 * conventional name: for a store whose stanza, index entry and HEAD entry are
 * all gone, that binds `modules/<logical-name>` to a phantom checkout path, and
 * the real checkout's dirty files are then never looked at while the HEAD and
 * reflog probes go on succeeding against the store. Hence the discriminated
 * result — the caller turns every non-`bound` answer into `incomplete`, and a
 * `conflict` (the store and `.gitmodules` naming different checkouts) with it.
 */
type ModuleBinding =
  | {
      kind: "bound";
      checkoutPath: string;
      conflict?: string;
      /**
       * The path came from `.gitmodules` or the directory name rather than the
       * store's own `core.worktree` — a claim ABOUT the store, not one it
       * makes. It is the right guess to inspect, but it is still a guess, so a
       * checkout that turns out to be absent at that path cannot be read as
       * "nothing checked out": the real one may have been moved, and it would
       * never enter the roster.
       */
      inferred?: boolean;
    }
  | { kind: "unbound"; reason: string; error?: unknown };

async function resolveModuleCheckoutPath(
  git: SimpleGit,
  root: string,
  realRoot: string | null,
  module: ScannedModule,
  stanzas: Map<string, GitmodulesStanza>,
  timeoutMs: number
): Promise<ModuleBinding> {
  let declared: string | null;
  try {
    declared = parseCoreWorktree(
      await runGit(
        git,
        // `--includes` because git resolves this config the same way; without it
        // a `core.worktree` reached through `include.path` reads as absent and
        // the conventional-name fallback binds a checkout git does not use.
        ["config", "-f", path.join(module.gitDir, "config"), "-z", "--includes", "--list"],
        timeoutMs
      )
    );
  } catch (error) {
    return { kind: "unbound", reason: "core.worktree could not be read", error };
  }

  const stanzaPath = toRosterPath(stanzas.get(module.name)?.path);

  if (declared !== null) {
    let resolved = path.resolve(module.gitDir, declared);
    if (realRoot) {
      try {
        // Existing checkouts are compared by filesystem identity, not by the
        // spelling Git and the caller happened to use. A missing checkout has
        // no canonical path, so it deliberately keeps the lexical fallback.
        resolved = (await realpathOrMissing(resolved)) ?? resolved;
      } catch (error) {
        return {
          kind: "unbound",
          reason: `core.worktree could not be resolved (${declared})`,
          error,
        };
      }
    }
    const relative = path
      .relative(realRoot ?? root, resolved)
      .split(path.sep)
      .join("/");
    const bound = toRosterPath(relative);
    if (!bound) {
      return { kind: "unbound", reason: `core.worktree points outside the worktree (${declared})` };
    }
    return {
      kind: "bound",
      checkoutPath: bound,
      ...(stanzaPath && stanzaPath !== bound
        ? { conflict: `.gitmodules says ${stanzaPath}, the store says ${bound}` }
        : {}),
    };
  }

  // Only here — with a SUCCESSFUL read establishing that the store declares no
  // checkout of its own — are second-hand claims about it a safe answer.
  if (stanzaPath) return { kind: "bound", checkoutPath: stanzaPath, inferred: true };
  const asName = toRosterPath(module.name);
  if (asName) return { kind: "bound", checkoutPath: asName, inferred: true };
  return { kind: "unbound", reason: "no checkout path could be established" };
}

/**
 * `core.worktree` as GIT would resolve it: the LAST occurrence wins for a
 * single-valued key, so taking the first would bind the store to a checkout git
 * itself does not use.
 */
function parseCoreWorktree(stdout: string): string | null {
  let value: string | null = null;
  for (const record of splitNulRecords(stdout, "config")) {
    const newline = record.indexOf("\n");
    // A valueless key is emitted bare; `core.worktree` is never one.
    if (newline === -1) continue;
    if (record.slice(0, newline).toLowerCase() !== "core.worktree") continue;
    value = record.slice(newline + 1);
  }
  return value ? value : null;
}

/**
 * Normalize a configured path and reject anything that is not a relative path
 * inside the worktree. A `.gitmodules` stanza is tracked content, so
 * `path = .` or `path = ../../other` would otherwise point the inventory at the
 * superproject or an unrelated repository.
 *
 * Validation assumes BOTH separator vocabularies regardless of host. `path` here
 * is host-agnostic, and `path.win32.resolve("C:\\repo\\wt", "..\\..\\outside")`
 * escapes to `C:\outside` — so a value that traverses under EITHER
 * interpretation is rejected, even though only one of them can be true at a
 * time. The returned path still splits on `/` alone: git writes `/` in
 * `.gitmodules`, and a backslash is a legal character in a POSIX filename.
 */
export function toRosterPath(value: string | undefined): string | null {
  if (!value || value.includes("\0")) return null;
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return null;
  if (path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  // `C:foo` is drive-RELATIVE rather than absolute, and still leaves the tree.
  if (/^[a-zA-Z]:/.test(trimmed)) return null;
  if (trimmed.split(/[/\\]/).some((segment) => segment === "..")) return null;
  const segments = trimmed.split("/").filter((segment) => segment !== "." && segment !== "");
  if (segments.length === 0) return null;
  return segments.join("/");
}

/**
 * Where a roster path's checkout directory actually lands on this host.
 *
 * `toRosterPath` only guarantees lexical containment; a symlink or junction
 * anywhere along the path defeats that at resolve time. `realpath` is the only
 * answer that survives it, and "cannot tell" is answered as `unknown` so the
 * caller fails closed rather than probing a directory it has not contained.
 */
async function classifyCheckout(
  realRoot: string | null,
  checkoutDir: string
): Promise<"contained" | "absent" | "escaped" | "unknown"> {
  if (!realRoot) return "unknown";
  let resolved: string | null;
  try {
    resolved = await realpathOrMissing(checkoutDir);
  } catch {
    return "unknown";
  }
  if (resolved === null) return "absent";
  return resolved.startsWith(realRoot + path.sep) ? "contained" : "escaped";
}

/**
 * Every file under `dir`, repo-relative, up to `limit`.
 *
 * Symlinks are listed but never followed — a link out of the checkout is one
 * file the delete removes, not a directory tree to descend into and report.
 * Returns null when any part of the walk could not be completed.
 */
async function listCheckoutFiles(dir: string, limit: number): Promise<string[] | null> {
  const files: string[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    const dirents = await withTimeout(
      readdir(current, { withFileTypes: true }),
      FS_PROBE_TIMEOUT_MS,
      `readdir timed out: ${current}`
    );
    for (const dirent of dirents) {
      if (files.length >= limit) return;
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) await walk(path.join(current, dirent.name), childRelative);
      else files.push(childRelative);
    }
  };
  try {
    if (limit > 0) await walk(dir, "");
    return files;
  } catch {
    return null;
  }
}

function clampCount(value: number | undefined, fallback: number, min: number): number {
  return Number.isInteger(value) && (value as number) >= min ? (value as number) : fallback;
}

/**
 * The worktree's OWN git directory — `<root>/.git` for a main worktree, and the
 * `gitdir:` target for a linked one. Deliberately does NOT follow `commondir`:
 * the modules that a linked worktree owns live under its per-worktree gitdir,
 * and that is the directory `git worktree remove` gates on.
 *
 * `null` means there is no `.git` here at all. A `.git` that exists but does not
 * lead anywhere THROWS instead: answering `null` would leave the caller's
 * `hasModulesDir` reading `false`, which is a definite "this worktree owns no
 * modules" drawn from a probe that established nothing.
 */
async function resolveWorktreeGitDir(root: string): Promise<string | null> {
  const dotGit = path.join(root, ".git");
  const info = await statOrMissing(dotGit);
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) throw new Error(`${dotGit} is neither a file nor a directory`);
  const contents = await readFileOrMissing(dotGit);
  const match = contents?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) throw new Error(`${dotGit} is not a gitdir pointer`);
  return path.resolve(root, match[1]);
}

/**
 * Every module git directory under `<worktree gitdir>/modules`.
 *
 * Descent stops at a repository, so a nested submodule's own `modules/` subtree
 * is not enumerated (depth 1 only) — but its PRESENCE is recorded, because the
 * deletion that follows is not depth-limited and takes those stores too.
 * Returns null when any part of the scan could not be completed — a partial
 * scan must not be mistaken for an empty one.
 *
 * Identification deliberately does NOT rest on `HEAD` alone. `--name` puts
 * modules under namespace directories, so anything without a `HEAD` used to be
 * descended into as one — and an orphaned store that still holds `objects` and
 * reflogs but has lost its `HEAD` then simply vanished, taking its commits with
 * the delete while the inventory came back empty and complete.
 */
async function collectModuleGitDirs(modulesDir: string): Promise<ScannedModule[] | null> {
  const found: ScannedModule[] = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    const dirents = await withTimeout(
      readdir(dir, { withFileTypes: true }),
      FS_PROBE_TIMEOUT_MS,
      `readdir timed out: ${dir}`
    );
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const child = path.join(dir, dirent.name);
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      const children = await withTimeout(
        readdir(child, { withFileTypes: true }),
        FS_PROBE_TIMEOUT_MS,
        `readdir timed out: ${child}`
      );
      const shape = classifyRepositoryShape(children);
      if (shape === "namespace") {
        await walk(child, childRelative);
        continue;
      }
      // A store that itself holds `modules/` has nested submodules, and THEIR
      // object stores are under this worktree's gitdir too — so `worktree
      // remove --force` takes them while the walk below, which stops at this
      // repository, never sees them. The inventory models depth 1; deletion
      // does not. Flagging it fails closed on the gap rather than reporting a
      // clean answer for a child commit that exists nowhere else.
      const nested = children.some((entry) => entry.name === "modules" && entry.isDirectory());
      found.push({
        name: childRelative,
        gitDir: child,
        ...(shape === "malformed" ? { malformed: true } : {}),
        ...(nested ? { hasNestedModules: true } : {}),
      });
    }
  };
  try {
    await walk(modulesDir, "");
    return found;
  } catch {
    return null;
  }
}

/**
 * Whether a directory under `modules/` is a repository, a wrecked repository,
 * or a namespace directory holding other modules.
 *
 * A namespace directory contains nothing but module directories, so `config`
 * (a file) can never appear in one and `objects`/`refs` only could if a
 * submodule were literally named `<namespace>/objects`. That case is reported
 * as malformed rather than descended into, which loses a name but fails closed.
 */
function classifyRepositoryShape(children: Dirent[]): "repository" | "malformed" | "namespace" {
  let skeleton = false;
  for (const child of children) {
    if (child.name === "HEAD" && child.isFile()) return "repository";
    if (child.name === "config" && child.isFile()) skeleton = true;
    else if ((child.name === "objects" || child.name === "refs") && child.isDirectory()) {
      skeleton = true;
    }
  }
  return skeleton ? "malformed" : "namespace";
}

async function runGit(git: SimpleGit, args: string[], timeoutMs: number): Promise<string> {
  return withTimeout(git.raw(args), timeoutMs, `git ${args[0]} timed out after ${timeoutMs}ms`);
}

/**
 * `null` means the path is definitively not there. Anything else — a timeout, a
 * permission error, a dead mount — rejects, because an inventory must never
 * read "cannot tell" as "nothing here".
 */
async function statOrMissing(target: string): Promise<Stats | null> {
  try {
    return await withTimeout(stat(target), FS_PROBE_TIMEOUT_MS, `stat timed out: ${target}`);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

async function readFileOrMissing(target: string): Promise<string | null> {
  try {
    return await withTimeout(
      readFile(target, "utf-8"),
      FS_PROBE_TIMEOUT_MS,
      `readFile timed out: ${target}`
    );
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

async function realpathOrMissing(target: string): Promise<string | null> {
  try {
    return await withTimeout(
      realpath(target),
      FS_PROBE_TIMEOUT_MS,
      `realpath timed out: ${target}`
    );
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && MISSING_ERRNO.has(code);
}

async function isDirectory(target: string): Promise<boolean> {
  return (await statOrMissing(target))?.isDirectory() === true;
}

async function isFile(target: string): Promise<boolean> {
  return (await statOrMissing(target))?.isFile() === true;
}
