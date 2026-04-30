import * as pty from "node-pty";
import {
  filterEnvironment,
  injectDaintreeMetadata,
  ensureUtf8Locale,
} from "./EnvironmentFilter.js";
import { getDefaultShell, getDefaultShellArgs } from "./terminalShell.js";
import type { PtySpawnOptions } from "./types.js";
import type { PtyPool } from "../PtyPool.js";

export interface SpawnContext {
  shell: string;
  args: string[];
  env: Record<string, string>;
}

export function computeSpawnContext(id: string, options: PtySpawnOptions): SpawnContext {
  const shell = options.shell || getDefaultShell();
  const args = options.args || getDefaultShellArgs(shell);
  const env = buildTerminalEnv(options, id, shell);
  return { shell, args, env };
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
  // (chalk, supports-color, termenv, ink) honour these. Plain shells and
  // agent CLIs both benefit; neither suffers.
  mergedEnv.FORCE_COLOR = mergedEnv.FORCE_COLOR ?? "3";
  mergedEnv.COLORTERM = mergedEnv.COLORTERM ?? "truecolor";

  return ensureUtf8Locale(mergedEnv);
}

export function acquirePtyProcess(
  id: string,
  options: PtySpawnOptions,
  env: Record<string, string>,
  shell: string,
  args: string[],
  ptyPool: PtyPool | null,
  onWriteError: (error: unknown, context: { operation: string }) => void
): pty.IPty {
  // The pool is a global singleton pre-warmed at whichever project most
  // recently called drainAndRefill(). In multi-window setups a different
  // window may have drained the pool to a different cwd, so skip the pool
  // when its current cwd doesn't match the caller's request — the direct
  // pty.spawn below will honour options.cwd via node-pty's kernel chdir.
  const poolCwdMatches = ptyPool ? ptyPool.getDefaultCwd() === options.cwd : false;
  const canUsePool =
    ptyPool &&
    poolCwdMatches &&
    !options.shell &&
    !options.env &&
    !options.args &&
    options.kind !== "dev-preview";
  let pooledPty = canUsePool ? ptyPool!.acquire() : null;
  // Suppress unused-parameter lint for the write-error callback; kept in the
  // signature so future pool-acquisition logic (e.g. agent-preamble writes) can
  // still report through the same channel.
  void onWriteError;

  if (pooledPty) {
    try {
      pooledPty.resize(options.cols, options.rows);
    } catch (resizeError) {
      console.warn(
        `[TerminalProcess] Failed to resize pooled PTY for ${id}, falling back to spawn:`,
        resizeError
      );
      try {
        pooledPty.kill();
      } catch {
        // Process may already be dead
      }
      pooledPty = null;
    }
  }

  if (pooledPty) {
    // Pool entries are pre-spawned with the project cwd via node-pty's
    // `cwd` option (kernel-level chdir before exec), so no shell-level
    // `cd` write is needed and user `cd` overrides (zoxide, oh-my-zsh)
    // cannot interfere. See issue #5097.
    //
    // No clear-screen preamble is written here. The shell's RC output is
    // what the user should see first — it's the prompt. Hiding it
    // historically produced visible escape-garbage on slow pools.
    if (process.env.DAINTREE_VERBOSE) {
      console.log(`[TerminalProcess] Acquired terminal ${id} from pool (instant spawn)`);
    }

    return pooledPty;
  }

  try {
    return pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env,
    });
  } catch (error) {
    console.error(`Failed to spawn terminal ${id}:`, error);
    throw error;
  }
}
