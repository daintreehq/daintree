import * as pty from "node-pty";
import path from "node:path";
import {
  filterEnvironment,
  injectDaintreeMetadata,
  ensureUtf8Locale,
} from "./EnvironmentFilter.js";
import { getDefaultShell, getDefaultShellArgs } from "./terminalShell.js";
import { computePoolEnvHash } from "./ptyPoolEnvHash.js";
import type { PtySpawnOptions } from "./types.js";
import {
  BufferedPtyDataHandoff,
  destroyPty,
  shouldEnablePtyPool,
  type PooledPtyDataHandoff,
  type PtyPool,
} from "../PtyPool.js";
import { markHostPerformance } from "../../utils/hostPerformance.js";
import { PERF_MARKS } from "../../../shared/perf/marks.js";

// Agent CLIs that ship as Node binaries and benefit from V8 bytecode
// caching across launches. Codex is a Rust binary and would silently
// no-op; the rest are excluded conservatively until we confirm their
// runtime. NODE_COMPILE_CACHE has been respected by Node ≥22.1; older
// runtimes silently ignore it.
const NODE_COMPILE_CACHE_AGENTS: ReadonlySet<string> = new Set(["claude", "gemini"]);

export interface SpawnContext {
  shell: string;
  args: string[];
  env: Record<string, string>;
}

export function computeSpawnContext(id: string, options: PtySpawnOptions): SpawnContext {
  const shell = options.shell || getDefaultShell();
  const args = options.args || getDefaultShellArgs(shell);
  const env = buildTerminalEnv(options, id, shell);
  injectAgentStartupProfiling(env, options);
  return { shell, args, env };
}

/**
 * Dev-only opt-in CPU profiling for agent CLI startup. Activates when ALL of:
 *   - `options.launchAgentId` is set (agent panel, not a plain shell)
 *   - `DAINTREE_PROFILE_AGENT_STARTUP === "1"` (caller opt-in)
 *   - `DAINTREE_IS_PACKAGED === "0"` (forwarded by `PtyHostLifecycle`; the
 *      strict-equality check disables profiling whenever the flag is missing
 *      or anything other than `"0"`)
 *   - `DAINTREE_USER_DATA` is available (target directory for `.cpuprofile`s)
 *
 * Appends `--cpu-prof --cpu-prof-dir=<userData>/agent-profiles` to any existing
 * `NODE_OPTIONS`. Note this is inherited by every Node.js child process the
 * agent spawns (npm, tsc, MCP servers); the resulting `.cpuprofile` files are
 * still loadable in Chrome DevTools but the directory will fill with
 * subprocess profiles too. See `docs/development.md` for the full caveat.
 */
function injectAgentStartupProfiling(env: Record<string, string>, options: PtySpawnOptions): void {
  if (!options.launchAgentId) return;
  if (process.env.DAINTREE_PROFILE_AGENT_STARTUP !== "1") return;
  if (process.env.DAINTREE_IS_PACKAGED !== "0") return;
  const userData = process.env.DAINTREE_USER_DATA;
  if (!userData) return;

  const profileDir = path.join(userData, "agent-profiles");
  const injection = `--cpu-prof --cpu-prof-dir=${profileDir}`;
  const existing = env.NODE_OPTIONS;
  env.NODE_OPTIONS = existing && existing.length > 0 ? `${existing} ${injection}` : injection;
}

/**
 * Build the environment for a terminal PTY.
 *
 * All terminals get the same baseline. There is no "agent terminal" env tier —
 * every PTY is a plain interactive shell that may later have a command injected
 * (see `docs/architecture/terminal-identity.md`). Agent CLIs detect the TTY and
 * colour support from standard env variables; no per-agent shaping is required.
 */
