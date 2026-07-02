// Spike (#10890): map a plugin's declared `scopes.fs.allowedPaths` + capabilities
// onto Node's experimental permission-model `execArgv` flags (`--permission`,
// `--allow-fs-read`, `--allow-fs-write`, `--allow-child-process`, `--allow-addons`)
// for the `utilityProcess.fork` plugin worker.
//
// IMPORTANT — this is a PROTOTYPE, not enforcement. Empirically (verified against
// the repo's own Electron 42.4.0 binary), `utilityProcess.fork()` does NOT honor
// these flags: the worker's `process.permission` is `undefined` and out-of-scope
// `child_process`/`fs` calls are not blocked, because Electron's utility-process
// bootstrap never runs Node's `--permission` CLI parsing. The real, audited
// boundary remains `pluginFsContainment.ts` realpath containment on the sanctioned
// `host.fs` / `host.git` surface. This module + the worker's boot self-check exist
// to (a) have the mapping ready if a future Electron honors the flags, and (b)
// measure whether it does. See `PluginDevWorkerHost` for the runtime verdict log.
//
// This module is intentionally pure (no Electron / fs / process deps) so it is
// deterministic and unit-testable.

import type { PluginCapability } from "../../../shared/types/plugin.js";

/** Node permission-model inputs derived from a plugin's declared capabilities. */
export interface PluginPermissionCapabilities {
  /** Whether the worker may spawn child processes (`--allow-child-process`). */
  allowChildProcess: boolean;
  /** Whether the worker may load native addons (`--allow-addons`). */
  allowNativeAddons: boolean;
}

/** Fully-resolved path inputs + capability gates for the flag builder. */
export interface PluginPermissionExecArgvInput {
  /** Absolute paths the worker may read (`--allow-fs-read`). */
  readPaths: readonly string[];
  /** Absolute paths the worker may write (`--allow-fs-write`). */
  writePaths: readonly string[];
  allowChildProcess: boolean;
  allowNativeAddons: boolean;
}

/**
 * Classify a plugin's declared capabilities into permission-model gates.
 *
 * `shell:exec` is the only capability that implies the worker legitimately
 * spawns child processes, so it maps to `--allow-child-process`. No capability
 * distinguishes native-addon needs, so — to honor the issue's "must not break
 * plugins that load native addons" constraint — the spike allows addons
 * unconditionally when the permission model is enabled. This is a deliberate,
 * documented limitation of the prototype (addon use cannot be attenuated from
 * the manifest today), NOT an oversight.
 */
export function derivePluginPermissionCapabilities(
  capabilities: readonly PluginCapability[]
): PluginPermissionCapabilities {
  return {
    allowChildProcess: capabilities.includes("shell:exec"),
    allowNativeAddons: true,
  };
}

/** Dedupe + sort for deterministic, order-independent flag output. */
function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => p.length > 0))].sort();
}

/**
 * Build the ordered `execArgv` permission flags for a plugin worker. Returns
 * `[]` (no flags — current behavior preserved) is NOT this function's job; the
 * caller decides whether to invoke it at all (env-gated spike opt-in). When
 * called it always emits `--permission` so the model is actually engaged.
 *
 * Node's permission model treats read and write independently — a writable path
 * is not implicitly readable — so every write path is also emitted as a read
 * path. Paths are comma-joined into a single `--allow-fs-*` argument (Node
 * accepts comma-separated lists), deduped and sorted so tests are stable and the
 * same inputs never produce differently-ordered flag strings.
 */
export function buildPluginPermissionExecArgv(input: PluginPermissionExecArgvInput): string[] {
  const readPaths = normalizePaths([...input.readPaths, ...input.writePaths]);
  const writePaths = normalizePaths(input.writePaths);

  const flags: string[] = ["--permission"];
  if (readPaths.length > 0) flags.push(`--allow-fs-read=${readPaths.join(",")}`);
  if (writePaths.length > 0) flags.push(`--allow-fs-write=${writePaths.join(",")}`);
  if (input.allowChildProcess) flags.push("--allow-child-process");
  if (input.allowNativeAddons) flags.push("--allow-addons");
  return flags;
}

/**
 * Env-var name that opts a build into the permission-model spike. Absent/falsy
 * (the default) preserves the exact current worker `execArgv`; set to a truthy
 * value to append the mapped permission flags at fork time.
 */
export const PLUGIN_PERMISSION_MODEL_SPIKE_ENV = "DAINTREE_PLUGIN_PERMISSION_MODEL_SPIKE";

/** Whether the permission-model spike is enabled for this process. */
export function isPluginPermissionModelSpikeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PLUGIN_PERMISSION_MODEL_SPIKE_ENV];
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}
