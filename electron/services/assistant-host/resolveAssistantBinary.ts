import { access, stat, constants } from "node:fs/promises";
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
 *
 * The override outranks the bundled copy in a PACKAGED app too, and that is kept
 * deliberately — engine development against a locally installed build (`npm run
 * install:local`) is a real workflow and refusing it would leave no replacement. What
 * is not acceptable is doing it SILENTLY: a `DAINTREE_ASSISTANT_BIN` exported into a
 * shell months ago would otherwise substitute an unknown engine into a packaged
 * acceptance run, and the run would certify an artifact it never executed.
 *
 * So resolution reports WHICH step won and stays otherwise pure. Saying anything about
 * it belongs to whoever is about to spawn the thing — `CliAvailabilityService` resolves
 * only to ask whether an engine exists, and a probe that announces it is "running" a
 * substitute engine would be both noise and a lie.
 */

/** Env override for local engine development. */
export const ASSISTANT_BIN_ENV = "DAINTREE_ASSISTANT_BIN";

/** Which of the three resolution steps produced the binary. */
export type AssistantBinarySource = "override" | "packaged" | "repo";

export interface ResolvedAssistantBinary {
  /** Absolute path to the engine binary. Overrides are anchored before use. */
  path: string;
  /** Which resolution step won. `"packaged"` is the only acceptance-grade answer. */
  source: AssistantBinarySource;
}

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
    // A directory passes both checks — searchable satisfies X_OK, readable satisfies
    // R_OK — so `access` alone would hand back a folder as the engine and leave the
    // failure to surface as an unreadable spawn error several layers away.
    return (await stat(candidate)).isFile();
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
 * Resolves the engine binary and reports which step produced it, or throws with a
 * message that names the actual fix.
 *
 * The failure text matters: "assistant not found" sends someone hunting for an
 * install command that does not exist, because the engine is not separately
 * installable. It is built from a submodule, and the two things that go wrong are a
 * submodule that was never checked out and a build that was never run.
 */
export async function resolveAssistantBinary(
  opts: ResolveAssistantBinaryOptions = {}
): Promise<ResolvedAssistantBinary> {
  const env = opts.env ?? process.env;
  const tried: string[] = [];

  const raw = env[ASSISTANT_BIN_ENV]?.trim();
  if (raw) {
    // Anchored before it is checked. The child is spawned with the PROJECT as its cwd
    // (`AssistantHostProcess`), while this check runs against main's — so a relative
    // override would be validated as one file and executed as another, and a bare
    // filename would reach the `PATH` lookup this resolver exists to refuse.
    const override = path.resolve(raw);
    if (await isExecutable(override)) return { path: override, source: "override" };
    // An override that does not resolve is FATAL, never a silent fall-through to the
    // bundled copy: someone set it to test a specific build, and quietly running a
    // different one would make the test a lie.
    throw new Error(
      `${ASSISTANT_BIN_ENV} is set to "${raw}", but no executable is there.\n` +
        `Build it with: (cd vendor/daintree-assistant && make build)`
    );
  }

  const name = bundledName();

  const resourcesPath = opts.resourcesPath ?? process.resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "assistant", name);
    tried.push(packaged);
    if (await isExecutable(packaged)) return { path: packaged, source: "packaged" };
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
  if (await isExecutable(devPath)) return { path: devPath, source: "repo" };

  throw new Error(
    `Could not find the Daintree Assistant engine.\n` +
      `Looked in:\n${tried.map((t) => `  ${t}`).join("\n")}\n\n` +
      `The engine is a Go binary vendored as a submodule, not a separate install:\n` +
      `  git submodule update --init --recursive\n` +
      `  npm run build:assistant\n\n` +
      `To point at a locally built engine instead, set ${ASSISTANT_BIN_ENV}.`
  );
}
