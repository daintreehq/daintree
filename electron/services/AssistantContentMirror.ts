import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resilientAtomicWriteFile } from "../utils/fs.js";

/**
 * Mirrors user-authored assistant commands and skills into the per-project
 * help-session directory at provision time, so the CLIs launched there
 * (Claude Code, Codex, Copilot) discover them through their native cwd-scoped
 * mechanisms — no agent config outside Daintree-owned directories is ever
 * touched (precedent #4100).
 *
 * Sources, lowest to highest precedence (later copies overwrite):
 *   1. Global:      ~/.daintree/assistant/
 *   2. Per-project: <project>/.daintree/assistant/   (git-trackable, like recipes)
 *
 * Inside each source the layout is agent-native hidden folders:
 *   .claude/commands/   Claude Code slash commands (*.md)
 *   .claude/skills/     Claude-only skills (<name>/SKILL.md)
 *   .codex/skills/      Codex-only skills (<name>/SKILL.md)
 *   .agents/skills/     Shared skills (Agent Skills convention)
 *
 * Per-agent mapping rationale (verified July 2026):
 *   - Claude Code treats a non-git cwd as the project root and loads
 *     .claude/commands + .claude/skills from it, but declined support for the
 *     .agents/skills convention (anthropics/claude-code#56193) — so shared
 *     skills are translated into .claude/skills for Claude sessions, with an
 *     explicit .claude/skills entry of the same name winning.
 *   - Codex removed custom prompts entirely in 0.118.0; skills are the only
 *     vehicle. It loads <cwd>/.agents/skills even when cwd is not a git repo,
 *     and skills are exempt from the project-config trust gate. The
 *     .codex/skills SOURCE folder is a Daintree-owned authoring convention for
 *     Codex-only skills — it is translated to the session's .agents/skills,
 *     never mirrored to a .codex destination, because <cwd>/.codex rides
 *     Codex's trust-gated project-config layer.
 *   - Copilot CLI reads both .claude/skills and .agents/skills from cwd.
 *   - daintree-assistant runs in the project root and reads nothing from cwd,
 *     so it has no mapping here; it will read the source folders natively.
 */
interface ContentMapping {
  sourceDir: string;
  destDir: string;
  /**
   * `skillDir`: the unit of precedence is the top-level skill directory — a
   * higher-precedence skill of the same name replaces the lower one wholesale
   * (never a per-file interleave of two different skills), and a directory is
   * only eligible when it contains a SKILL.md. `file`: each file stands alone
   * (commands).
   */
  granularity: "file" | "skillDir";
}

const AGENT_CONTENT_MAPPINGS: Record<string, readonly ContentMapping[]> = {
  // Order matters within a source: the translated shared tree goes first so
  // an explicit .claude/skills/<name> overrides .agents/skills/<name>.
  claude: [
    { sourceDir: ".agents/skills", destDir: ".claude/skills", granularity: "skillDir" },
    { sourceDir: ".claude/commands", destDir: ".claude/commands", granularity: "file" },
    { sourceDir: ".claude/skills", destDir: ".claude/skills", granularity: "skillDir" },
  ],
  // Shared tree first so an explicit .codex/skills/<name> overrides
  // .agents/skills/<name>; both land in the session's .agents/skills.
  codex: [
    { sourceDir: ".agents/skills", destDir: ".agents/skills", granularity: "skillDir" },
    { sourceDir: ".codex/skills", destDir: ".agents/skills", granularity: "skillDir" },
  ],
  copilot: [
    { sourceDir: ".agents/skills", destDir: ".agents/skills", granularity: "skillDir" },
    { sourceDir: ".claude/skills", destDir: ".claude/skills", granularity: "skillDir" },
  ],
};

// Union of every mapping's destDir. Stale-entry deletion is restricted to
// these roots so a corrupt manifest can never reach template files
// (.mcp.json, .claude/settings.json, CLAUDE.md, ...). Kept as a superset of
// all agents' mappings on purpose: switching the same project's session from
// claude to codex must clean up the claude-mirrored files. `.codex/skills` is
// deliberately NOT here — it is a source authoring convention, never a
// session destination, and must never become a permissible deletion root.
const MIRROR_DEST_ROOTS = [".claude/commands", ".claude/skills", ".agents/skills"] as const;

