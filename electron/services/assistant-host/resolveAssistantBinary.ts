import { access, constants } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

/**
 * Locates the Daintree Assistant engine binary.
 *
 * The engine is a Go binary vendored as the `vendor/daintree-assistant` submodule and
 * built into `resources/assistant/` by `scripts/build-assistant.mjs`. It is BUNDLED
 * rather than discovered on `PATH` because its wire protocol moves in lockstep with
 * Daintree's host code — a separately-installed copy is free to be any version, which
 * is exactly how the v1/v2 protocol skew happened. The submodule SHA pins them.
 *
 * Resolution order, most specific first:
 *
 *  1. `DAINTREE_ASSISTANT_BIN` — an explicit override. This is the local development
 *     path: point it at `vendor/daintree-assistant/bin/daintree-assistant` and a
 *     `make build` in the submodule is picked up on the next launch, with no repack.
 *  2. The bundled binary under `process.resourcesPath` (packaged builds).
 *  3. The repo's build output (`resources/assistant/…`) — how `npm run dev` finds it
 *     without packaging.
 *
 * There is deliberately NO `PATH` fallback. A `daintree-assistant` on `PATH` is
 * whatever the user installed, at whatever version; silently binding to it would
 * reintroduce the skew this design exists to prevent, and the failure mode would be
 * an inscrutable protocol rejection rather than a missing-binary message.
 */

/** Env override for local engine development. */
export const ASSISTANT_BIN_ENV = "DAINTREE_ASSISTANT_BIN";

/**
 * Filename of the bundled binary. The platform/arch suffix is dropped at pack time
 * (see the `extraResources` entries in `electron-builder.config.cjs`), so exactly one
 * fixed name has to be resolved here.
 */
function bundledName(): string {
  return process.platform === "win32" ? "daintree-assistant.exe" : "daintree-assistant";
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    // X_OK is meaningless on Windows (every readable file reports executable), so
    // check readability there and let spawn report a genuinely broken image.
    await access(candidate, process.platform === "win32" ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveAssistantBinaryOptions {
  /** Overrides `app.getAppPath()`; for tests. */
  appPath?: string;
  /** Overrides `process.resourcesPath`; for tests. */
  resourcesPath?: string;
  /** Overrides `process.env`; for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the engine binary, or throws with a message that names the actual fix.
 *
 * The failure text matters: "assistant not found" sends someone hunting for an
 * install command that does not exist, because the engine is not separately
 * installable. It is built from a submodule, and the two things that go wrong are a
 * submodule that was never checked out and a build that was never run.
 */
export async function resolveAssistantBinary(
  opts: ResolveAssistantBinaryOptions = {}
): Promise<string> {
  const env = opts.env ?? process.env;
  const tried: string[] = [];

  const override = env[ASSISTANT_BIN_ENV]?.trim();
  if (override) {
    if (await isExecutable(override)) return override;
    // An override that does not resolve is FATAL, never a silent fall-through to the
    // bundled copy: someone set it to test a specific build, and quietly running a
    // different one would make the test a lie.
    throw new Error(
      `${ASSISTANT_BIN_ENV} is set to "${override}", but no executable is there.\n` +
        `Build it with: (cd vendor/daintree-assistant && make build)`
    );
  }

  const name = bundledName();

  const resourcesPath = opts.resourcesPath ?? process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "assistant", name);
    tried.push(packaged);
    if (await isExecutable(packaged)) return packaged;
  }

  // Unpackaged: `app.getAppPath()` is the repo root in dev.
  const appPath = opts.appPath ?? (app?.getAppPath ? app.getAppPath() : process.cwd());
  const devPath = path.join(
    appPath,
    "resources",
    "assistant",
    // In the repo the binaries keep their platform/arch suffix — only the packaged
    // copy is renamed — so dev has to reconstruct it.
    process.platform === "win32"
      ? `daintree-assistant-${process.platform}-${process.arch}.exe`
      : `daintree-assistant-${process.platform}-${process.arch}`
  );
  tried.push(devPath);
  if (await isExecutable(devPath)) return devPath;

  throw new Error(
    `Could not find the Daintree Assistant engine.\n` +
      `Looked in:\n${tried.map((t) => `  ${t}`).join("\n")}\n\n` +
      `The engine is a Go binary vendored as a submodule, not a separate install:\n` +
      `  git submodule update --init --recursive\n` +
      `  npm run build:assistant\n\n` +
      `To point at a locally built engine instead, set ${ASSISTANT_BIN_ENV}.`
  );
}
