import { statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Refuses to run when `dist/` is older than the source it was built from.
 *
 * Playwright launches the app from `dist/` and does NOT build. So a suite run against a
 * stale build exercises the PREVIOUS renderer and reports it as a pass — which is not a
 * hypothetical: it happened on this branch for several hours, and the tell was that
 * locators for a `textarea` and a Send button kept resolving after both had been
 * replaced by the terminal's own input bar. Nothing failed. The suite was simply
 * describing an app that no longer existed.
 *
 * CI is safe because its workflow builds first (`.github/workflows/e2e.yml`). Local runs
 * are typed by hand, so the guard belongs here, where the mistake is made.
 *
 * Deliberately mtime-based rather than a content hash: it has to be cheap enough to run
 * before every local suite, and "the build is older than the code" is the whole of the
 * question.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** Source trees whose changes require a rebuild before `dist/` means anything. */
const WATCHED = ["src", "shared", "electron"];
const SKIP = new Set(["node_modules", "__tests__", "__preview__", ".git"]);

function newestMtime(dir: string, deadline: number): number {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, deadline));
    } else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Raced with an editor writing the file. Its mtime is by definition now.
        newest = Math.max(newest, Date.now());
      }
    }
    // Bail as soon as we know the answer — no reason to walk the rest of the tree.
    if (newest > deadline) return newest;
  }
  return newest;
}

/**
 * Throws when the build is behind the source.
 *
 * Call from a `beforeAll`. The message names the command, because the only useful
 * response to this failure is to run it.
 */
export function assertFreshBuild(): void {
  let builtAt: number;
  try {
    builtAt = statSync(path.join(REPO, "dist", "index.html")).mtimeMs;
  } catch {
    throw new Error("No dist/index.html — run `npm run build` before this suite.");
  }
  for (const tree of WATCHED) {
    const newest = newestMtime(path.join(REPO, tree), builtAt);
    if (newest > builtAt) {
      const behind = Math.round((newest - builtAt) / 1000);
      throw new Error(
        `dist/ is ${behind}s older than ${tree}/. Playwright launches from dist/ and does ` +
          `not build, so this run would test the PREVIOUS renderer and pass.\n` +
          `Run: npm run build`
      );
    }
  }
}
