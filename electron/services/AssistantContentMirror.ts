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
 *   .claude/skills/     Claude Code skills (<name>/SKILL.md)
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
 *     and skills are exempt from the project-config trust gate. .codex/skills
 *     is NOT mirrored — that path rides the trust-gated project-config layer.
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
   * (never a per-file interleave of two different skills). `file`: each file
   * stands alone (commands).
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
  codex: [{ sourceDir: ".agents/skills", destDir: ".agents/skills", granularity: "skillDir" }],
  copilot: [
    { sourceDir: ".agents/skills", destDir: ".agents/skills", granularity: "skillDir" },
    { sourceDir: ".claude/skills", destDir: ".claude/skills", granularity: "skillDir" },
  ],
};

// Union of every mapping's destDir. Stale-entry deletion is restricted to
// these roots so a corrupt manifest can never reach template files
// (.mcp.json, .claude/settings.json, CLAUDE.md, ...). Kept as a superset of
// all agents' mappings on purpose: switching the same project's session from
// claude to codex must clean up the claude-mirrored files.
const MIRROR_DEST_ROOTS = [".claude/commands", ".claude/skills", ".agents/skills"] as const;

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

export interface AssistantContentSyncResult {
  copied: number;
  removed: number;
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

async function readManifest(sessionPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(sessionPath, MANIFEST_FILE), "utf-8");
    const parsed = JSON.parse(raw) as ManifestShape;
    if (!parsed || !Array.isArray(parsed.files)) return [];
    return parsed.files.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

async function writeManifest(sessionPath: string, files: string[]): Promise<void> {
  const manifest: ManifestShape = { version: 1, files: [...files].sort() };
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
}

/**
 * Collects relative posix paths → absolute source paths under `rootAbs`.
 * Follows symlinks (users commonly symlink shared skill folders) with a
 * realpath visited-set so cycles terminate; dot-entries are skipped to match
 * how the CLIs' own scanners treat them.
 */
async function collectSourceFiles(rootAbs: string): Promise<WalkState> {
  const state: WalkState = { files: new Map(), visitedDirs: new Set(), truncated: false };
  try {
    const rootReal = await fs.realpath(rootAbs);
    state.visitedDirs.add(rootReal);
  } catch {
    return state; // source dir absent — nothing to collect
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
  } catch {
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
      } catch {
        continue; // broken symlink
      }
    }

    if (isDir) {
      try {
        const real = await fs.realpath(entryAbs);
        if (state.visitedDirs.has(real)) continue; // symlink cycle
        state.visitedDirs.add(real);
      } catch {
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
    } catch {
      // ENOENT (or unreadable): nothing below exists yet, so there is nothing
      // a symlink could redirect. mkdir will create real dirs from here down.
      verdict = "ok";
    }
    cache.set(current, verdict);
    if (verdict === "unsafe") return "unsafe";
  }
  return "ok";
}

/**
 * Syncs user assistant content into the session directory for the given
 * agent. Returns null for agents with no cwd-based content mechanism.
 *
 * Sync is manifest-driven: files mirrored by the previous sync that are no
 * longer desired are removed (so deleting a command in the source folder
 * actually retires it), then every desired file is copied fresh. The manifest
 * is written after deletions but before copies — a mid-copy crash leaves it
 * as a superset of what's on disk, and superfluous entries delete as harmless
 * no-ops on the next sync. Stale entries whose deletion FAILED stay in the
 * manifest so the next sync retries instead of orphaning the file.
 */
