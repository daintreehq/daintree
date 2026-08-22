import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { devNull } from "os";
import path from "path";
import { removePathSync } from "./fixtures";
import { getDemoRoot, writeFiles } from "./screenshotFixtures";

/**
 * Declarative scene spec for a recording session.
 *
 * The whole point of this shape is that it is plain JSON: the *machinery*
 * (this file, the profile baker, the take runner) is permanent repo
 * scaffolding, while a scene for one specific video is a throwaway data file
 * that never gets committed. Anything that would tempt an author to write
 * TypeScript per video belongs here as a field instead.
 *
 * `createDemoRepo` in `screenshotFixtures.ts` stays the path for the marketing
 * screenshot pipeline; this builder is the richer one (remotes, ahead counts,
 * dirty working trees) that a screencast needs. They share one demo root and
 * one file writer so there is a single answer to "where do demo repos live".
 */
export interface DemoScene {
  /** Folder basename, and what the title bar will read. */
  slug: string;
  /** Committed on the default branch at scene root. */
  files: Record<string, string>;
  /** Default branch name. Git's own default is avoided — be explicit. */
  defaultBranch?: string;
  /**
   * Create a bare repo alongside the scene and wire it as `origin`.
   *
   * A local bare remote is deliberate: push, fetch, and ahead/behind counts
   * all work with no network and no credentials, which is what makes a take
   * repeatable on a plane. What it cannot produce is PR/CI chips — those come
   * from a forge plugin, and no local remote will ever supply them.
   */
  remote?: boolean;
  /** Written to `.daintree/recipes/` before the initial commit. */
  recipes?: Array<{ filename: string; content: object }>;
  worktrees?: DemoSceneWorktree[];
  /**
   * The shot list. Beats do not affect what gets built — they are what the
   * shot card is rendered from.
   *
   * They live in the same file as the state on purpose. A card kept separately
   * drifts from what the app actually boots into, and a shot card that
   * disagrees with the screen is worse than no shot card at all.
   */
  beats?: DemoSceneBeat[];
}

export interface DemoSceneBeat {
  /** Short label for the beat, used as its heading. */
  name: string;
  /** What is already true on screen when this beat starts. */
  given?: string;
  /** What the person recording does. */
  action: string;
  /** What to wait for before moving on — the cue, not a stopwatch. */
  waitFor?: string;
  /** How to tell it worked, so a bad take is caught in the room. */
  expect?: string;
  /** On-screen text for the edit, if this beat carries one. */
  super?: string;
  /** Target duration in seconds. */
  seconds?: number;
}

export interface DemoSceneWorktree {
  /** Branch to create and check out into its own worktree. */
  branch: string;
  /** Committed on the branch as its first commit. */
  files?: Record<string, string>;
  /**
   * Commits applied *after* the branch is pushed, so the branch reads as
   * ahead of origin by exactly this many commits.
   *
   * Requires `push`. Daintree suppresses the ahead count entirely when a
   * branch has no upstream (`GitStatusPass` reads `hasUpstream ? ahead :
   * undefined`), so ahead-commits without a push produce local history that
   * the UI never surfaces — the scene author gets silence instead of the
   * number they asked for.
   */
  aheadCommits?: Array<{ message: string; files: Record<string, string> }>;
  /**
   * Left dirty in the working tree. This is what Review Hub actually shows —
   * a scene whose worktrees are all clean gives the review beat nothing to
   * display.
   */
  uncommittedFiles?: Record<string, string>;
  /** Push the branch and set upstream. Requires `remote` on the scene. */
  push?: boolean;
}

export interface BuiltSceneWorktree {
  branch: string;
  path: string;
}

export interface BuiltScene {
  slug: string;
  /** Absolute path to the scene's main working tree. */
  dir: string;
  /** Absolute path to the bare origin, when the scene asked for one. */
  remotePath: string | null;
  worktrees: BuiltSceneWorktree[];
  /**
   * Remove everything this build created. A no-op once a later build of the
   * same slug has taken ownership, so a stale handle cannot delete live work.
   */
  cleanup: () => void;
}

const DEFAULT_BRANCH = "main";

/**
 * Ownership marker. The builder deletes directories before it writes them, and
 * `getDemoRoot()` can point at a shared location — its Windows default is
 * `C:\Projects`. Deleting a path merely because its basename matches a scene
 * slug would destroy a real project, so nothing pre-existing is removed unless
 * it carries this marker (or is empty). The `buildId` makes the marker a
 * generation token as well: `cleanup()` from an earlier build refuses to touch
 * a directory a later build has since claimed.
 */