// Roots scaffolded in the Daintree-owned AUTHORING folders (~/.daintree/
// assistant and <project>/.daintree/assistant). Includes the .codex/skills
// source lane; distinct from MIRROR_DEST_ROOTS, which alone bounds deletion.
const SOURCE_SCAFFOLD_ROOTS = [
  ".claude/commands",
  ".claude/skills",
  ".codex/skills",
  ".agents/skills",
] as const;

// Manifest of relpaths written by the previous sync, stored inside the
// session dir. Deletion is manifest-driven so user files that happen to be in
// the session dir but were never mirrored by us are left alone.
const MANIFEST_FILE = ".daintree-user-content.json";

// Walk guards: user-controlled trees, so cap breadth/depth/size instead of
// trusting them. Caps mirror Codex's own 2000-skill-dirs bound.
const MAX_FILES = 2000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const ASSISTANT_CONTENT_DIR_SEGMENTS = [".daintree", "assistant"] as const;

export function getGlobalAssistantContentDir(): string {
  return path.join(os.homedir(), ...ASSISTANT_CONTENT_DIR_SEGMENTS);
}

export function getProjectAssistantContentDir(projectPath: string): string {
  return path.join(projectPath, ...ASSISTANT_CONTENT_DIR_SEGMENTS);
}

export function agentSupportsAssistantContent(agentId: string): boolean {
  return agentId in AGENT_CONTENT_MAPPINGS;
}

export interface AssistantContentSyncInput {
  sessionPath: string;
  projectPath: string;
  agentId: string;
  /** Test seam — defaults to ~/.daintree/assistant. */
  globalContentDir?: string;
}

/**
 * Structured sync outcome. `staleFailures` is the fail-closed signal: managed
 * destination files that should be gone (or provably refreshed) but are still
 * present. The caller must not launch a backend from the session dir while it
 * is non-empty — otherwise deleted or superseded skill instructions would stay
 * silently active. `omittedSkills` (invalid sources skipped safely) and
 * `failedCopies` (desired file absent, nothing stale left behind) are
 * warnings: the assistant is still safe to launch, just without that content.
 */
export interface AssistantContentSyncResult {
  copied: number;
  removed: number;
  truncated: boolean;
  /** Skill dirs skipped for missing SKILL.md, as `<scope>:<sourceDir>/<name>`. */
  omittedSkills: string[];
  /** Desired dest relpaths that could not be written and are absent on disk. */
  failedCopies: string[];
  /** Managed dest relpaths that are stale or unverifiable but still present. */
  staleFailures: string[];
}

interface ManifestShape {
  version: number;
  files: string[];
}

/**
 * Validates a manifest/desired relpath (posix form). Rejects dot segments
 * (`.claude/commands/../../.mcp.json` would pass a bare prefix check),
 * backslashes (on Windows `path.resolve` treats `x\..\..` inside one segment
 * as separators, re-opening the same traversal), and drive-colon characters.
 */
function isUnderMirrorRoot(posixRelPath: string): boolean {
  const segments = posixRelPath.split("/");
  if (
    segments.some(
      (seg) => seg === "" || seg === "." || seg === ".." || seg.includes("\\") || seg.includes(":")
    )
  ) {
    return false;
  }
  return MIRROR_DEST_ROOTS.some((root) => posixRelPath.startsWith(root + "/"));
}

/**
 * Reads the ownership manifest. Only a missing file means "nothing managed
 * yet" — the manifest is atomically written and Daintree-owned, so an
 * unreadable, corrupt, or unsupported one means ownership records are gone
 * while managed files may still be on disk. Treating that as empty would
 * launch a session with stale unowned skills; throw instead (fail closed).
 */