export async function syncAssistantContent(
  input: AssistantContentSyncInput
): Promise<AssistantContentSyncResult | null> {
  const mappings = AGENT_CONTENT_MAPPINGS[input.agentId];
  if (!mappings) return null;

  const sources = [
    input.globalContentDir ?? getGlobalAssistantContentDir(),
    getProjectAssistantContentDir(input.projectPath),
  ];

  // destRel (posix) → source absolute path. Insertion order encodes
  // precedence: global before project, and within a source the mapping order
  // above — later writes overwrite earlier ones. For skillDir mappings the
  // replacement unit is the whole top-level skill directory: all previously
  // collected files under the same dest skill prefix are dropped first, so an
  // explicit skill never interleaves files with a shadowed shared skill.
  const desired = new Map<string, string>();
  let truncated = false;
  for (const sourceRoot of sources) {
    for (const mapping of mappings) {
      const walk = await collectSourceFiles(path.join(sourceRoot, mapping.sourceDir));
      truncated ||= walk.truncated;
      if (mapping.granularity === "skillDir") {
        const replacedSkills = new Set<string>();
        for (const rel of walk.files.keys()) {
          const slash = rel.indexOf("/");
          if (slash > 0) replacedSkills.add(rel.slice(0, slash));
        }
        for (const skillName of replacedSkills) {
          const prefix = `${mapping.destDir}/${skillName}/`;
          for (const key of desired.keys()) {
            if (key.startsWith(prefix)) desired.delete(key);
          }
        }
      }
      for (const [rel, abs] of walk.files) {
        desired.set(`${mapping.destDir}/${rel}`, abs);
      }
    }
  }
  if (truncated) {
    console.warn(
      `[AssistantContentMirror] Source tree exceeds limits (${MAX_FILES} files / depth ${MAX_DEPTH}); extra content was skipped`
    );
  }

  // Eligibility runs BEFORE the manifest write so an ineligible file never
  // holds a manifest entry: a previously mirrored file whose source has since
  // grown past the cap becomes stale below and its old copy is removed.
  for (const [destRel, sourceAbs] of desired) {
    try {
      const stat = await fs.stat(sourceAbs);
      if (stat.size > MAX_FILE_BYTES) {
        console.warn(
          `[AssistantContentMirror] Skipping oversized file (${stat.size} bytes): ${sourceAbs}`
        );
        desired.delete(destRel);
      }
    } catch {
      desired.delete(destRel); // vanished between walk and stat
    }
  }

  const sessionBase = path.resolve(input.sessionPath);
  const chainCache = new Map<string, ChainVerdict>();
  const previous = await readManifest(input.sessionPath);

  let removed = 0;
  const failedRemovals: string[] = [];
  for (const staleRel of previous) {
    if (desired.has(staleRel)) continue;
    if (!isUnderMirrorRoot(staleRel)) continue;
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
      failedRemovals.push(staleRel);
      console.warn("[AssistantContentMirror] Failed to remove stale mirrored file:", staleAbs, err);
    }
  }

  await writeManifest(input.sessionPath, [...desired.keys(), ...failedRemovals]);

  let copied = 0;
  for (const [destRel, sourceAbs] of desired) {
    const segments = destRel.split("/");
    const destAbs = path.resolve(sessionBase, ...segments);
    if (!destAbs.startsWith(sessionBase + path.sep)) continue;
    if ((await verifyRealDirChain(sessionBase, segments.slice(0, -1), chainCache)) !== "ok") {
      console.warn(
        "[AssistantContentMirror] Skipping copy through a symlinked directory:",
        destRel
      );
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
    }
  }

  return { copied, removed };
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
- .claude/skills/     Claude Code skills (<name>/SKILL.md)
- .agents/skills/     Shared skills — loaded by Codex and Copilot, and
                      translated into .claude/skills for Claude sessions

A per-project variant works the same way and takes precedence over this
folder: <your project>/.daintree/assistant/

Notes:
- Relaunch the assistant (or start a new session) to pick up changes.
- Codex no longer supports prompt files; write skills instead.
- On macOS, press Cmd+Shift+. in Finder to show the hidden folders.
`;

/**
 * Creates the global content folder with a README and the standard layout so
 * the "Open assistant commands folder" affordance always reveals something
 * self-explanatory. Existing files are never overwritten.
 */
export async function ensureAssistantContentDir(dir?: string): Promise<string> {
  const target = dir ?? getGlobalAssistantContentDir();
  for (const root of MIRROR_DEST_ROOTS) {
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
