import * as pty from "node-pty";
import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import {
  filterEnvironment,
  injectDaintreeMetadata,
  ensureUtf8Locale,
} from "./EnvironmentFilter.js";
import {
  buildNonInteractiveEnv,
  AGENT_ENV_EXCLUSIONS,
  getDefaultShell,
  getDefaultShellArgs,
} from "./terminalShell.js";
import type { PtySpawnOptions } from "./types.js";
import type { PtyPool } from "../PtyPool.js";

export interface SpawnContext {
  shell: string;
  args: string[];
  isAgentTerminal: boolean;
  agentId: string | undefined;
  env: Record<string, string>;
}

export function computeSpawnContext(id: string, options: PtySpawnOptions): SpawnContext {
  const shell = options.shell || getDefaultShell();
  const args = options.args || getDefaultShellArgs(shell);

  const isAgentByKind = options.kind === "agent";
  const isAgentByAgentId = !!options.agentId;
  const isAgentByType = !!(options.type && options.type !== "terminal");
  const isAgentTerminal = isAgentByKind || isAgentByAgentId || isAgentByType;
  const agentId = isAgentTerminal
    ? (options.agentId ?? (options.type !== "terminal" ? options.type : id))
    : undefined;

  const env = buildTerminalEnv(options, id, shell, isAgentTerminal, agentId);

  return { shell, args, isAgentTerminal, agentId, env };
}

export function buildTerminalEnv(
  options: PtySpawnOptions,
  id: string,
  shell: string,
  isAgentTerminal: boolean,
  agentId: string | undefined
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
      worktreeId: options.worktreeId,
    }
  );

  // For agent terminals, use non-interactive environment to suppress prompts
  // (oh-my-zsh updates, Homebrew notifications, etc.)
  // Pass agentId for agent-specific exclusions (e.g., Gemini CLI is sensitive to CI=1)
  // Then merge agent-specific env vars from the agent registry config,
  // filtering out any excluded vars to prevent bypassing agent-specific safeguards
  const agentConfig = agentId ? getEffectiveAgentConfig(agentId) : undefined;
  const agentEnv = agentConfig?.env ?? {};
  const normalizedAgentId = agentId?.toLowerCase();
  const exclusions = new Set(
    normalizedAgentId ? (AGENT_ENV_EXCLUSIONS[normalizedAgentId] ?? []) : []
  );
  const filteredAgentEnv = Object.fromEntries(
    Object.entries(agentEnv).filter(([key]) => !exclusions.has(key) && !key.startsWith("DAINTREE_"))
  ) as Record<string, string>;

  return ensureUtf8Locale(
    isAgentTerminal
      ? { ...buildNonInteractiveEnv(mergedEnv, shell, agentId), ...filteredAgentEnv }
      : mergedEnv
  );
}

export function acquirePtyProcess(
  id: string,
  options: PtySpawnOptions,
  env: Record<string, string>,
  shell: string,
  args: string[],
  isAgentTerminal: boolean,
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
    !isAgentTerminal &&
    !options.shell &&
    !options.env &&
    !options.args &&
    options.kind !== "dev-preview";
  let pooledPty = canUsePool ? ptyPool!.acquire() : null;

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
    if (process.platform !== "win32") {
      try {
        // Clear any pooled-shell init noise so the user sees a clean prompt.
        // \033[H cursor home, \033[2J clear screen, \033[3J clear scrollback.
        pooledPty.write(`printf '\\033[H\\033[2J\\033[3J'\r`);
      } catch (error) {
        onWriteError(error, { operation: "write(clear)" });
      }
    }

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
