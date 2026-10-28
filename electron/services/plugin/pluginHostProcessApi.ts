import path from "path";

import { PLUGIN_PTY_DEFAULT_COLS, PLUGIN_PTY_DEFAULT_ROWS } from "./PluginProcessManager.js";
import { assertPluginCallerDrives } from "./pluginDriveLease.js";

import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import type {
  BuiltInPluginCapability,
  PluginProcessApi,
  PluginProcessHandle,
  PluginProcessSpawnOptions,
  PluginProcessMode,
  PluginDuplexProcessHandle,
  PluginDuplexProcessSpawnOptions,
  PluginPtyProcessHandle,
  PluginPtyProcessSpawnOptions,
} from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps, ensureCapabilityConsent } from "./pluginHostDeps.js";

/**
 * Build the `host.process` surface for one plugin. `spawn` is gated on the
 * declared `shell:exec` capability — the first runtime enforcement of a scope
 * capability, mirroring how the typed-channel `requires` gate reads
 * `manifest.capabilities`. A plugin without it is rejected with a
 * `PERMISSION_REQUIRED:` prefix, which the calling view can inspect.
 */
export function buildProcessApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  fetchWorktreeSnapshots: () => Promise<WorktreeSnapshot[]>
): PluginProcessApi {
  const spawn = async (
    command: string,
    options?:
      PluginProcessSpawnOptions | PluginDuplexProcessSpawnOptions | PluginPtyProcessSpawnOptions
  ): Promise<PluginProcessHandle | PluginDuplexProcessHandle | PluginPtyProcessHandle> => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    const declared = new Set<BuiltInPluginCapability>(
      deps.plugins.get(pluginId)?.manifest.capabilities ?? []
    );
    if (!declared.has("shell:exec")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" process.spawn requires the "shell:exec" capability, which is not declared in manifest.capabilities`
      );
    }
    // Validate inputs BEFORE prompting for consent so a call that would fail
    // anyway never spends — or banks — a user grant. A plugin must not be able
    // to harvest a silent shell:exec grant via a deliberately invalid call
    // (e.g. spawn("")) and then execute real commands unprompted (#10524).
    if (typeof command !== "string" || command.length === 0) {
      throw new Error(`Plugin "${pluginId}" process.spawn: command must be a non-empty string`);
    }
    const rawMode: unknown = options?.mode;
    if (rawMode !== undefined && rawMode !== "pipe" && rawMode !== "duplex" && rawMode !== "pty") {
      throw new Error(
        `Plugin "${pluginId}" process.spawn: mode must be "pipe", "duplex", or "pty": ${String(rawMode)}`
      );
    }
    const mode: PluginProcessMode =
      rawMode === "pty" ? "pty" : rawMode === "duplex" ? "duplex" : "pipe";
    // `undefined` and `null` both mean broadcast, matching postToPanel. An empty
    // string is an authoring mistake — it would silently match no subscriber —
    // so reject it loudly rather than coercing.
    const rawPanelId: unknown = options?.panelId;
    if (rawPanelId !== undefined && rawPanelId !== null) {
      if (typeof rawPanelId !== "string" || rawPanelId.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" process.spawn: panelId must be a non-empty string, null, or undefined: ${String(rawPanelId)}`
        );
      }
    }
    const panelId = typeof rawPanelId === "string" ? rawPanelId : null;
    let cols = PLUGIN_PTY_DEFAULT_COLS;
    let rows = PLUGIN_PTY_DEFAULT_ROWS;
    if (mode === "pty") {
      const ptyOptions = options as PluginPtyProcessSpawnOptions;
      cols = resolvePtyDimension(pluginId, "cols", ptyOptions.cols, PLUGIN_PTY_DEFAULT_COLS);
      rows = resolvePtyDimension(pluginId, "rows", ptyOptions.rows, PLUGIN_PTY_DEFAULT_ROWS);
    }
    const args = Array.isArray(options?.args)
      ? options.args.filter((a): a is string => typeof a === "string")
      : [];
    const env =
      options?.env && typeof options.env === "object"
        ? Object.fromEntries(Object.entries(options.env).filter(([, v]) => typeof v === "string"))
        : {};
    // Default cwd to the active worktree so a relative `command`/argv resolves
    // against the project the user is in, then fall back to the host cwd.
    let cwd = typeof options?.cwd === "string" && options.cwd.length > 0 ? options.cwd : undefined;
    if (cwd === undefined) {
      const active = await fetchWorktreeSnapshots();
      cwd = active.find((s) => s.isCurrent === true)?.path;
    }
    // Re-check membership after the async cwd resolution so a racing unload
    // doesn't spawn into a disposed plugin.
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    // A process started in a project works on it, as a terminal spawned there
    // does, so a call from a view must drive it: judged before the consent
    // prompt and again after it, which can outlast a takeover.
    // With no cwd the child inherits Main's, which is judged in its place.
    const requireCallerDrives = async () => {
      await assertPluginCallerDrives(pluginId, "process.spawn", {
        paths: [path.resolve(cwd ?? process.cwd())],
      });
      if (!deps.plugins.has(pluginId)) {
        throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
      }
    };
    await requireCallerDrives();
    // JIT consent fires LAST, right before the spawn — first use prompts the
    // user; the grant covers every later spawn by this plugin. Throws
    // PERMISSION_REQUIRED on denial. Re-check membership after the prompt await.
    await ensureCapabilityConsent(deps, pluginId, "shell:exec");
    if (!deps.plugins.has(pluginId)) {
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    await requireCallerDrives();

    const handle = await deps
      .getProcessManager()
      .spawn(
        pluginId,
        mode === "pty"
          ? { mode, command, args, cwd, env, panelId, cols, rows }
          : { mode, command, args, cwd, env, panelId }
      );
    // Interactive allocation is asynchronous (it round-trips to the pty-host), so
    // an unload can land while it is in flight. Kill rather than hand back a
    // live process the unload teardown already walked past.
    if (!deps.plugins.has(pluginId)) {
      handle.kill();
      throw new Error(`Plugin "${pluginId}" process.spawn: plugin is no longer loaded`);
    }
    const base: PluginProcessHandle = {
      get id() {
        return handle.id;
      },
      // Gate lifecycle control on membership so a stale handle retained by a
      // leaked timer can't kill or respawn a process after the plugin unloads
      // (killManagedProcesses already tore the live children down on unload).
      kill: () => {
        if (!deps.plugins.has(pluginId)) return;
        handle.kill();
      },
      restart: () => {
        if (!deps.plugins.has(pluginId)) return Promise.resolve();
        return handle.restart();
      },
      onExit: (cb) => handle.onExit(cb),
      onCrash: (cb) => handle.onCrash(cb),
      onData: (cb) => handle.onData(cb),
    };
    if (mode === "pipe") return base;
    // Both writable modes get `write`; only a PTY additionally gets `resize`.
    // Membership-gated like kill/restart so a handle retained by a leaked timer
    // can't drive a child after the plugin unloads.
    const writable: PluginDuplexProcessHandle = {
      ...base,
      get id() {
        return handle.id;
      },
      write: (data) => {
        if (!deps.plugins.has(pluginId) || typeof data !== "string") return;
        handle.write(data);
      },
    };
    if (mode === "duplex") return writable;
    return {
      ...writable,
      get id() {
        return handle.id;
      },
      resize: (nextCols, nextRows) => {
        if (!deps.plugins.has(pluginId)) return;
        handle.resize(nextCols, nextRows);
      },
    } satisfies PluginPtyProcessHandle;
  };
  return { spawn } as PluginProcessApi;
}

/**
 * Validate one PTY dimension. Omitted falls back to the default; a value that is
 * present but not a positive integer is an authoring mistake worth rejecting
 * before the JIT consent prompt, so a bad call never spends a user grant.
 */
function resolvePtyDimension(
  pluginId: string,
  name: "cols" | "rows",
  value: unknown,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Plugin "${pluginId}" process.spawn: ${name} must be a positive integer: ${String(value)}`
    );
  }
  return value;
}
