import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildScene, describeScene } from "../../e2e/helpers/demoScene";
import { bakeProfile, readProfileManifest } from "../../e2e/helpers/demoProfile";
import { startTake, teardownDemo } from "../../e2e/helpers/demoTake";
import { renderShotCard } from "../../e2e/helpers/demoShotCard";
import { removePathSync } from "../../e2e/helpers/fixtures";
import { claimHarnessDir, demoPaths, loadScene, ownsHarnessDir, takeLooksLive } from "./paths";

// Single entry point for the demo staging harness. Adding a command means one
// REGISTRY entry — package.json never grows a per-command script, matching the
// rule the perf dispatcher already follows.
//
//   npm run demo list
//   npm run demo stage .demo/intro.json     # build the scene, bake a profile, write the card
//   npm run demo take .demo/intro.json      # reset and launch for recording
//   npm run demo card .demo/intro.json      # re-render the shot card only
//   npm run demo clean .demo/intro.json     # delete scene, snapshot and profiles

interface Command {
  summary: string;
  usage: string;
  run: (args: string[]) => Promise<number>;
}

function requireScenePath(args: string[], command: string): string {
  const [scenePath] = args;
  if (!scenePath) {
    throw new Error(`npm run demo ${command} needs a scene file, e.g. .demo/intro.json`);
  }
  return scenePath;
}

/**
 * Shortest honest way to name the scene file in a command.
 *
 * A relative path that climbs out of the working directory is worse than the
 * absolute one it replaces — a scene kept outside the repo produced a card
 * telling the recordist to run `npm run demo take ../../../../../../private/tmp/...`.
 */
function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  const shown = relative && !relative.startsWith("..") ? relative : target;
  // Quote anything a shell would split or interpret, so a card's commands can
  // be copied straight out of it.
  return /[\s"'`$&;|<>()*?\\]/.test(shown) ? JSON.stringify(shown) : shown;
}

/** The commands the card tells the recordist to run, so they always match. */
function cardOptions(scenePath: string) {
  const shown = displayPath(scenePath);
  return {
    takeCommand: `npm run demo take ${shown}`,
    teardownCommand: `npm run demo clean ${shown}`,
    // `take` rebuilds the scene unless asked not to, so the card must not warn
    // about repository drift the harness already handles.
    resetsRepo: true,
  };
}

/**
 * Refuse before anything is built or deleted.
 *
 * Every mutating command rebuilds the scene repository, and the profile-level
 * refusal inside `restoreProfile` fires far too late — by then the tree has
 * already been rebuilt underneath whatever is still running.
 */
function refuseIfTakeIsLive(paths: ReturnType<typeof demoPaths>, command: string): boolean {
  if (!takeLooksLive(paths)) return false;
  console.error(
    `[demo] a take is still running against ${paths.workDir}, so ${command} would change the repository underneath it.`
  );
  console.error("[demo] quit the app with Cmd+Q (closing the window is not quitting), then retry.");
  return true;
}

async function stage(args: string[]): Promise<number> {
  const { scene, scenePath } = loadScene(requireScenePath(args, "stage"));
  const paths = demoPaths(scene.slug);
  if (refuseIfTakeIsLive(paths, "staging")) return 1;
  claimHarnessDir(paths);

  console.log(`[demo] staging "${scene.slug}"`);
  const baked = await bakeProfile({ scene, snapshotDir: paths.snapshotDir });

  const card = renderShotCard(scene, baked.scene, cardOptions(scenePath));
  writeFileSync(paths.cardPath, card);

  console.log(`[demo] project   ${baked.projectPath}`);
  console.log(`[demo] snapshot  ${paths.snapshotDir}`);
  console.log(`[demo] shot card ${paths.cardPath}`);
  console.log(`[demo] ready — \`npm run demo take ${displayPath(scenePath)}\``);
  return 0;
}

