import { AsyncLocalStorage } from "node:async_hooks";
import path from "path";

import { PLUGIN_PTY_DEFAULT_COLS, PLUGIN_PTY_DEFAULT_ROWS } from "./PluginProcessManager.js";
import { assertPluginCallerDrives, capturePluginCallerDrives } from "./pluginDriveLease.js";
import { runWithEndedPluginInvocation, runWithPluginInvocation } from "./pluginFrontendRouting.js";
import { processHandleKillers } from "./pluginInternalApprovers.js";
import { runWithServiceInvocation } from "./pluginServiceInvocation.js";

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
    const leaseTarget = { paths: [path.resolve(cwd ?? process.cwd())] };
    const requireCallerDrives = async () => {
      await assertPluginCallerDrives(pluginId, "process.spawn", leaseTarget);
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
    // Every later operation on the handle changes the same project, so each is
    // held to the lease as `spawn` was, judged as whoever makes it, even on a
    // handle a view opened while it drove (#15792). The gate also drops them
    // once the plugin unloads, so a handle retained by a leaked timer can't
    // drive the child afterwards (killManagedProcesses already tore the live
    // children down on unload).
    // Bound to this load of the plugin, so an operation still waiting when it
    // unloads can't land after a reload under the same id brings it back.
    const loaded = deps.plugins.get(pluginId);
    const gate = createProcessGate(() => deps.plugins.get(pluginId) === loaded);
    const check = (op: string) => capturePluginCallerDrives(pluginId, `process.${op}`, leaseTarget);
    const base: PluginProcessHandle = {
      get id() {
        return handle.id;
      },
      kill: () => gate.submit({ check: check("kill"), apply: () => handle.kill() }),
      // The respawn is admitted in turn, but later operations don't wait for it
      // to finish, as they never have.
      restart: () => {
        const cleared = check("restart");
        return new Promise<void>((resolve, reject) => {
          gate.submit({
            check: cleared,
            apply: () => {
              handle.restart().then(resolve, reject);
            },
            refused: reject,
            dropped: resolve,
          });
        });
      },
      onExit: (cb) => handle.onExit((info) => asBackground(() => cb(info))),
      onCrash: (cb) => handle.onCrash((info) => asBackground(() => cb(info))),
      onData: (cb) => handle.onData((chunk) => asBackground(() => cb(chunk))),
    };
    // Only the handle handed back is registered: it is what the worker bridge
    // holds when it cleans up.
    const expose = <T extends PluginProcessHandle>(exposed: T): T => {
      processHandleKillers.set(exposed, () => {
        gate.retire();
        handle.kill();
      });
      return exposed;
    };
    if (mode === "pipe") return expose(base);
    // Both writable modes get `write`; only a PTY additionally gets `resize`.
    const writable: PluginDuplexProcessHandle = {
      ...base,
      get id() {
        return handle.id;
      },
      write: (data) => {
        if (typeof data !== "string") return;
        gate.submit({ check: check("write"), apply: () => handle.write(data) });
      },
    };
    if (mode === "duplex") return expose(writable);
    return expose({
      ...writable,
      get id() {
        return handle.id;
      },
      resize: (nextCols, nextRows) =>
        gate.submit({ check: check("resize"), apply: () => handle.resize(nextCols, nextRows) }),
    } satisfies PluginPtyProcessHandle);
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

/** One operation on a process handle, waiting its turn. */
interface GatedProcessOp {
  /** The lease check for whoever made the operation; `undefined` clears it at once. */
  readonly check: () => Promise<void> | undefined;
  readonly apply: () => void;
  /** The lease refused it, or applying it threw after it had waited. */
  readonly refused?: (reason: unknown) => void;
  /** The plugin unloaded, or the host killed the process, before its turn. */
  readonly dropped?: () => void;
}

/**
 * A child's output and exit reach the plugin as its own background work, as in
 * a dev worker, even when a view's call started or restarted the child: its
 * streams would otherwise carry that call's context into every later chunk.
 */
function asBackground(fn: () => void): void {
  runWithPluginInvocation(null, () =>
    runWithEndedPluginInvocation(null, () => runWithServiceInvocation(null, fn))
  );
}

/**
 * Apply a process handle's operations in the order the plugin made them, each
 * once its lease check clears. The check runs when the operation reaches the
 * front, so it answers to the leases as they stand just before it lands, not
 * as they stood while earlier ones were judged. An operation that needn't wait
 * (nothing ahead of it, nothing to refuse) runs synchronously, as it always
 * has, and throws to the plugin as it always has.
 */
function createProcessGate(isLive: () => boolean): {
  submit: (op: GatedProcessOp) => void;
  retire: () => void;
} {
  // Each waiting operation resumes in the context it was made in, not in that
  // of the one whose check let the queue move on.
  const waiting: Array<{ op: GatedProcessOp; resume: (fn: () => void) => void }> = [];
  let busy = false;
  let draining = false;
  let retired = false;
  const live = () => !retired && isLive();

  const finish = (): void => {
    busy = false;
    drain();
  };

  // A loop rather than recursion, so a long run of operations that clear at
  // once behind one that waited can't overflow the stack.
  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (!busy && waiting.length > 0) {
        const next = waiting.shift()!;
        next.resume(() => start(next.op, false));
      }
    } finally {
      draining = false;
    }
  };

  const applyCleared = (op: GatedProcessOp): void => {
    if (!live()) {
      op.dropped?.();
      return;
    }
    try {
      op.apply();
    } catch (err) {
      op.refused?.(err);
    }
  };

  const start = (op: GatedProcessOp, direct: boolean): void => {
    if (!live()) {
      op.dropped?.();
      return;
    }
    let verdict: Promise<void> | undefined;
    try {
      verdict = op.check();
    } catch (err) {
      // A check that can't answer refuses, as the lease gate does.
      op.refused?.(err);
      return;
    }
    // Held busy while the child is touched, so an operation the plugin makes
    // from inside it (a data callback, say) queues behind it.
    busy = true;
    if (verdict === undefined) {
      try {
        op.apply();
      } catch (err) {
        if (direct) throw err;
        op.refused?.(err);
      } finally {
        finish();
      }
      return;
    }
    void verdict
      .then(
        () => applyCleared(op),
        (reason: unknown) => {
          if (live()) op.refused?.(reason);
          else op.dropped?.();
        }
      )
      .then(finish, finish);
  };

  return {
    submit: (op) => {
      if (busy || waiting.length > 0) {
        waiting.push({ op, resume: AsyncLocalStorage.snapshot() });
      } else {
        start(op, true);
      }
    },
    retire: () => {
      retired = true;
      for (const { op } of waiting.splice(0)) op.dropped?.();
    },
  };
}
