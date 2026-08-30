import { readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
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
 */
export function parseIndexGitlinks(stdout: string): IndexGitlink[] {
  const out: IndexGitlink[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta.length !== 3 || meta[0] !== GITLINK_MODE) continue;
    const stage = Number.parseInt(meta[2], 10);
    if (!Number.isInteger(stage) || stage < 0 || stage > 3) continue;
    const entryPath = record.slice(tab + 1);
    if (!meta[1] || !entryPath) continue;
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
  const out = new Map<string, string>();
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    if (meta.length !== 3 || meta[0] !== GITLINK_MODE) continue;
    const entryPath = record.slice(tab + 1);
    if (!meta[2] || !entryPath) continue;
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
 * corrupt the submodule sub-states that follow. The extra token is consumed
 * only once the record itself has parsed, so a malformed `2` cannot swallow a
 * valid record behind it.
 */
function* iterateStatusRecords(stdout: string): Generator<StatusRecord> {
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record || record[1] !== " ") continue;
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
        // `#` header lines carry no path.
        continue;
    }
    const split = splitLeadingFields(record, leadingFields);
    if (!split) continue;
    if (kind === "2") i += 1;
    yield { kind, fields: split.fields, path: split.rest };
  }
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
    const sub = record.fields[2];
    if (!sub || sub.length !== 4 || sub[0] !== "S") continue;
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
  for (const record of stdout.split("\0")) {
    if (!record.startsWith(prefix)) continue;
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
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
  const checkout = path.resolve(worktreePath, submodulePath);
  let pointer = path.join(checkout, ".git");
  for (let hop = 0; hop < MAX_GITDIR_HOPS; hop++) {
    const info = await statOrMissing(pointer);
    if (!info) return null;
    if (info.isDirectory()) return pointer;
    if (!info.isFile()) return null;
    const contents = await readFileOrMissing(pointer);
    const match = contents?.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match) return null;
    pointer = path.resolve(path.dirname(pointer), match[1]);
  }
  return null;
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
    // Residual gap, accepted deliberately: an OLD-FORM embedded `.git`
    // directory that is simultaneously absent from the index and has no
    // `.gitmodules` stanza is invisible here, because finding it would cost a
    // `ls-tree HEAD` on every submodule-free repository. `git submodule add`
    // has not produced that layout since git 1.7.8.
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
    // source that can evidence a nested repository, unioned, so orphans are
    // found rather than only the well-formed entries.
    const rosterPaths = new Set<string>();
    for (const gitlink of indexGitlinks) rosterPaths.add(gitlink.path);
    for (const treePath of headGitlinks?.keys() ?? []) rosterPaths.add(treePath);
    for (const stanza of stanzas.values()) {
      const configured = toRosterPath(stanza.path);
      if (configured) rosterPaths.add(configured);
    }

    // A scanned module's directory name is its LOGICAL name, which only equals
    // the checkout path by default convention — `--name` decouples them. Bind
    // each one to a real path before it can enter the roster, and remember the
    // git directory so a checkout deleted out from under it is still reachable.
    const gitDirByPath = new Map<string, string>();
    for (const module of scannedModules) {
      const bound = await resolveModuleCheckoutPath(
        git,
        root,
        module,
        stanzas,
        rosterPaths,
        timeoutMs
      );
      if (!bound) {
        markIncomplete(`module ${module.name} could not be bound to a checkout path`);
        continue;
      }
      rosterPaths.add(bound);
      gitDirByPath.set(bound, module.gitDir);
    }

    const entries: SubmoduleEntry[] = [];
    const dirtyFiles: string[] = [];
    const untrackedFiles: string[] = [];
    const atRiskCommits: SubmoduleAtRiskCommit[] = [];
    let collectedFiles = 0;

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
      let moduleGitDir: string | null = null;
      try {
        // A checkout deleted out from under an absorbed module leaves no
        // pointer to follow, but the module — and its objects — are still there.
        moduleGitDir =
          (await resolveModuleGitDir(root, submodulePath)) ??
          gitDirByPath.get(submodulePath) ??
          null;
      } catch (error) {
        markIncomplete(`${submodulePath}: git directory unreadable`, error);
      }

      let headOid: string | undefined;
      let branch: string | undefined;
      if (moduleGitDir) {
        const head = await readModuleHead(moduleGitDir, opts.signal, timeoutMs);
        if (head) {
          headOid = head.oid;
          branch = head.branch;
        } else {
          markIncomplete(`${submodulePath}: HEAD unreadable`);
        }
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
      try {
        checkoutExists = await isDirectory(checkoutDir);
      } catch (error) {
        markIncomplete(`${submodulePath}: checkout unreadable`, error);
      }

      if (moduleGitDir && checkoutExists) {
        const files = await readModuleFiles(moduleGitDir, checkoutDir, opts.signal, timeoutMs);
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
        } else {
          markIncomplete(`${submodulePath}: status failed`);
        }
      }

      // Skipped without a HEAD: an unborn module has no commits to strand, and
      // the failed `rev-parse` above has already flagged the inventory.
      if (moduleGitDir && headOid) {
        const commits = await readAtRiskCommits(
          moduleGitDir,
          opts.signal,
          timeoutMs,
          maxAtRiskCommits
        );
        if (commits) atRiskCommits.push(...commits);
        else markIncomplete(`${submodulePath}: rev walk failed`);
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
 * applies. Residual gap: a commit whose reflog entry has been expired or was
 * never written (`core.logAllRefUpdates=false`) is reachable only by `fsck`,
 * which is too slow to run on this path.
 */
async function readAtRiskCommits(
  moduleGitDir: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxCount: number
): Promise<SubmoduleAtRiskCommit[] | null> {
  try {
    const git = await createHardenedGit(moduleGitDir, signal);
    const output = await runGit(
      git,
      [
        "--git-dir",
        moduleGitDir,
        "log",
        `--format=%H${UNIT_SEPARATOR}%s`,
        `--max-count=${maxCount}`,
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
    for (const line of output.split("\n")) {
      if (!line) continue;
      const separator = line.indexOf(UNIT_SEPARATOR);
      if (separator === -1) continue;
      const oid = line.slice(0, separator);
      if (seen.has(oid)) continue;
      seen.add(oid);
      commits.push({ oid, subject: line.slice(separator + 1) });
    }
    return commits;
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
 * name is only a path by default convention. Order is cheapest-first: the
 * `.gitmodules` stanza, then a name that the index or HEAD already vouches for,
 * and only then the module's own `core.worktree` — which is the sole remaining
 * evidence once the stanza has been committed away.
 */
async function resolveModuleCheckoutPath(
  git: SimpleGit,
  root: string,
  module: ScannedModule,
  stanzas: Map<string, GitmodulesStanza>,
  knownPaths: ReadonlySet<string>,
  timeoutMs: number
): Promise<string | null> {
  const configured = toRosterPath(stanzas.get(module.name)?.path);
  if (configured) return configured;

  const asName = toRosterPath(module.name);
  if (asName && knownPaths.has(asName)) return asName;

  try {
    const config = parseCoreWorktree(
      await runGit(
        git,
        ["config", "-f", path.join(module.gitDir, "config"), "-z", "--list"],
        timeoutMs
      )
    );
    if (config) {
      const resolved = path.resolve(module.gitDir, config);
      const relative = path.relative(root, resolved);
      const bound = toRosterPath(relative.split(path.sep).join("/"));
      if (bound) return bound;
    }
  } catch {
    // Fall through to the conventional name below.
  }

  return asName;
}

function parseCoreWorktree(stdout: string): string | null {
  for (const record of stdout.split("\0")) {
    const newline = record.indexOf("\n");
    if (newline === -1) continue;
    if (record.slice(0, newline).toLowerCase() !== "core.worktree") continue;
    return record.slice(newline + 1) || null;
  }
  return null;
}

/**
 * Normalize a configured path and reject anything that is not a relative path
 * inside the worktree. A `.gitmodules` stanza is tracked content, so
 * `path = .` or `path = ../../other` would otherwise point the inventory at the
 * superproject or an unrelated repository.
 */
function toRosterPath(value: string | undefined): string | null {
  if (!value) return null;
  // Deliberately no backslash translation: git writes `/` in `.gitmodules`, and
  // a backslash is a legal character in a POSIX filename.
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed || trimmed === "." || path.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    return null;
  }
  const segments = trimmed.split("/").filter((segment) => segment !== "." && segment !== "");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments.join("/");
}

function clampCount(value: number | undefined, fallback: number, min: number): number {
  return Number.isInteger(value) && (value as number) >= min ? (value as number) : fallback;
}

/**
 * The worktree's OWN git directory — `<root>/.git` for a main worktree, and the
 * `gitdir:` target for a linked one. Deliberately does NOT follow `commondir`:
 * the modules that a linked worktree owns live under its per-worktree gitdir,
 * and that is the directory `git worktree remove` gates on.
 */
async function resolveWorktreeGitDir(root: string): Promise<string | null> {
  const dotGit = path.join(root, ".git");
  const info = await statOrMissing(dotGit);
  if (!info) return null;
  if (info.isDirectory()) return dotGit;
  if (!info.isFile()) return null;
  const contents = await readFileOrMissing(dotGit);
  const match = contents?.match(/^gitdir:\s*(.+?)\s*$/m);
  return match ? path.resolve(root, match[1]) : null;
}

/**
 * Every module git directory under `<worktree gitdir>/modules`.
 *
 * A module gitdir is identified by holding a `HEAD`; descent stops there, so a
 * nested submodule's own `modules/` subtree is not reported (depth 1 only).
 * Returns null when any part of the scan could not be completed — a partial
 * scan must not be mistaken for an empty one.
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
      if (await isFile(path.join(child, "HEAD"))) {
        found.push({ name: childRelative, gitDir: child });
        continue;
      }
      await walk(child, childRelative);
    }
  };
  try {
    await walk(modulesDir, "");
    return found;
  } catch {
    return null;
  }
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
