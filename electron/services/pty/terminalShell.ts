// eager-import-allow: resolves the login shell via a sync fs check
import { existsSync } from "fs";
import { isPowerShellShell } from "../../../shared/utils/shellEscape.js";
import {
  isWindowsAbsolutePath,
  isWindowsLaunchFile,
  resolveWindowsExecutable,
  windowsEnvValue,
  windowsSystemTool,
} from "../../utils/windowsExecutable.js";

export interface ShellArgsOptions {
  nonInteractive?: boolean;
}

const MACOS_INTERACTIVE_SHELL_STARTUP_DELAY_SECONDS = "0.05";

export const WINDOWS_PS_UTF8_BOOTSTRAP =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false)";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Which PowerShell is on PATH is a process-lifetime constant, but
// `getDefaultShell()` is on the hot path for every terminal spawn and every
// shell-quoting decision, so the answer is memoized (an uncached `where.exe`
// probe is where the reporter's 53 `where.exe` spawns came from, #12042). A
// PATH change needs an app restart to take effect, which is the right trade
// for a value read this often.
let cachedWindowsShell: string | null = null;

export function findWindowsShell(): string {
  if (cachedWindowsShell !== null) return cachedWindowsShell;
  cachedWindowsShell = probeWindowsShell();
  return cachedWindowsShell;
}

/**
 * Always an absolute path: PowerShell 7 or Windows PowerShell from PATH, then
 * the in-box Windows PowerShell, then cmd.exe. Looked up in PATH only, so a
 * same-named file in the directory Daintree was started from is never chosen.
 */
function probeWindowsShell(): string {
  for (const shell of ["pwsh.exe", "powershell.exe"]) {
    const resolved = resolveWindowsExecutable(shell);
    if (resolved) return resolved;
  }
  const inbox = windowsSystemTool("powershell.exe");
  if (isWindowsLaunchFile(inbox)) return inbox;
  const comspec = windowsEnvValue(process.env, "COMSPEC");
  return comspec && isWindowsAbsolutePath(comspec) ? comspec : windowsSystemTool("cmd.exe");
}

/** Test-only: drop the memoized Windows shell so a case can re-probe. */
export function resetWindowsShellCache(): void {
  cachedWindowsShell = null;
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