export function buildTerminalEnv(
  options: PtySpawnOptions,
  id: string,
  _shell: string
): Record<string, string> {
  const baseEnv = process.env as Record<string, string | undefined>;

  // Filter sensitive credentials from the inherited process environment only.
  // options.env contains intentional overrides (e.g. project settings env vars
  // resolved from secure storage) and is merged in after filtering so those
  // intentional values are not inadvertently stripped.
  const filteredBaseEnv = filterEnvironment(baseEnv);
  const intentionalEnv = options.env
    ? (Object.fromEntries(Object.entries(options.env).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >)
    : {};
  const mergedEnv = injectDaintreeMetadata(
    { ...filteredBaseEnv, ...intentionalEnv },
    {
      paneId: id,
      cwd: options.cwd,
      projectId: options.projectId,
    }
  );

  // Universal colour hints — xterm.js supports truecolor, and most CLIs
  // (chalk, supports-color, termenv, ink) honour these.
  //
  // FORCE_COLOR yields to an inherited NO_COLOR: chalk/supports-color/ink read
  // FORCE_COLOR first and short-circuit, so injecting it would override the
  // user's stated preference and make Node print "NO_COLOR is ignored because
  // FORCE_COLOR is set" in every terminal. Presence — not truthiness — is the
  // test, so `NO_COLOR=` is honoured too. COLORTERM is unaffected: it only
  // selects depth once colour is already on, and never forces it.
  if (mergedEnv.NO_COLOR === undefined) {
    mergedEnv.FORCE_COLOR = mergedEnv.FORCE_COLOR ?? "3";
  }
  mergedEnv.COLORTERM = mergedEnv.COLORTERM ?? "truecolor";

  // V8 bytecode cache for Node-based agent CLIs. Path is per-agent to
  // avoid cross-CLI cache invalidation; Node also auto-isolates by
  // version + V8 flags so a single dir is safe across runtime upgrades.
  // Only set when DAINTREE_USER_DATA is available (production) and the
  // caller has not provided an explicit override via intentionalEnv.
  const userData = process.env.DAINTREE_USER_DATA;
  const launchAgentId = options.launchAgentId;
  if (
    userData &&
    launchAgentId &&
    NODE_COMPILE_CACHE_AGENTS.has(launchAgentId) &&
    mergedEnv.NODE_COMPILE_CACHE === undefined
  ) {
    mergedEnv.NODE_COMPILE_CACHE = path.join(userData, "agent-compile-cache", launchAgentId);
  }

  return ensureUtf8Locale(mergedEnv);
}

export interface AcquiredTerminalProcess {
  ptyProcess: pty.IPty;
  /**
   * Bytes the pooled shell emitted before this acquire (banner, MOTD, prompt).
   * Empty for fresh-spawn paths. Callers MUST replay this through the
   * renderer's data path so the user sees the prompt — see PtyPool.acquireByKey.
   */
  prelude: string;
  dataHandoff?: PooledPtyDataHandoff;
}

function attachFreshSpawnDataHandoff(ptyProcess: pty.IPty): PooledPtyDataHandoff {
  const dataHandoff = new BufferedPtyDataHandoff();
  const dataDisposable = ptyProcess.onData((data) => dataHandoff.handle(data));
  dataHandoff.setDataDisposable(dataDisposable);
  return dataHandoff;
}

export function acquirePtyProcess(
  id: string,
  options: PtySpawnOptions,
  env: Record<string, string>,
  shell: string,
  args: string[],
  ptyPool: PtyPool | null,
  onWriteError: (error: unknown, context: { operation: string }) => void
): AcquiredTerminalProcess {
  // The pool is a global singleton; entries are keyed by (cwd, envHash).
  // We can hit the pool whenever the pool exists and the request is a plain
  // shell launch (no custom shell/args, not a dev-preview pane). The env-hash
  // lookup handles cases where another window pre-warmed at a different cwd
  // or with different env additions — those entries simply don't match the
  // wanted key and we fall through to fresh spawn + background warm.
  const canUsePool =
    shouldEnablePtyPool() &&
    !!ptyPool &&
    !options.shell &&
    !options.args &&
    options.kind !== "dev-preview";
  const envHash = computePoolEnvHash(options.env);
  let pooled = canUsePool ? ptyPool!.acquireByKey(options.cwd, envHash, id) : null;
  // Suppress unused-parameter lint for the write-error callback; kept in the
  // signature so future pool-acquisition logic (e.g. agent-preamble writes) can
  // still report through the same channel.
  void onWriteError;

  if (pooled) {
    try {
      pooled.process.resize(options.cols, options.rows);
    } catch (resizeError) {
      console.warn(
        `[TerminalProcess] Failed to resize pooled PTY for ${id}, falling back to spawn:`,
        resizeError
      );
      try {
        pooled.dataHandoff.dispose();
      } catch {
        // Ignore disposal errors
      }
      // Use destroyPty so the master FD is closed too — kill() alone leaves
      // /dev/ptmx open and stacks toward the system-wide ptmx_max (#7892).
      destroyPty(pooled.process);
      pooled = null;
    }
  }

  if (pooled) {
    // Pool entries are pre-spawned with the project cwd via node-pty's
    // `cwd` option (kernel-level chdir before exec), so no shell-level
    // `cd` write is needed and user `cd` overrides (zoxide, oh-my-zsh)
    // cannot interfere. See issue #5097.
    //
    // The pool's `prelude` carries any output the shell emitted before
    // acquire (typically the first prompt). TerminalProcess replays it
    // through the same data path live PTY output uses, so the renderer
    // xterm sees the prompt the user expects — see PtyPool.acquireByKey.
    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        `[TerminalProcess] Acquired terminal ${id} from pool (instant spawn, prelude=${pooled.prelude.length}B)`
      );
    }

    return {
      ptyProcess: pooled.process,
      prelude: pooled.prelude,
      dataHandoff: pooled.dataHandoff,
    };
  }

  // Pool miss — kick off a background warm for this exact (cwd, envHash) key
  // so the next spawn with the same shape hits the pool. The fresh spawn
  // below proceeds in parallel; the warm is fire-and-forget.
  if (canUsePool) {
    ptyPool!.warmForKey(options.cwd, options.env, envHash);
  } else if (shouldEnablePtyPool()) {
    markHostPerformance(PERF_MARKS.POOL_MISS, {
      terminalId: id,
      cwd: options.cwd,
      envHash,
      reason: !ptyPool
        ? "pool-unavailable"
        : options.shell || options.args
          ? "ineligible-custom-shell"
          : "ineligible-dev-preview",
    });
  }

  try {
    const ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env,
    });
    return { ptyProcess, prelude: "", dataHandoff: attachFreshSpawnDataHandoff(ptyProcess) };
  } catch (error) {
    console.error(`Failed to spawn terminal ${id}:`, error);
    throw error;
  }
}