const MARKER_NAME = ".daintree-demo-scene";

interface OwnershipMarker {
  slug: string;
  buildId: string;
}

/** Marker for the main tree hides in `.git/` so `git add -A` cannot commit it. */
function markerPathFor(target: string, kind: "repo" | "plain"): string {
  return kind === "repo" ? path.join(target, ".git", MARKER_NAME) : path.join(target, MARKER_NAME);
}

function readMarker(target: string): OwnershipMarker | null {
  for (const kind of ["repo", "plain"] as const) {
    const markerPath = markerPathFor(target, kind);
    if (!existsSync(markerPath)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
      if (
        isRecord(parsed) &&
        typeof parsed.slug === "string" &&
        typeof parsed.buildId === "string"
      ) {
        return { slug: parsed.slug, buildId: parsed.buildId };
      }
    } catch {
      // A corrupt marker is not proof of ownership — fall through and refuse.
    }
  }
  return null;
}

function writeMarker(target: string, kind: "repo" | "plain", marker: OwnershipMarker): void {
  const markerPath = markerPathFor(target, kind);
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");
}

function isEmptyDir(target: string): boolean {
  try {
    return readdirSync(target).length === 0;
  } catch {
    return false;
  }
}

/**
 * Delete a build target, refusing anything this harness cannot prove it owns.
 *
 * Fails closed and loudly: a swallowed failure here means the builder goes on
 * to run `git init` and `git add -A` inside whatever survived, which is how a
 * demo build ends up committing to somebody's real repository.
 */
function removeOwnedTarget(target: string, expected: { slug: string; buildId?: string }): void {
  if (!existsSync(target)) return;

  const marker = readMarker(target);
  if (!marker) {
    if (isEmptyDir(target)) {
      removePathSync(target);
      return;
    }
    throw new Error(
      `Refusing to delete ${target}: it is not a demo scene this harness created. ` +
        `Move it aside, or point DAINTREE_DEMO_ROOT at a dedicated directory.`
    );
  }
  if (marker.slug !== expected.slug) {
    throw new Error(
      `Refusing to delete ${target}: it belongs to demo scene "${marker.slug}", not "${expected.slug}".`
    );
  }
  if (expected.buildId !== undefined && marker.buildId !== expected.buildId) {
    // A newer build owns this path — a stale cleanup handle must not win.
    return;
  }
  removePathSync(target);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path a scene may write to: relative, and inside the tree it names. */
function isSafeRelativePath(candidate: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (path.isAbsolute(candidate)) return false;
  // Rooted or drive-qualified Windows paths that POSIX `isAbsolute` misses.
  if (/^[a-zA-Z]:/.test(candidate) || /^[\\/]/.test(candidate)) return false;
  const segments = path.normalize(candidate).split(/[\\/]/);
  if (segments.includes("..")) return false;
  // `.git` is not a content path. A scene writing `.git/config` can alter the
  // repository before the builder's own `git add`, and in a linked worktree
  // `.git` is the gitdir pointer file — overwriting it yields a "successful"
  // build whose worktree is broken.
  return !segments.some((segment) => segment.toLowerCase() === ".git");
}

/** Directory names that are unusable or ambiguous on a supported platform. */
const RESERVED_DIR_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Map a branch to its worktree directory name.
 *
 * Deliberately readable rather than hashed: this path is on screen in the app's
 * worktree list and title bar during a recording, so `feature-refund-retries`
 * has to survive the round trip. Flattening is not injective, so uniqueness is
 * validated up front instead of being papered over with a digest.
 */
export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, "-");
}

