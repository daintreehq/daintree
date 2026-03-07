import { existsSync } from "fs";
import { execFileSync } from "child_process";

export interface ShellArgsOptions {
  nonInteractive?: boolean;
}

export function findWindowsShell(): string {
  for (const shell of ["pwsh.exe", "powershell.exe"]) {
    try {
      execFileSync("where", [shell], { stdio: "ignore", timeout: 3000 });
      return shell;
    } catch {
      // not on PATH or timed out, try next
    }
  }
  return process.env.COMSPEC || "cmd.exe";
}

export function getDefaultShell(): string {
  if (process.platform === "win32") {
    return findWindowsShell();
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
      // Continue to next shell
    }
  }

  return "/bin/sh";
}

export function getDefaultShellArgs(shell: string, _options?: ShellArgsOptions): string[] {
  const shellName = shell.toLowerCase();

  if (process.platform !== "win32") {
    if (shellName.includes("zsh") || shellName.includes("bash")) {
      return ["-l"];
    }
  }

  return [];
}

/**
 * Agent-specific environment variable exclusions.
 * Some CLI tools are sensitive to certain environment variables that break their
 * interactive mode or initialization process.
 *
 * Gemini CLI: Uses the `ink` React framework for terminal UI, which depends on
 * `is-in-ci` to detect CI environments. When CI=1 is set, ink enters non-interactive
 * mode and the CLI fails to display its input prompt.
 * See: https://github.com/google-gemini/gemini-cli/issues/1563
 */
export const AGENT_ENV_EXCLUSIONS: Record<string, string[]> = {
  claude: ["CLAUDECODE"],
  gemini: ["CI", "NONINTERACTIVE"],
};

/**
 * Build environment variables that suppress interactive prompts during shell initialization.
 * Used for agent terminals where predictable, non-interactive startup is required.
 *
 * @param baseEnv - Base environment to extend
 * @param _shell - Shell being used (currently unused but available for shell-specific logic)
 * @param agentId - Optional agent ID to apply agent-specific exclusions
 */
export function buildNonInteractiveEnv(
  baseEnv: Record<string, string | undefined>,
  _shell: string,
  agentId?: string
): Record<string, string> {
  // Get agent-specific exclusions (converted to Set for O(1) lookup)
  // Normalize agentId to lowercase for case-insensitive matching
  const normalizedAgentId = agentId?.toLowerCase();
  const exclusions = new Set(
    normalizedAgentId ? (AGENT_ENV_EXCLUSIONS[normalizedAgentId] ?? []) : []
  );
  const env: Record<string, string> = {};

  // Helper to conditionally set env var (skips if in exclusion list)
  const setEnv = (key: string, value: string): void => {
    if (!exclusions.has(key)) {
      env[key] = value;
    }
  };

  // Copy base environment, filtering out undefined values AND excluded variables
  // This ensures agent-specific exclusions apply even when vars are in the base environment
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !exclusions.has(key)) {
      env[key] = value;
    }
  }

  // oh-my-zsh and similar frameworks
  // Disables automatic update checks that show interactive prompts
  setEnv("DISABLE_AUTO_UPDATE", "true");
  setEnv("DISABLE_UPDATE_PROMPT", "true");

  // Zsh completion verification
  setEnv("ZSH_DISABLE_COMPFIX", "true");

  // Homebrew
  // Prevents "brew update" from running automatically during shell startup
  setEnv("HOMEBREW_NO_AUTO_UPDATE", "1");

  // Debian/Ubuntu package managers
  // Prevents dpkg/apt from asking configuration questions
  setEnv("DEBIAN_FRONTEND", "noninteractive");

  // Generic non-interactive flag
  // Many shell tools check this to disable interactive behavior
  // Note: Excluded for Gemini CLI which uses ink framework (is-in-ci detection)
  setEnv("NONINTERACTIVE", "1");

  // Suppress pagers (less, more, etc.) that would block command output
  // Use empty string instead of "cat" to avoid dependency on external commands
  setEnv("PAGER", "");

  // GIT_PAGER: Suppress git's pager for diff, log, etc.
  setEnv("GIT_PAGER", "");

  // CI flag: Many tools detect CI environments and disable prompts
  // Only set if not already defined to avoid overriding explicit values
  // Note: Excluded for Gemini CLI which uses ink framework (is-in-ci detection)
  if (!env.CI && !exclusions.has("CI")) {
    env.CI = "1";
  }

  // Force color output: Many CLI tools (chalk, supports-color, etc.) disable
  // colors when they detect CI=1. Override this since our xterm.js terminal
  // fully supports ANSI colors. FORCE_COLOR=3 enables 256-color support.
  setEnv("FORCE_COLOR", "3");
  setEnv("COLORTERM", "truecolor");

  // Git credential prompts
  setEnv("GIT_TERMINAL_PROMPT", "0");

  // NVM (Node Version Manager)
  // Suppress "NVM is out of date" messages
  setEnv("NVM_DIR_SILENT", "1");

  // Pyenv
  // Suppress shell initialization warnings
  setEnv("PYENV_VIRTUALENV_DISABLE_PROMPT", "1");

  // RVM (Ruby Version Manager)
  // Suppress rvm auto-update prompts
  setEnv("rvm_silence_path_mismatch_check_flag", "1");

  return env;
}
