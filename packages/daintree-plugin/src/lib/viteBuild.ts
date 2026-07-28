import { existsSync } from "node:fs";
import path from "node:path";
import { execa, type ResultPromise } from "execa";

/**
 * Resolve the plugin project's local Vite binary. Both `package` (one-shot
 * `vite build`) and `dev` (`vite build --watch`) shell out to the same bin so a
 * plugin builds identically whichever command an author runs. Throws a
 * fix-it-yourself message when Vite isn't installed. Synchronous so
 * {@link spawnViteWatch} can return the long-running `ResultPromise` directly
 * without an `async` wrapper — an `async` wrapper would unwrap the thenable and
 * resolve only on the watcher's *exit*, hanging the dev loop.
 */
export function resolveViteBin(dir: string): string {
  const binName = process.platform === "win32" ? "vite.cmd" : "vite";
  const bin = path.join(dir, "node_modules", ".bin", binName);
  if (!existsSync(bin)) {
    throw new Error(
      `Couldn't find Vite at ${bin}. Run npm install in the plugin directory, or pass --skip-build.`
    );
  }
  return bin;
}

/** Run a one-shot `vite build` (or another arg set) to completion. */
export async function runViteBuild(dir: string, args: string[] = ["build"]): Promise<void> {
  const bin = resolveViteBin(dir);
  await execa(bin, args, { cwd: dir, stdio: "inherit" });
}

/**
 * Spawn `vite build --watch` and return the long-running subprocess handle so
 * the caller can kill it on shutdown. Output inherits the terminal so authors
 * see Vite's rebuild log directly; the dev worker watches `dist/` and reloads on
 * each rebuild, so the CLI only owns the build, not the reload.
 *
 * NOT `async`: it returns execa's `ResultPromise`, which is both awaitable and a
 * live child handle. Wrapping it in `async` would await the process to *exit*.
 */
export function spawnViteWatch(dir: string, args: string[] = ["build", "--watch"]): ResultPromise {
  const bin = resolveViteBin(dir);
  return execa(bin, args, { cwd: dir, stdio: "inherit" });
}

// A plugin with a Node entry (stdio MCP server) is built by a second Vite pass
// against its own config, because one `vite build` runs one config object at a
// time. The scaffold names that file `vite.config.server.ts`; the other
// extensions are accepted so a hand-rolled project isn't locked out.
// Ordered to match Vite 8's own DEFAULT_CONFIG_FILES precedence, so a project
// with more than one resolves the same way Vite would.
const SERVER_CONFIG_NAMES = [
  "vite.config.server.js",
  "vite.config.server.mjs",
  "vite.config.server.ts",
  "vite.config.server.cjs",
  "vite.config.server.mts",
  "vite.config.server.cts",
] as const;

/** The plugin's server-target Vite config filename, or null if it has none. */
export function findServerConfig(dir: string): string | null {
  return SERVER_CONFIG_NAMES.find((name) => existsSync(path.join(dir, name))) ?? null;
}

export interface VitePlan {
  /** Whether this project has a second, server-target config. */
  dualConfig: boolean;
  /** Arg sets for a one-shot build, in order. Run these sequentially. */
  oneShot: string[][];
  /** Arg sets to spawn concurrently as watchers. */
  watch: string[][];
}

/**
 * Work out how many Vite passes this plugin needs and with which flags.
 *
 * One-shot builds run sequentially, so the default `emptyOutDir: true` on the
 * browser config is right: the first pass cleans `dist/`, and the server config
 * (which the scaffold gives `emptyOutDir: false`) then appends to it.
 *
 * Watch mode can't rely on that ordering. Vite's `prepareOutDirPlugin` drops the
 * environment from its `rendered` set on every `watchChange`, so `renderStart`
 * re-empties `outDir` on *every* incremental rebuild — not just the first. With
 * two watchers on a shared `dist/`, each browser save would delete the server
 * bundle (and the server watcher wouldn't rebuild it until its own sources
 * changed). `--no-emptyOutDir` is Vite's cac-negated form of the `--emptyOutDir`
 * flag; it isn't in `vite build --help`, but it does reach
 * `build.emptyOutDir = false` and inline CLI options win over the config file,
 * so it fixes already-scaffolded plugins without touching an author's config.
 *
 * The flag is applied only in dual-config mode. A single-config project keeps
 * plain `vite build --watch` so its rebuilds still sweep away stale chunks —
 * the cost of `--no-emptyOutDir` is exactly that stale output lingers for the
 * session, which is only worth paying when the alternative is deleting a
 * sibling target's bundle.
 */
export function resolveVitePlan(dir: string): VitePlan {
  const serverConfig = findServerConfig(dir);
  if (!serverConfig) {
    return { dualConfig: false, oneShot: [["build"]], watch: [["build", "--watch"]] };
  }
  return {
    dualConfig: true,
    oneShot: [["build"], ["build", "--config", serverConfig]],
    watch: [
      ["build", "--watch", "--no-emptyOutDir"],
      ["build", "--watch", "--config", serverConfig, "--no-emptyOutDir"],
    ],
  };
}

/** Run every pass of a one-shot build, in order. */
export async function runVitePlanBuild(dir: string, plan: VitePlan): Promise<void> {
  for (const args of plan.oneShot) {
    await runViteBuild(dir, args);
  }
}