function collectFileErrors(files: unknown, label: string, errors: string[]): void {
  if (files === undefined) return;
  if (!isRecord(files)) {
    errors.push(`${label}: expected an object of path → contents`);
    return;
  }
  for (const [key, value] of Object.entries(files)) {
    if (!isSafeRelativePath(key)) {
      errors.push(`${label}: "${key}" must be a relative path inside the tree, and not under .git`);
    }
    if (typeof value !== "string") {
      errors.push(`${label}: "${key}" must map to a string`);
    }
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${label}: unknown field "${key}"`);
    }
  }
}

const SCENE_KEYS = [
  "slug",
  "files",
  "defaultBranch",
  "remote",
  "recipes",
  "worktrees",
  "beats",
] as const;
const WORKTREE_KEYS = ["branch", "files", "aheadCommits", "uncommittedFiles", "push"] as const;
const BEAT_KEYS = ["name", "given", "action", "waitFor", "expect", "super", "seconds"] as const;
const BEAT_TEXT_FIELDS = ["name", "given", "action", "waitFor", "expect", "super"] as const;

/**
 * Validate a scene and throw once with every problem found.
 *
 * Takes `unknown` on purpose. A scene arrives as JSON from disk, so the
 * TypeScript interface is documentation, not a runtime guarantee — without
 * real checks a typo like `aheadCommit` is silently dropped and the author
 * gets a level branch with no explanation.
 *
 * Reporting all errors together rather than the first one matters too: a scene
 * is hand-authored data, and a builder that fails one field per run turns
 * authoring into a guessing game.
 */
export function validateScene(scene: unknown): asserts scene is DemoScene {
  const errors: string[] = [];

  if (!isRecord(scene)) {
    throw new Error("Invalid demo scene:\n  - expected a JSON object");
  }
  rejectUnknownKeys(scene, SCENE_KEYS, "scene", errors);

  const slug = scene.slug;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    errors.push(`slug: ${JSON.stringify(slug)} must be lowercase alphanumeric with dashes`);
  } else if (slug.endsWith("-worktrees") || slug.endsWith("-origin")) {
    // Those suffixes name this scene's own sibling directories.
    errors.push(`slug: "${slug}" must not end in "-worktrees" or "-origin"`);
  }

  if (!isRecord(scene.files) || Object.keys(scene.files).length === 0) {
    errors.push("files: a scene needs at least one committed file");
  }
  collectFileErrors(scene.files, "files", errors);

  if (scene.defaultBranch !== undefined && typeof scene.defaultBranch !== "string") {
    errors.push("defaultBranch: expected a string");
  }
  if (scene.remote !== undefined && typeof scene.remote !== "boolean") {
    errors.push("remote: expected a boolean");
  }

  if (scene.recipes !== undefined) {
    if (!Array.isArray(scene.recipes)) {
      errors.push("recipes: expected an array");
    } else {
      for (const [index, recipe] of scene.recipes.entries()) {
        const label = `recipes[${index}]`;
        if (!isRecord(recipe)) {
          errors.push(`${label}: expected an object`);
          continue;
        }
        const filename = recipe.filename;
        if (typeof filename !== "string" || !isSafeRelativePath(filename)) {
          errors.push(`${label}.filename: must be a relative path inside .daintree/recipes`);
        } else if (!filename.endsWith(".json")) {
          // Daintree's recipe loader ignores anything that is not `.json`, so a
          // misnamed recipe is invisible rather than broken.
          errors.push(`${label}.filename: must end in ".json"`);
        }
        if (!isRecord(recipe.content)) {
          errors.push(`${label}.content: expected an object`);
        }
      }
    }
  }

  if (scene.beats !== undefined) {
    if (!Array.isArray(scene.beats)) {
      errors.push("beats: expected an array");
    } else {
      for (const [index, beat] of scene.beats.entries()) {
        const label = `beats[${index}]`;
        if (!isRecord(beat)) {
          errors.push(`${label}: expected an object`);
          continue;
        }
        rejectUnknownKeys(beat, BEAT_KEYS, label, errors);
        for (const field of ["name", "action"] as const) {
          if (typeof beat[field] !== "string" || (beat[field] as string).trim().length === 0) {
            errors.push(`${label}.${field} is required`);
          }
        }
        for (const field of ["given", "waitFor", "expect", "super"] as const) {
          if (beat[field] !== undefined && typeof beat[field] !== "string") {
            errors.push(`${label}.${field}: expected a string`);
          }
        }
        // Beat text becomes one Markdown line each. A newline would break the
        // project's one-physical-line rule and, worse, let a beat inject its own
        // headings or fences into the shot card.
        for (const field of BEAT_TEXT_FIELDS) {
          const value = beat[field];
          if (typeof value === "string" && /[\r\n]/.test(value)) {
            errors.push(`${label}.${field}: must be a single line`);
          }
        }
        if (
          beat.seconds !== undefined &&
          (typeof beat.seconds !== "number" || !Number.isFinite(beat.seconds) || beat.seconds <= 0)
        ) {
          errors.push(`${label}.seconds: expected a positive number`);
        }
      }

      // All-or-nothing, because the shot card lays beats out on a running
      // timeline. One untimed beat in the middle contributes zero, so every
      // beat after it claims a start time earlier than it will really happen —
      // a card that is wrong in a way nobody notices until the edit.
      const timed = scene.beats.filter((beat) => isRecord(beat) && beat.seconds !== undefined);
      if (timed.length > 0 && timed.length !== scene.beats.length) {
        errors.push(
          `beats: ${timed.length} of ${scene.beats.length} beats declare seconds — time all of them or none, or the timeline misreports every beat after the first untimed one`
        );
      }
    }
  }

  const defaultBranch =
    typeof scene.defaultBranch === "string" ? scene.defaultBranch : DEFAULT_BRANCH;

  if (scene.worktrees !== undefined && !Array.isArray(scene.worktrees)) {
    errors.push("worktrees: expected an array");
  }

  const worktrees: unknown[] = Array.isArray(scene.worktrees) ? scene.worktrees : [];
  const seenBranches = new Set<string>();
  const seenDirNames = new Map<string, string>();
  const branchNames: string[] = [];

  for (const [index, worktree] of worktrees.entries()) {
    const label = `worktrees[${index}]`;
    if (!isRecord(worktree)) {
      errors.push(`${label}: expected an object`);
      continue;
    }
    rejectUnknownKeys(worktree, WORKTREE_KEYS, label, errors);

    const branch = worktree.branch;
    if (typeof branch !== "string" || branch.length === 0) {
      errors.push(`${label}: branch is required`);
      continue;
    }
    branchNames.push(branch);

    if (branch === defaultBranch) {
      errors.push(`${label}: branch "${branch}" is the default branch`);
    }
    if (seenBranches.has(branch)) {
      errors.push(`${label}: branch "${branch}" is used more than once`);
    }
    seenBranches.add(branch);

    const dirName = worktreeDirName(branch);
    const collidesWith = seenDirNames.get(dirName.toLowerCase());
    if (collidesWith !== undefined) {
      errors.push(
        `${label}: branch "${branch}" and "${collidesWith}" both map to worktree directory "${dirName}"`
      );
    }
    seenDirNames.set(dirName.toLowerCase(), branch);

    if (RESERVED_DIR_NAMES.has(dirName.toLowerCase()) || /[<>:"|?*\\]/.test(dirName)) {
      errors.push(`${label}: branch "${branch}" is not usable as a directory name on Windows`);
    }

    collectFileErrors(worktree.files, `${label}.files`, errors);
    collectFileErrors(worktree.uncommittedFiles, `${label}.uncommittedFiles`, errors);

    if (worktree.push !== undefined && typeof worktree.push !== "boolean") {
      errors.push(`${label}.push: expected a boolean`);
    }

    const aheadCommits = worktree.aheadCommits;
    if (aheadCommits !== undefined && !Array.isArray(aheadCommits)) {
      errors.push(`${label}.aheadCommits: expected an array`);
    }
    const aheadList: unknown[] = Array.isArray(aheadCommits) ? aheadCommits : [];
    for (const [commitIndex, commit] of aheadList.entries()) {
      const commitLabel = `${label}.aheadCommits[${commitIndex}]`;
      if (!isRecord(commit)) {
        errors.push(`${commitLabel}: expected an object`);
        continue;
      }
      if (typeof commit.message !== "string" || commit.message.length === 0) {
        errors.push(`${commitLabel}: message is required`);
      }
      if (!isRecord(commit.files) || Object.keys(commit.files).length === 0) {
        errors.push(`${commitLabel}: needs at least one file`);
      }
      collectFileErrors(commit.files, `${commitLabel}.files`, errors);
    }

    if (aheadList.length > 0 && worktree.push !== true) {
      errors.push(
        `${label}: aheadCommits requires push — without an upstream Daintree reports no ahead count`
      );
    }
    if (worktree.push === true && scene.remote !== true) {
      errors.push(`${label}: push requires the scene to declare a remote`);
    }
  }

  // Git refuses to hold both `feature` and `feature/x`; catching it here beats
  // a `worktree add` failure halfway through a build.
  for (const branch of branchNames) {
    for (const other of branchNames) {
      if (other !== branch && other.startsWith(`${branch}/`)) {
        errors.push(
          `worktrees: branch "${branch}" is a prefix of "${other}" — git allows only one`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid demo scene:\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * Git invocations are insulated from host configuration.
 *
 * A developer's global config is a live hazard for a reproducible build:
 * `commit.gpgsign` makes every commit fail, `core.hooksPath` runs arbitrary
 * hooks, a global excludes file silently drops declared files from the initial
 * commit, and an auto-push hook erases the ahead gap the scene asked for.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_TERMINAL_PROMPT: "0",
};

const GIT_OVERRIDES = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "init.templateDir=",
  "-c",
  "gc.auto=0",
];

/** Run git, surfacing stderr on failure — a silent build is unfixable. */
function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", [...GIT_OVERRIDES, ...args], {
      cwd,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const detail = typeof stderr === "string" ? stderr : (stderr?.toString() ?? String(error));
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${detail.trim()}`, {
      cause: error,
    });
  }
}

