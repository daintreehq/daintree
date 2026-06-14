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
export function spawnViteWatch(dir: string): ResultPromise {
  const bin = resolveViteBin(dir);
  return execa(bin, ["build", "--watch"], { cwd: dir, stdio: "inherit" });
}
