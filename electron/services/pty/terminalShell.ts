// eager-import-allow: resolves the login shell via a sync fs check
import { existsSync } from "fs";
import { isPowerShellShell } from "../../../shared/utils/shellEscape.js";
import {
  isWindowsAbsolutePath,
  isWindowsLaunchFileAsync,
  resolveWindowsExecutable,
  windowsEnvValue,
  windowsExecutableCacheGeneration,
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

// `getDefaultShell()` is on the hot path for every terminal spawn and every
// shell-quoting decision, and is synchronous, while finding PowerShell 7 means
// searching PATH, whose entries can include a network share that takes the SMB
// timeout to fail. So the search runs asynchronously, at startup and again
// whenever PATH changes or is re-read, and its answer is memoized (an uncached
// `where.exe` probe is where the reporter's 53 `where.exe` spawns came from,
// #12042). Until the first answer lands the in-box Windows PowerShell is used,
// by absolute path and without looking at the disk.
let windowsShell: { shell: string; stamp: string } | null = null;
let windowsShellProbe: { stamp: string; promise: Promise<string> } | null = null;

/** What a resolved shell was resolved against: the PATH, and the resolver cache's generation. */
function windowsShellStamp(env: NodeJS.ProcessEnv): string {
  return `${windowsExecutableCacheGeneration()}\0${windowsEnvValue(env, "PATH") ?? ""}`;
}

/**
 * The Windows default shell, never blocking: the last resolved answer, or the
 * in-box Windows PowerShell before the first one. A stale answer (PATH changed
 * or was re-read since) is still returned, and starts a fresh resolution.
 */
export function findWindowsShell(): string {
  if (windowsShell?.stamp === windowsShellStamp(process.env)) return windowsShell.shell;
  void prewarmWindowsShell();
  return windowsShell?.shell ?? windowsSystemTool("powershell.exe");
}

/**
 * Resolve the Windows default shell for the current PATH, once per PATH: what
 * `findWindowsShell` returns from then on. Startup calls it so the first
 * terminal already gets PowerShell 7 when PATH has it.
 */
export function prewarmWindowsShell(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const stamp = windowsShellStamp(env);
  if (windowsShell?.stamp === stamp) return Promise.resolve(windowsShell.shell);
  if (windowsShellProbe?.stamp === stamp) return windowsShellProbe.promise;
  const promise = probeWindowsShell(env)
    .catch(() => windowsSystemTool("powershell.exe", env))
    .then((shell) => {
      if (windowsShellProbe?.promise === promise) windowsShellProbe = null;
      windowsShell = { shell, stamp };
      return shell;
    });
  windowsShellProbe = { stamp, promise };
  return promise;
}

/**
 * Always an absolute path: PowerShell 7 or Windows PowerShell from PATH, then
 * the in-box Windows PowerShell, then cmd.exe. Looked up in PATH only, so a
 * same-named file in the directory Daintree was started from is never chosen.
 */
async function probeWindowsShell(env: NodeJS.ProcessEnv): Promise<string> {
  const onPath = await Promise.all(
    ["pwsh.exe", "powershell.exe"].map((shell) => resolveWindowsExecutable(shell, env))
  );
  const resolved = onPath.find((shell): shell is string => shell !== null);
  if (resolved) return resolved;
  const inbox = windowsSystemTool("powershell.exe", env);
  if (await isWindowsLaunchFileAsync(inbox)) return inbox;
  const comspec = windowsEnvValue(env, "COMSPEC");
  return comspec && isWindowsAbsolutePath(comspec) ? comspec : windowsSystemTool("cmd.exe", env);
}

/** Test-only: drop the memoized Windows shell so a case can re-probe. */
export function resetWindowsShellCache(): void {
  windowsShell = null;
  windowsShellProbe = null;
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