function commitAll(cwd: string, message: string): void {
  git(["add", "-A"], cwd);
  git(["commit", "-m", message], cwd);
}

/** Identity is set per-repo so a build never depends on the host's git config. */
function configureIdentity(cwd: string): void {
  git(["config", "user.email", "demo@daintree.dev"], cwd);
  git(["config", "user.name", "Daintree Demo"], cwd);
}

/**
 * Materialise a scene on disk and return the paths a recording session needs.
 *
 * Ordering is load-bearing. A branch is pushed *before* its ahead-commits are
 * written, because that gap is the only thing that makes the branch read as
 * ahead of origin; committing first and pushing afterwards produces a branch
 * that is level, and the ahead count silently disappears.
 */
export function buildScene(scene: unknown): BuiltScene {
  validateScene(scene);

  const defaultBranch = scene.defaultBranch ?? DEFAULT_BRANCH;
  const root = path.resolve(getDemoRoot());
  mkdirSync(root, { recursive: true });

  const dir = path.join(root, scene.slug);
  const worktreesParent = path.join(root, `${scene.slug}-worktrees`);
  // Always named, never conditional: a rebuild that drops `remote` still has to
  // clear the origin an earlier remote-enabled build left behind.
  const originPath = path.join(root, `${scene.slug}-origin.git`);
  const remotePath = scene.remote ? originPath : null;

  const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const marker: OwnershipMarker = { slug: scene.slug, buildId };
  const targets = [dir, worktreesParent, originPath];

  // Clear leftovers so `git init` and `worktree add` start from a known-empty
  // tree. Throws rather than continuing if a target is not ours.
  for (const target of targets) {
    removeOwnedTarget(target, { slug: scene.slug });
  }

  const cleanup = () => {
    for (const target of targets) {
      try {
        removeOwnedTarget(target, { slug: scene.slug, buildId });
      } catch {
        // Cleanup runs on the failure path too; refusing one target must not
        // stop the others from being released.
      }
    }
  };

  try {
    mkdirSync(dir, { recursive: true });
    git(["init", "-b", defaultBranch], dir);
    writeMarker(dir, "repo", marker);
    configureIdentity(dir);

    writeFiles(dir, scene.files);
    if (scene.recipes?.length) {
      const recipesDir = path.join(dir, ".daintree", "recipes");
      mkdirSync(recipesDir, { recursive: true });
      writeFiles(
        recipesDir,
        Object.fromEntries(
          scene.recipes.map((recipe) => [
            recipe.filename,
            JSON.stringify(recipe.content, null, 2) + "\n",
          ])
        )
      );
    }
    commitAll(dir, "initial commit");

    if (remotePath) {
      mkdirSync(remotePath, { recursive: true });
      git(["init", "--bare", "-b", defaultBranch], remotePath);
      writeMarker(remotePath, "plain", marker);
      git(["remote", "add", "origin", remotePath], dir);
      git(["push", "-u", "origin", defaultBranch], dir);
    }

    const worktrees: BuiltSceneWorktree[] = [];
    for (const worktree of scene.worktrees ?? []) {
      const worktreePath = path.join(worktreesParent, worktreeDirName(worktree.branch));
      mkdirSync(worktreesParent, { recursive: true });
      writeMarker(worktreesParent, "plain", marker);
      git(["worktree", "add", "-b", worktree.branch, worktreePath, defaultBranch], dir);
      configureIdentity(worktreePath);

      if (worktree.files && Object.keys(worktree.files).length > 0) {
        writeFiles(worktreePath, worktree.files);
        commitAll(worktreePath, `${worktree.branch} work`);
      }

      if (worktree.push && remotePath) {
        git(["push", "-u", "origin", worktree.branch], worktreePath);
      }

      for (const commit of worktree.aheadCommits ?? []) {
        writeFiles(worktreePath, commit.files);
        commitAll(worktreePath, commit.message);
      }

      if (worktree.uncommittedFiles) {
        writeFiles(worktreePath, worktree.uncommittedFiles);
      }

      worktrees.push({ branch: worktree.branch, path: worktreePath });
    }

    return { slug: scene.slug, dir, remotePath, worktrees, cleanup };
  } catch (error) {
    // A half-built scene is worse than none — the app would open a project
    // whose worktrees only partly exist.
    cleanup();
    throw error;
  }
}
