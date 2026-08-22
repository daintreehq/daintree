import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDemoRoot } from "../../e2e/helpers/screenshotFixtures";
import { validateScene, type DemoScene } from "../../e2e/helpers/demoScene";

/**
 * Where a demo's harness state lives.
 *
 * Deliberately a sibling of the scene rather than a child: `buildScene` deletes
 * and recreates `<slug>`, `<slug>-worktrees` and `<slug>-origin.git` on every
 * build, so a snapshot kept inside any of those would be destroyed by the next
 * rebuild — which is exactly the operation a recording session repeats most.
 */
export interface DemoPaths {
  slug: string;
  harnessDir: string;
  snapshotDir: string;
  workDir: string;
  cardPath: string;
}

/**
 * Marker proving the harness created a directory before it deletes one.
 *
 * `clean` removes the whole harness directory and `--force` removes the take
 * profile inside it. Both paths are derived from the slug, and the demo root
 * defaults to `C:\Projects` on Windows — so without this, a scene named after
 * an existing folder there takes it with it.
 */
const HARNESS_MARKER = ".daintree-demo-harness";

export function harnessMarkerPath(harnessDir: string): string {
  return path.join(harnessDir, HARNESS_MARKER);
}

export function claimHarnessDir(paths: DemoPaths): void {
  if (existsSync(paths.harnessDir) && !existsSync(harnessMarkerPath(paths.harnessDir))) {
    throw new Error(
      `Refusing to use ${paths.harnessDir}: it is not a demo harness directory this tool created. ` +
        `Move it aside, or point DAINTREE_DEMO_ROOT somewhere dedicated.`
    );
  }
  mkdirSync(paths.harnessDir, { recursive: true });
  writeFileSync(
    harnessMarkerPath(paths.harnessDir),
    JSON.stringify({ slug: paths.slug }, null, 2) + "\n"
  );
}

export function ownsHarnessDir(paths: DemoPaths): boolean {
  return existsSync(harnessMarkerPath(paths.harnessDir));
}

/**
 * Whether an app still holds this scene's take profile.
 *
 * The dirty-exit marker is the only cheap evidence available: a take launched
 * from another shell leaves no handle behind. It is not conclusive — the app
 * writes it during crash-recovery init, so a just-started take has none yet —
 * but checking it BEFORE any repository mutation is what stops a second take
 * rebuilding the tree underneath a live one.
 */
export function takeLooksLive(paths: DemoPaths): boolean {
  return existsSync(path.join(paths.workDir, "running.lock"));
}

export function demoPaths(slug: string): DemoPaths {
  const harnessDir = path.join(path.resolve(getDemoRoot()), `${slug}-harness`);
  return {
    slug,
    harnessDir,
    snapshotDir: path.join(harnessDir, "snapshot"),
    workDir: path.join(harnessDir, "take"),
    cardPath: path.join(harnessDir, "shot-card.md"),
  };
}

/**
 * Read a scene file and validate it.
 *
 * Scenes are throwaway JSON authored per video and never committed, so the
 * failure mode to design for is a hand-edited file with a typo — hence a
 * parse error that names the file and validation that reports every problem
 * at once rather than one per run.
 */
export function loadScene(scenePath: string): { scene: DemoScene; scenePath: string } {
  const resolved = path.resolve(scenePath);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`Cannot read scene file: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${resolved} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }

  validateScene(parsed);
  return { scene: parsed, scenePath: resolved };
}
