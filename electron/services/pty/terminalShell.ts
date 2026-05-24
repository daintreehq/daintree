// eager-import-allow: resolves the login shell via a sync fs check
import { existsSync } from "fs";
import { execFileSync } from "child_process";
import { isPowerShellShell } from "../../../shared/utils/shellEscape.js";

export interface ShellArgsOptions {
  nonInteractive?: boolean;
}

const MACOS_INTERACTIVE_SHELL_STARTUP_DELAY_SECONDS = "0.05";

const WINDOWS_PS_UTF8_BOOTSTRAP =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

  if (process.platform === "win32") {
    const basename = shellName.split(/[\\/]/).pop() ?? "";
    if (basename === "cmd.exe") {
      return ["/K", "chcp 65001 >NUL"];
    }
    // PowerShell 7+ defaults are UTF-8 internally, but [Console]::OutputEncoding
    // still drives decoding of native tools (git, docker, etc.) — keep the
    // bootstrap on both pwsh.exe and powershell.exe. -NoLogo suppresses the
    // startup banner for both. cmd.exe has no equivalent flag.
    if (isPowerShellShell(shell)) {
      return ["-NoLogo", "-NoExit", "-Command", WINDOWS_PS_UTF8_BOOTSTRAP];
    }
    return [];
  }

  if (shellName.includes("zsh") || shellName.includes("bash")) {
    if (process.platform === "darwin") {
      return [
        "-c",
        `sleep ${MACOS_INTERACTIVE_SHELL_STARTUP_DELAY_SECONDS}\nexec ${shellQuote(shell)} -l`,
      ];
    }
    return ["-l"];
  }

  return [];
}

// Note: the previous agent-specific non-interactive env shaping
// (`buildNonInteractiveEnv` + `AGENT_ENV_EXCLUSIONS`) was removed as part of
// the terminal-identity unification. All terminals now spawn identical
// interactive shells; per-agent env tiering is gone. See
// `docs/architecture/terminal-identity.md`.
