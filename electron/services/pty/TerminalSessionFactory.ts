import * as pty from "node-pty";
import { existsSync } from "fs";
import type { PtyPool } from "../PtyPool.js";

/**
 * Options for creating a new terminal session.
 */
export interface TerminalSessionOptions {
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * Result of spawning a terminal session.
 */
export interface TerminalSessionResult {
  ptyProcess: pty.IPty;
  shell: string;
  wasPooled: boolean;
}

/**
 * Configuration for the session factory.
 */
export interface TerminalSessionFactoryConfig {
  /** Whether the terminal is an agent terminal (affects pool eligibility) */
  isAgentTerminal: boolean;
  /** Optional callback for logging write errors */
  onWriteError?: (error: unknown, context: { operation: string }) => void;
}

/**
 * TerminalSessionFactory - Handles PTY spawning with optional pooling.
 *
 * This factory encapsulates the logic for:
 * - Acquiring PTYs from a pool (for non-agent, default-config terminals)
 * - Spawning fresh PTYs when pool is unavailable or not applicable
 * - Handling platform-specific shell detection and cd commands
 */
export class TerminalSessionFactory {
  constructor(private ptyPool: PtyPool | null) {}

  /**
   * Spawn a new terminal session, using the pool if eligible.
   */
  spawn(
    options: TerminalSessionOptions,
    config: TerminalSessionFactoryConfig
  ): TerminalSessionResult {
    const shell = options.shell || this.getDefaultShell();
    const args = options.args || this.getDefaultShellArgs(shell);

    const baseEnv = process.env as Record<string, string | undefined>;
    const mergedEnv = { ...baseEnv, ...options.env };
    const env = Object.fromEntries(
      Object.entries(mergedEnv).filter(([_, value]) => value !== undefined)
    ) as Record<string, string>;

    // Pool eligibility: non-agent, no custom shell/env/args
    const canUsePool =
      this.ptyPool && !config.isAgentTerminal && !options.shell && !options.env && !options.args;

    let pooledPty = canUsePool ? this.ptyPool!.acquire() : null;

    // Attempt to use pooled PTY
    if (pooledPty) {
      try {
        pooledPty.resize(options.cols, options.rows);
      } catch (resizeError) {
        console.warn(
          `[TerminalSessionFactory] Failed to resize pooled PTY, falling back to spawn:`,
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
      // CD to working directory for pooled PTYs
      this.cdToWorkingDirectory(pooledPty, options.cwd, shell, config.onWriteError);

      if (process.env.CANOPY_VERBOSE) {
        console.log(`[TerminalSessionFactory] Acquired terminal from pool (instant spawn)`);
      }

      return {
        ptyProcess: pooledPty,
        shell,
        wasPooled: true,
      };
    }

    // Spawn fresh PTY
    try {
      const ptyProcess = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env,
      });

      return {
        ptyProcess,
        shell,
        wasPooled: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[TerminalSessionFactory] Failed to spawn terminal:`, errorMessage);
      throw new Error(`Failed to spawn terminal: ${errorMessage}`);
    }
  }

  /**
   * Change directory in a pooled PTY to the target working directory.
   */
  private cdToWorkingDirectory(
    ptyProcess: pty.IPty,
    cwd: string,
    shell: string,
    onWriteError?: (error: unknown, context: { operation: string }) => void
  ): void {
    try {
      if (process.platform === "win32") {
        const shellLower = shell.toLowerCase();
        if (shellLower.includes("powershell") || shellLower.includes("pwsh")) {
          ptyProcess.write(`Set-Location "${cwd.replace(/"/g, '""')}"\r`);
        } else {
          ptyProcess.write(`cd /d "${cwd.replace(/"/g, '\\"')}"\r`);
        }
      } else {
        ptyProcess.write(`cd "${cwd.replace(/"/g, '\\"')}"\r`);
      }
    } catch (error) {
      if (onWriteError) {
        onWriteError(error, { operation: "write(cwd)" });
      }
    }
  }

  /**
   * Get the default shell for the current platform.
   */
  private getDefaultShell(): string {
    if (process.platform === "win32") {
      return process.env.COMSPEC || "powershell.exe";
    }

    if (process.env.SHELL) {
      return process.env.SHELL;
    }

    const commonShells = ["/bin/zsh", "/bin/bash", "/bin/sh"];
    for (const shell of commonShells) {
      try {
        if (existsSync(shell)) {
          return shell;
        }
      } catch {
        // Ignore access errors
      }
    }

    return "/bin/sh";
  }

  /**
   * Get default shell arguments for the given shell.
   */
  private getDefaultShellArgs(shell: string): string[] {
    const shellName = shell.toLowerCase();

    if (process.platform !== "win32") {
      if (shellName.includes("zsh") || shellName.includes("bash")) {
        return ["-l"];
      }
    }

    return [];
  }
}

// Singleton instance for convenience
let defaultFactory: TerminalSessionFactory | null = null;

/**
 * Get or create the default terminal session factory.
 */
export function getTerminalSessionFactory(ptyPool: PtyPool | null): TerminalSessionFactory {
  if (!defaultFactory) {
    defaultFactory = new TerminalSessionFactory(ptyPool);
  }
  return defaultFactory;
}

/**
 * Reset the default factory (useful for testing).
 */
export function resetTerminalSessionFactory(): void {
  defaultFactory = null;
}