async function readManifest(sessionPath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionPath, MANIFEST_FILE), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Unreadable mirror manifest ${MANIFEST_FILE} — cannot prove mirror ownership`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt mirror manifest ${MANIFEST_FILE} — cannot prove mirror ownership`, {
      cause: err,
    });
  }
  const shape = parsed as ManifestShape | null;
  if (
    !shape ||
    shape.version !== 1 ||
    !Array.isArray(shape.files) ||
    shape.files.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Unsupported mirror manifest ${MANIFEST_FILE} — cannot prove mirror ownership`);
  }
  return shape.files as string[];
}

async function writeManifest(sessionPath: string, files: string[]): Promise<void> {
  const manifest: ManifestShape = { version: 1, files: [...new Set(files)].sort() };
  await resilientAtomicWriteFile(
    path.join(sessionPath, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
    { mode: 0o600 }
  );
}

interface WalkState {
  files: Map<string, string>;
  visitedDirs: Set<string>;
  truncated: boolean;
  /**
   * Directories that exist but could not be read. Distinct from absent
   * sources: an absent source contributes no skills (and retires previously
   * mirrored ones), while an unreadable source means the desired state cannot
   * be proven — the sync must fail rather than silently delete content that
   * may still be defined.
   */
  unreadableDirs: string[];
}

function isAbsentError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Collects relative posix paths → absolute source paths under `rootAbs`.
 * Follows symlinks (users commonly symlink shared skill folders) with a
 * realpath visited-set so cycles terminate; dot-entries are skipped to match
 * how the CLIs' own scanners treat them.
 */
async function collectSourceFiles(rootAbs: string): Promise<WalkState> {
  const state: WalkState = {
    files: new Map(),
    visitedDirs: new Set(),
    truncated: false,
    unreadableDirs: [],
  };
  try {
    const rootReal = await fs.realpath(rootAbs);
    state.visitedDirs.add(rootReal);
  } catch (err) {
    if (!isAbsentError(err)) state.unreadableDirs.push(rootAbs);
    return state; // absent source dir — nothing to collect
  }
  await walkDir(rootAbs, "", state, 0);
  return state;
}

async function walkDir(
  dirAbs: string,
  relPrefix: string,
  state: WalkState,
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH || state.truncated) {
    if (depth > MAX_DEPTH) state.truncated = true;
    return;
  }
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (!isAbsentError(err)) state.unreadableDirs.push(dirAbs);
    return;
  }
  // Alphabetical order keeps traversal — and therefore which files survive
  // the MAX_FILES truncation — deterministic across runs. Collision
  // precedence is decided by mapping/source order, not by this sort.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (state.truncated) return;
    if (entry.name.startsWith(".")) continue;
    const entryAbs = path.join(dirAbs, entry.name);
    const entryRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(entryAbs);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch (err) {
        // Dangling symlink (ENOENT) and OS-level link loops are skippable;
        // anything else (EACCES, EIO) leaves the desired state unprovable.
        if (isAbsentError(err) || (err as NodeJS.ErrnoException).code === "ELOOP") continue;
        state.unreadableDirs.push(entryAbs);
        continue;
      }
    }

    if (isDir) {
      try {
        const real = await fs.realpath(entryAbs);
        if (state.visitedDirs.has(real)) continue; // symlink cycle
        state.visitedDirs.add(real);
      } catch (err) {
        if (isAbsentError(err) || (err as NodeJS.ErrnoException).code === "ELOOP") continue;
        state.unreadableDirs.push(entryAbs);
        continue;
      }
      await walkDir(entryAbs, entryRel, state, depth + 1);
    } else if (isFile) {
      if (state.files.size >= MAX_FILES) {
        state.truncated = true;
        return;
      }
      state.files.set(entryRel, entryAbs);
    }
  }
}

type ChainVerdict = "ok" | "unsafe";

/**
 * Verifies that every EXISTING directory component of `relDirSegments` under
 * `baseAbs` is a real (non-symlink) directory. Agents spawned in the session
 * dir can write to it (codex/copilot sessions are not write-sandboxed), so a
 * planted symlink like `.claude/skills → ~/.ssh` must not let the next sync's
 * deletes or copies operate outside the session dir. Components that don't
 * exist yet are fine — `fs.mkdir` will create them as real directories.
 * Results are memoized per sync in `cache` (dir abs path → verdict).
 */
async function verifyRealDirChain(
  baseAbs: string,
  relDirSegments: string[],
  cache: Map<string, ChainVerdict>
): Promise<ChainVerdict> {
  let current = baseAbs;
  for (const segment of relDirSegments) {
    current = path.join(current, segment);
    const cached = cache.get(current);
    if (cached) {
      if (cached === "unsafe") return "unsafe";
      continue;
    }
    let verdict: ChainVerdict = "ok";
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) verdict = "unsafe";
    } catch (err) {
      // ENOENT: nothing below exists yet, so there is nothing a symlink could
      // redirect — mkdir will create real dirs from here down. Any other
      // failure (EACCES, EIO) leaves the chain unprovable: unsafe.
      verdict = isAbsentError(err) ? "ok" : "unsafe";
    }
    cache.set(current, verdict);
    if (verdict === "unsafe") return "unsafe";
  }
  return "ok";
}

/** Non-throwing lstat existence probe for the verification pass. */
async function destFileState(abs: string): Promise<"absent" | "file" | "other"> {
  try {
    const st = await fs.lstat(abs);
    return st.isFile() && !st.isSymbolicLink() ? "file" : "other";
  } catch (err) {
    // Only a proven-missing path counts as absent — an unreadable path may
    // still hold stale content, so it stays unverifiable ("other").
    return isAbsentError(err) ? "absent" : "other";
  }
}

/**
 * Portable casefold identity for alias detection: the default macOS and
 * Windows filesystems are case-insensitive (and macOS normalizes Unicode), so
 * two relpaths differing only by case/normalization address the same file.
 */
function foldPath(rel: string): string {
  return rel.normalize("NFC").toLowerCase();
}

/**
 * Syncs user assistant content into the session directory for the given
 * agent. Returns null for agents with no cwd-based content mechanism. Throws
 * when a source directory exists but cannot be read — the desired state is
 * unprovable, and treating it as empty would wrongly retire mirrored skills.
 *
 * Sync is manifest-driven: files mirrored by the previous sync that are no
 * longer desired are removed (so deleting a skill in the source folder
 * actually retires it), then every desired file is copied fresh. The manifest
 * is written twice per sync: first as a superset (desired ∪ stale) after
 * deletions but before copies — because every copied path is manifested
 * BEFORE its copy starts, no crash point can produce an on-disk managed file
 * the manifest doesn't own — then compacted after verification to desired ∪
 * still-present stale paths, so successfully removed rels are retired and a
 * future unmanaged file at the same relpath is never claimed. Combined with
 * the verification pass this gives the same recovery guarantee as a separate
 * pending-manifest scheme without a second recovery file.
 */
export async function syncAssistantContent(
  input: AssistantContentSyncInput
): Promise<AssistantContentSyncResult | null> {
  const mappings = AGENT_CONTENT_MAPPINGS[input.agentId];
  if (!mappings) return null;

  const sources: Array<{ scope: "global" | "project"; root: string }> = [
    { scope: "global", root: input.globalContentDir ?? getGlobalAssistantContentDir() },
    { scope: "project", root: getProjectAssistantContentDir(input.projectPath) },
  ];

  // destRel (posix) → source absolute path. Insertion order encodes
  // precedence: global before project, and within a source the mapping order
  // above — later writes overwrite earlier ones. For skillDir mappings the
  // replacement unit is the whole top-level skill directory: all previously
  // collected files under the same dest skill prefix are dropped first, so an
  // explicit skill never interleaves files with a shadowed shared skill. A
  // skill directory without a SKILL.md is invalid — it contributes nothing
  // and therefore never shadows a valid lower-precedence skill.
  const desired = new Map<string, string>();
  const omittedSkills: string[] = [];
  let truncated = false;
  for (const source of sources) {
    for (const mapping of mappings) {
      const walk = await collectSourceFiles(path.join(source.root, mapping.sourceDir));
      if (walk.unreadableDirs.length > 0) {
        throw new Error(
          `Unreadable assistant content directory: ${walk.unreadableDirs[0]} — cannot compute the desired skill state`
        );
      }
      truncated ||= walk.truncated;
      if (mapping.granularity === "file") {
        for (const [rel, abs] of walk.files) {
          desired.set(`${mapping.destDir}/${rel}`, abs);
        }
        continue;
      }
      const bySkill = new Map<string, Map<string, string>>();
      for (const [rel, abs] of walk.files) {
        const slash = rel.indexOf("/");
        if (slash <= 0) continue; // loose file at the skills root — not a skill bundle
        const skillName = rel.slice(0, slash);
        let group = bySkill.get(skillName);
        if (!group) {
          group = new Map();
          bySkill.set(skillName, group);
        }
        group.set(rel, abs);
      }
      for (const [skillName, group] of bySkill) {
        // The SKILL.md must exist AND pass the size cap BEFORE this bundle
        // may shadow a lower-precedence skill — deciding on walk presence
        // alone would let an oversized manifest knock out the valid skill
        // underneath and still mirror its own resource files.
        const skillMdAbs = group.get(`${skillName}/SKILL.md`);
        let eligible = skillMdAbs !== undefined;
        if (skillMdAbs) {
          try {
            eligible = (await fs.stat(skillMdAbs)).size <= MAX_FILE_BYTES;
          } catch (err) {
            if (!isAbsentError(err)) {
              throw new Error(
                `Unreadable assistant content directory: ${skillMdAbs} — cannot compute the desired skill state`,
                { cause: err }
              );
            }
            eligible = false;
          }
        }
        if (!eligible) {
          omittedSkills.push(`${source.scope}:${mapping.sourceDir}/${skillName}`);
          continue;
        }
        const prefix = `${mapping.destDir}/${skillName}/`;
        for (const key of desired.keys()) {
          if (key.startsWith(prefix)) desired.delete(key);
        }
        for (const [rel, abs] of group) {
          desired.set(`${mapping.destDir}/${rel}`, abs);
        }
      }
    }
  }
  if (truncated) {
    console.warn(
      `[AssistantContentMirror] Source tree exceeds limits (${MAX_FILES} files / depth ${MAX_DEPTH}); extra content was skipped`
    );
  }

  // A destination relpath the cleanup validator would refuse to own must
  // never be created: on POSIX, ':' and '\' are legal filename characters,
  // but isUnderMirrorRoot rejects them (Windows traversal defense) — a
  // mirrored file with such a name would be stranded outside every future
  // reconciliation.
  for (const destRel of [...desired.keys()]) {
    if (!isUnderMirrorRoot(destRel)) {
      console.warn("[AssistantContentMirror] Skipping unownable destination path:", destRel);
      desired.delete(destRel);
    }
  }

  // Case-insensitive filesystems (default macOS/Windows) alias skill
  // directories that differ only by case, which would interleave a shadowed
  // skill's files with its winner inside one on-disk directory. Collapse
  // casefold collisions deterministically on every platform: the
  // last-inserted (highest-precedence) spelling wins, other spellings are
  // omitted wholesale.
  const skillPrefixWinners = new Map<string, string>();
  for (const destRel of desired.keys()) {
    const segments = destRel.split("/");
    if (segments.length < 4) continue; // skills sit at <root>/<skill>/<file…>; commands are per-file
    skillPrefixWinners.set(
      foldPath(segments.slice(0, 3).join("/")),
      segments.slice(0, 3).join("/")
    );
  }
  const reportedCollisions = new Set<string>();
  for (const destRel of [...desired.keys()]) {
    const segments = destRel.split("/");
    if (segments.length < 4) continue;
    const prefix = segments.slice(0, 3).join("/");
    const winner = skillPrefixWinners.get(foldPath(prefix));
    if (winner !== undefined && winner !== prefix) {
      if (!reportedCollisions.has(prefix)) {
        reportedCollisions.add(prefix);
        omittedSkills.push(`case-collision:${prefix}`);
      }
      desired.delete(destRel);
    }
  }

  for (const omitted of omittedSkills) {
    console.warn(`[AssistantContentMirror] Omitting ineligible skill: ${omitted}`);
  }

  // Eligibility runs BEFORE the manifest write so an ineligible file never
  // holds a manifest entry: a previously mirrored file whose source has since
  // grown past the cap becomes stale below and its old copy is removed. Only
  // a proven-absent source may retire its copy — an unreadable one means the
  // desired state is unprovable.
  for (const [destRel, sourceAbs] of desired) {
    try {
      const stat = await fs.stat(sourceAbs);
      if (stat.size > MAX_FILE_BYTES) {
        console.warn(
          `[AssistantContentMirror] Skipping oversized file (${stat.size} bytes): ${sourceAbs}`
        );
        desired.delete(destRel);
      }
    } catch (err) {
      if (!isAbsentError(err)) {
        throw new Error(
          `Unreadable assistant content directory: ${sourceAbs} — cannot compute the desired skill state`,
          { cause: err }
        );
      }
      desired.delete(destRel); // vanished between walk and stat
    }
  }

  const sessionBase = path.resolve(input.sessionPath);
  const chainCache = new Map<string, ChainVerdict>();
  const previous = await readManifest(input.sessionPath);

  let removed = 0;
  const staleRels: string[] = [];
  for (const staleRel of previous) {
    if (desired.has(staleRel)) continue;
    if (!isUnderMirrorRoot(staleRel)) continue;
    staleRels.push(staleRel);
    const segments = staleRel.split("/");
    const staleAbs = path.resolve(sessionBase, ...segments);
    if (!staleAbs.startsWith(sessionBase + path.sep)) continue;
    if ((await verifyRealDirChain(sessionBase, segments.slice(0, -1), chainCache)) !== "ok") {
      console.warn(
        "[AssistantContentMirror] Skipping stale-file removal through a symlinked directory:",
        staleRel
      );
      continue;
    }
    try {
      await fs.rm(staleAbs, { force: true });
      removed += 1;
      await removeEmptyParents(staleAbs, sessionBase);
    } catch (err) {
      console.warn("[AssistantContentMirror] Failed to remove stale mirrored file:", staleAbs, err);
    }
  }

  // Superset manifest: every desired path is owned before its copy starts,
  // and stale paths stay owned until verification proves them gone.
  await writeManifest(input.sessionPath, [...desired.keys(), ...staleRels]);

  let copied = 0;
  const copyFailedRels = new Set<string>();
  for (const [destRel, sourceAbs] of desired) {
    const segments = destRel.split("/");
    const destAbs = path.resolve(sessionBase, ...segments);
    if (!destAbs.startsWith(sessionBase + path.sep)) {
      copyFailedRels.add(destRel);
      continue;
    }
    if ((await verifyRealDirChain(sessionBase, segments.slice(0, -1), chainCache)) !== "ok") {
      console.warn(
        "[AssistantContentMirror] Skipping copy through a symlinked directory:",
        destRel
      );
      copyFailedRels.add(destRel);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      // Replace (don't write through) an existing symlink at the destination —
      // copyFile follows file symlinks, which would land the bytes elsewhere.
      try {
        const st = await fs.lstat(destAbs);
        if (st.isSymbolicLink()) await fs.rm(destAbs, { force: true });
      } catch {
        // ENOENT — nothing at the destination yet
      }
      await fs.copyFile(sourceAbs, destAbs);
      copied += 1;
    } catch (err) {
      console.warn("[AssistantContentMirror] Failed to mirror file:", sourceAbs, err);
      copyFailedRels.add(destRel);
    }
  }

  // Final verification. Stale paths must be absent; a stale file still on
  // disk (failed delete, symlinked dir, racing writer) is a fail-closed
  // signal — the old skill would remain silently active. A desired path whose
  // copy failed is stale-equivalent when something still exists there (the
  // previous version's content can't be proven refreshed) and a plain warning
  // when the slot is simply empty.
  const staleFailures: string[] = [];
  const failedCopies: string[] = [];
  const desiredByFold = new Map<string, string>();
  for (const rel of desired.keys()) desiredByFold.set(foldPath(rel), rel);
  for (const staleRel of staleRels) {
    const staleAbs = path.resolve(sessionBase, ...staleRel.split("/"));
    const state = await destFileState(staleAbs);
    if (state === "absent") continue;
    // On a case-insensitive filesystem a case-only rename leaves the stale
    // spelling resolving to the freshly copied desired file. Same dev+ino as
    // the desired path means nothing stale actually remains — without this,
    // every retry would re-report the alias and permanently block launch.
    const aliasRel = desiredByFold.get(foldPath(staleRel));
    if (aliasRel && state === "file" && !copyFailedRels.has(aliasRel)) {
      try {
        const [staleSt, aliasSt] = await Promise.all([
          fs.stat(staleAbs),
          fs.stat(path.resolve(sessionBase, ...aliasRel.split("/"))),
        ]);
        if (staleSt.dev === aliasSt.dev && staleSt.ino === aliasSt.ino) continue;
      } catch {
        // fall through — treat as stale
      }
    }
    staleFailures.push(staleRel);
  }
  for (const destRel of desired.keys()) {
    const state = await destFileState(path.resolve(sessionBase, ...destRel.split("/")));
    if (copyFailedRels.has(destRel)) {
      if (state === "absent") failedCopies.push(destRel);
      else staleFailures.push(destRel);
    } else if (state !== "file") {
      // Copy reported success but the file is gone or not a regular file —
      // treat as unverifiable rather than silently trusting the session dir.
      staleFailures.push(destRel);
    }
  }

  // Compact the superset manifest to verified ownership: desired paths plus
  // stale paths still present. Successfully removed rels are retired so a
  // future unmanaged user file at the same relpath is never claimed; if this
  // write fails it propagates (fail closed) while the superset stays valid.
  await writeManifest(input.sessionPath, [...desired.keys(), ...staleFailures]);

  return { copied, removed, truncated, omittedSkills, failedCopies, staleFailures };
}

/**
 * Best-effort removal of now-empty directories left behind by a stale-file
 * delete, walking up until a mirror root (exclusive) or a non-empty dir.
 */
async function removeEmptyParents(fileAbs: string, sessionBase: string): Promise<void> {
  const rootAbsPaths = MIRROR_DEST_ROOTS.map((root) =>
    path.resolve(sessionBase, ...root.split("/"))
  );
  let current = path.dirname(fileAbs);
  while (
    current.startsWith(sessionBase + path.sep) &&
    !rootAbsPaths.includes(current) &&
    current !== sessionBase
  ) {
    try {
      await fs.rmdir(current);
    } catch {
      return; // not empty (or already gone) — stop
    }
    current = path.dirname(current);
  }
}

const CONTENT_README = `# Daintree Assistant — custom commands and skills

Files in this folder are copied into the Daintree Assistant's working
directory every time you open the assistant, so the agent you launch picks
them up through its own native discovery.

Layout (agent-native hidden folders):

- .claude/commands/   Claude Code slash commands (*.md with YAML frontmatter)
- .claude/skills/     Claude-only skills (<name>/SKILL.md)
- .codex/skills/      Codex-only skills (<name>/SKILL.md) — delivered to
                      Codex through its .agents/skills discovery path
- .agents/skills/     Shared skills — loaded by every supported backend
                      (translated into .claude/skills for Claude sessions)

A backend-specific skill overrides a shared skill of the same name, whole
directory for whole directory. Every skill directory needs a SKILL.md file
(conventionally with name and description frontmatter) or it is skipped.

A per-project variant works the same way and takes precedence over this
folder: <your project>/.daintree/assistant/

Notes:
- Relaunch the assistant (or start a new session) to pick up changes.
- Codex no longer supports prompt files; write skills instead.
- On macOS, press Cmd+Shift+. in Finder to show the hidden folders.
`;

/**
 * Creates the global content folder with a README and the standard authoring
 * layout (including the .codex/skills source lane) so the "Open assistant
 * commands folder" affordance always reveals something self-explanatory.
 * Existing files are never overwritten.
 */
export async function ensureAssistantContentDir(dir?: string): Promise<string> {
  const target = dir ?? getGlobalAssistantContentDir();
  for (const root of SOURCE_SCAFFOLD_ROOTS) {
    await fs.mkdir(path.resolve(target, ...root.split("/")), { recursive: true });
  }
  const readmePath = path.join(target, "README.md");
  try {
    await fs.writeFile(readmePath, CONTENT_README, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return target;
}
