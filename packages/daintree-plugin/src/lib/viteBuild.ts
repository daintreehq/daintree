import { existsSync } from "node:fs";
import path from "node:path";
import { execa, type ResultPromise } from "execa";

/**
 * Resolve the Vite binary a plugin builds with. Both `package` (one-shot
 * `vite build`) and `dev` (`vite build --watch`) shell out to the same bin so a
 * plugin builds identically whichever command an author runs.
 *
 * Looks in `<dir>/node_modules/.bin` first, then in each ancestor's, nearest
 * wins — the same order `npm run` puts on `PATH`. npm, Yarn (node-modules
 * linker) and Bun workspaces hoist dependencies to the workspace root, so a
 * member plugin has no `.bin` of its own; a plugin that does install Vite
 * locally still uses its own even when an ancestor has another version. Only
 * `node_modules/.bin` directories are consulted: never the global `PATH`,
 * `npx`, or a network install.
 *
 * Throws a fix-it message when Vite isn't found. Synchronous so
 * {@link spawnViteWatch} can return the long-running `ResultPromise` directly
 * without an `async` wrapper — an `async` wrapper would unwrap the thenable and
 * resolve only on the watcher's *exit*, hanging the dev loop.
 */
export function resolveViteBin(dir: string): string {
  const binName = process.platform === "win32" ? "vite.cmd" : "vite";
  const start = path.resolve(dir);
  for (let current = start; ;) {
    const bin = path.join(current, "node_modules", ".bin", binName);
    if (existsSync(bin)) return bin;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Couldn't find Vite in ${path.join(start, "node_modules", ".bin")} or any parent directory's node_modules/.bin. ` +
      `Add vite as a dependency of the plugin (or of its workspace root) and install, or pass --skip-build.`
  );
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

// An Element Picker provider's guest entry is its own standalone browser bundle
// (`daintreePlugin({ target: "guest" })`), so it gets a pass of its own too.
const GUEST_CONFIG_NAMES = [
  "vite.config.guest.js",
  "vite.config.guest.mjs",
  "vite.config.guest.ts",
  "vite.config.guest.cjs",
  "vite.config.guest.mts",
  "vite.config.guest.cts",
] as const;

/** The plugin's guest-target Vite config filename, or null if it has none. */
export function findGuestConfig(dir: string): string | null {
  return GUEST_CONFIG_NAMES.find((name) => existsSync(path.join(dir, name))) ?? null;
}

export interface VitePlan {
  /** Whether this project has more than one Vite config (a server or guest target besides the default). */
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
  const extra = [findServerConfig(dir), findGuestConfig(dir)].filter(
    (config): config is string => config !== null
  );
  if (extra.length === 0) {
    return { dualConfig: false, oneShot: [["build"]], watch: [["build", "--watch"]] };
  }
  return {
    dualConfig: true,
    oneShot: [["build"], ...extra.map((config) => ["build", "--config", config])],
    watch: [
      ["build", "--watch", "--no-emptyOutDir"],
      ...extra.map((config) => ["build", "--watch", "--config", config, "--no-emptyOutDir"]),
    ],
  };
}

/** Run every pass of a one-shot build, in order. */
export async function runVitePlanBuild(dir: string, plan: VitePlan): Promise<void> {
  for (const args of plan.oneShot) {
    await runViteBuild(dir, args);
  }
}
