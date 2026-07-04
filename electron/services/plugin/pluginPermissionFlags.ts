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

/** Root class of a resolved allowed-path, mirroring the sanctioned host.fs surface. */
export type PluginPermissionRootClass = "project" | "user-data";

/** A resolved allowed-path root and the capability class that gates it. */
export interface PluginPermissionRoot {
  path: string;
  rootClass: PluginPermissionRootClass;
}

/**
 * Split resolved allowed-path roots into read/write path sets, gated per root
 * class exactly like the sanctioned `host.fs` surface: a `project` root needs
 * `fs:project-read` / `fs:project-write`, a `user-data` root (including the
 * implicit per-plugin data dir) needs `fs:user-data-read` / `fs:user-data-write`.
 * Read and write are independent — a write-only plugin gets no read grant — so
 * the flag mapping never over-grants relative to the host-mediated boundary.
 *
 * `bundleDir` (the plugin's own code dir) is always added as a read root,
 * independent of declared capabilities: a permission-honoring runtime must be
 * able to read the plugin's bundle to import it at all, so withholding it would
 * make every plugin unloadable rather than merely scope-limited.
 */
export function classifyPluginPermissionPaths(
  roots: readonly PluginPermissionRoot[],
  capabilities: readonly PluginCapability[],
  bundleDir: string
): { readPaths: string[]; writePaths: string[] } {
  const caps = new Set<PluginCapability>(capabilities);
  const readPaths: string[] = [bundleDir];
  const writePaths: string[] = [];
  for (const root of roots) {
    const readCap: PluginCapability =
      root.rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
    const writeCap: PluginCapability =
      root.rootClass === "project" ? "fs:project-write" : "fs:user-data-write";
    if (caps.has(readCap)) readPaths.push(root.path);
    if (caps.has(writeCap)) writePaths.push(root.path);
  }
  return { readPaths, writePaths };
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
 * Build the ordered `execArgv` permission flags for a plugin worker. Whether to
 * call this at all is the caller's decision (env-gated spike opt-in); when
 * called it always emits `--permission` so the model is actually engaged.
 *
 * Read and write path sets are emitted independently — the caller has already
 * gated them per capability, so no read is implied from a write here. Each path
 * becomes its OWN `--allow-fs-read` / `--allow-fs-write` flag rather than a
 * comma-joined list: Node treats a comma-joined value as a single literal path
 * (so `/a,/b` would grant neither `/a` nor `/b`), and repeated flags also sidestep
 * any comma-in-path ambiguity. Paths are deduped and sorted so the same inputs
 * never produce differently-ordered flags, keeping tests deterministic.
 */
export function buildPluginPermissionExecArgv(input: PluginPermissionExecArgvInput): string[] {
  const readPaths = normalizePaths(input.readPaths);
  const writePaths = normalizePaths(input.writePaths);

  const flags: string[] = ["--permission"];
  for (const p of readPaths) flags.push(`--allow-fs-read=${p}`);
  for (const p of writePaths) flags.push(`--allow-fs-write=${p}`);
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