async function take(args: string[]): Promise<number> {
  const { scene, scenePath } = loadScene(requireScenePath(args, "take"));
  const paths = demoPaths(scene.slug);
  if (refuseIfTakeIsLive(paths, "starting another take")) return 1;

  if (!readProfileManifest(paths.snapshotDir)) {
    console.error(
      `[demo] no baked profile for "${scene.slug}". Run \`npm run demo stage ${displayPath(scenePath)}\` first.`
    );
    return 1;
  }

  // A take killed rather than quit can rebuild its profile during shutdown and
  // leave the dirty-exit marker behind. Nothing is running, but every later
  // take refuses — a dead end with no way out, so there has to be one. The user
  // is asserting the app is gone; say so rather than silently overriding.
  if (args.includes("--force")) {
    // Only ever a profile this harness made. --force exists to clear a stale
    // marker, not to become a recursive delete aimed at an arbitrary path.
    if (existsSync(paths.workDir) && !readProfileManifest(paths.workDir)) {
      console.error(
        `[demo] --force refused: ${paths.workDir} is not a demo profile this tool created.`
      );
      return 1;
    }
    console.log(`[demo] --force: discarding the take profile at ${paths.workDir}`);
    try {
      removePathSync(paths.workDir);
    } catch {
      console.error(`[demo] could not remove ${paths.workDir}`);
      return 1;
    }
  }

  // Rebuilding is the default because a take mutates the repository — commits,
  // agent edits, pushes to the local origin — and the snapshot only restores
  // the app profile. Without this, the second take records against a tree that
  // has drifted from the shot card.
  const keepRepo = args.includes("--keep-repo");
  if (keepRepo) {
    console.log("[demo] keeping the repository as-is (--keep-repo)");
  } else {
    console.log("[demo] rebuilding the scene so the take starts from a clean tree");
    buildScene(scene);
  }

  const handle = startTake({ snapshotDir: paths.snapshotDir, workDir: paths.workDir });
  console.log(`[demo] recording take — pid ${handle.pid}`);
  console.log(`[demo] shot card ${paths.cardPath}`);
  console.log("[demo] quit the app with Cmd+Q when the take is done");
  return 0;
}

async function card(args: string[]): Promise<number> {
  const { scene, scenePath } = loadScene(requireScenePath(args, "card"));
  const paths = demoPaths(scene.slug);

  // Deliberately describeScene, not buildScene: rendering a card must never
  // touch the repository. Rebuilding here would delete whatever the session has
  // recorded against so far, mid-shoot, to produce a document.
  const built = describeScene(scene);
  claimHarnessDir(paths);
  writeFileSync(paths.cardPath, renderShotCard(scene, built, cardOptions(scenePath)));

  console.log(`[demo] shot card ${paths.cardPath}`);
  return 0;
}

async function clean(args: string[]): Promise<number> {
  const { scene } = loadScene(requireScenePath(args, "clean"));
  const paths = demoPaths(scene.slug);

  if (refuseIfTakeIsLive(paths, "teardown")) return 1;

  // describeScene, not buildScene — rebuilding a scene purely to delete it
  // recreates every directory first and fails the whole teardown if the build
  // fails.
  const built = describeScene(scene);
  const result = await teardownDemo({
    snapshotDir: paths.snapshotDir,
    workDirs: [paths.workDir],
    sceneCleanup: built.cleanup,
  });

  // Only once every profile inside it is gone. The harness directory CONTAINS
  // the snapshot and the take profile, so removing it regardless would bulldoze
  // the very guard that just refused to delete a profile still in use.
  if (result.failed.length === 0 && ownsHarnessDir(paths) && existsSync(paths.harnessDir)) {
    try {
      removePathSync(paths.harnessDir);
    } catch {
      result.failed.push(paths.harnessDir);
    }
  }

  for (const removed of result.removed) console.log(`[demo] removed ${removed}`);
  if (result.failed.length > 0) {
    for (const failed of result.failed) console.error(`[demo] could not remove ${failed}`);
    console.error(
      "[demo] teardown refuses a profile it cannot prove is idle. Quit any running take, then run this again."
    );
    return 1;
  }
  console.log(`[demo] "${scene.slug}" is gone`);
  return 0;
}

const REGISTRY: Record<string, Command> = {
  stage: {
    summary: "Build the scene, bake an app profile, and write the shot card",
    usage: "npm run demo stage <scene.json>",
    run: stage,
  },
  take: {
    summary: "Rebuild the scene, reset the profile, and launch the app for recording",
    usage: "npm run demo take <scene.json> [-- --keep-repo] [-- --force]",
    run: take,
  },
  card: {
    summary: "Re-render the shot card from the scene",
    usage: "npm run demo card <scene.json>",
    run: card,
  },
  clean: {
    summary: "Delete the scene, its snapshot and every take profile",
    usage: "npm run demo clean <scene.json>",
    run: clean,
  },
};

function printUsage(): void {
  const width = Math.max(...Object.keys(REGISTRY).map((name) => name.length));
  console.log("Demo staging harness — usage: npm run demo <command> <scene.json>\n");
  for (const [name, command] of Object.entries(REGISTRY)) {
    console.log(`  ${name.padEnd(width)}  ${command.summary}`);
  }
  console.log("\nScenes are throwaway JSON. Keep them out of the repo and delete them after.");
  console.log("Requires a build: npm run build:e2e");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (
    command === undefined ||
    command === "list" ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printUsage();
    process.exit(0);
  }

  const entry = REGISTRY[command];
  if (!entry) {
    console.error(`[demo] unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
  }

  try {
    process.exit(await entry.run(rest));
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[demo] ${message}`);
    if (command === "take" && message.includes("running.lock")) {
      console.error(
        "[demo] if no app is actually running, that marker is stale — re-run with --force."
      );
    }
    console.error(`\nUsage: ${entry.usage}`);
    process.exit(1);
  }
}

void main();
