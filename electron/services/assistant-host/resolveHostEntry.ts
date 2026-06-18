import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/**
 * Locates the forkable native-host entry (`dist/host.js`) shipped by the
 * `@daintreehq/daintree-assistant` package, given the resolved path to its CLI
 * executable (as discovered by `CliAvailabilityService`). The host entry is a
 * sibling of the CLI bin (`dist/index.js`) in the package's `dist/` directory.
 *
 * The package is installed independently of Daintree (global npm, a PATH shim,
 * a `node_modules/.bin` symlink), so we can't `require.resolve()` it from the
 * app's module graph — we work outward from the bin path instead:
 *
 *   1. Follow a symlinked bin to its real target (`dist/index.js`) and take the
 *      `host.js` sibling. Covers the common unix `.bin`/npm-global case.
 *   2. Otherwise (a Windows `.cmd`/`.ps1` shim, or a non-symlink bin), walk up
 *      from the bin directory looking for the package under a `node_modules`
 *      tree. Covers npm-global on Windows and nested installs.
 */
const PACKAGE_REL = path.join("@daintreehq", "daintree-assistant");
const HOST_REL = path.join("dist", "host.js");

export async function resolveAssistantHostEntry(binPath: string): Promise<string> {
  const candidates: string[] = [];

  // 1. Symlinked bin → real dist/index.js → host.js sibling.
  try {
    const real = await realpath(binPath);
    if (real.toLowerCase().endsWith(".js")) {
      candidates.push(path.join(path.dirname(real), "host.js"));
    }
  } catch {
    // binPath may be a shim or already gone; fall through to the layout walk.
  }

  // 2. Walk up from the bin directory for a node_modules-installed package.
  let dir = path.dirname(binPath);
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(path.join(dir, "node_modules", PACKAGE_REL, HOST_REL));
    // When `dir` is itself a node_modules root (e.g. the parent of `.bin`).
    candidates.push(path.join(dir, PACKAGE_REL, HOST_REL));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    `Could not locate the daintree-assistant native-host entry (${HOST_REL}) from ${binPath}. ` +
      `The installed package may predate native-host support — upgrade @daintreehq/daintree-assistant.`
  );
}
