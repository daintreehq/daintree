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

// Note: the previous agent-specific non-interactive env shaping
// (`buildNonInteractiveEnv` + `AGENT_ENV_EXCLUSIONS`) was removed as part of
// the terminal-identity unification. All terminals now spawn identical
// interactive shells; per-agent env tiering is gone. See
// `docs/architecture/terminal-identity.md`.
