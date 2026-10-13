// eager-import-allow: resolves the login shell via a sync fs check
import { existsSync } from "fs";
import { isPowerShellShell } from "../../../shared/utils/shellEscape.js";
import {
  isWindowsAbsolutePath,
  isWindowsLaunchFileAsync,
  lookupWindowsExecutable,
  windowsEnvValue,
  windowsExecutableCacheGeneration,
  windowsPathEntriesReadable,
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
interface ResolvedWindowsShell {
  shell: string;
  stamp: string;
  /** The PATH it was resolved against. */
  path: string;
  /**
   * Reached past PATH entries that did not answer, so one of them may hold an
   * earlier PowerShell; resolved again once one of them can be read.
   */
  skipped: string[];
  /** Set when a skipped entry answers again: the next read resolves afresh. */
  recheck: boolean;
}

// A provisional answer is re-resolved at most this many times per PATH, so a
// share that stays dead is not polled forever on the shell's behalf.
const MAX_PROVISIONAL_RECHECKS = 3;

let windowsShell: ResolvedWindowsShell | null = null;
let windowsShellProbe: { stamp: string; promise: Promise<string> } | null = null;
let provisionalRechecks: { stamp: string; count: number } | null = null;

/** What a resolved shell was resolved against: the PATH, and the resolver cache's generation. */
function windowsShellStamp(env: NodeJS.ProcessEnv): string {
  return `${windowsExecutableCacheGeneration()}\0${windowsEnvValue(env, "PATH") ?? ""}`;
}

function isSettledFor(resolved: ResolvedWindowsShell | null, stamp: string): boolean {
  return resolved?.stamp === stamp && !resolved.recheck;
}

/**
 * The Windows default shell, never blocking: the last resolved answer, or the
 * in-box Windows PowerShell before the first one. A stale answer (PATH changed
 * or was re-read since) is still returned, and starts a fresh resolution.
 */
export function findWindowsShell(): string {
  if (windowsShell && isSettledFor(windowsShell, windowsShellStamp(process.env))) {
    return windowsShell.shell;
  }
  void prewarmWindowsShell();
  return windowsShell?.shell ?? windowsSystemTool("powershell.exe");
}

/**
 * Resolve the Windows default shell for the current PATH, once per PATH: what
 * `findWindowsShell` returns from then on. Startup calls it so the first
 * terminal already gets PowerShell 7 when PATH has it.
 */
export function prewarmWindowsShell(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  // A snapshot: PATH can be replaced while the search runs, and the answer must
  // describe the PATH its stamp names.
  const snapshot = { ...env };
  const stamp = windowsShellStamp(snapshot);
  if (windowsShell && isSettledFor(windowsShell, stamp)) return Promise.resolve(windowsShell.shell);
  if (windowsShellProbe?.stamp === stamp) return windowsShellProbe.promise;
  const promise: Promise<string> = probeWindowsShell(snapshot)
    .catch(() => ({ shell: windowsSystemTool("powershell.exe", snapshot), skipped: [] }))
    .then(({ shell, skipped }) => {
      // Only the newest probe publishes. One a later PATH superseded may finish
      // after it, and must not put its answer over the newer one.
      if (windowsShellProbe?.promise !== promise) return shell;
      windowsShellProbe = null;
      const resolved: ResolvedWindowsShell = {
        shell,
        stamp,
        path: windowsEnvValue(snapshot, "PATH") ?? "",
        skipped,
        recheck: false,
      };
      windowsShell = resolved;
      if (skipped.length > 0) recheckWhenReadable(resolved);
      return shell;
    });
  windowsShellProbe = { stamp, promise };
  return promise;
}

/**
 * A provisional answer is resolved again as soon as one of the PATH entries it
 * went past can be read (its slow call returned, or its retry window passed),
 * so PowerShell 7 on a share that was only slow is picked up without waiting
 * for the next PATH change.
 */
function recheckWhenReadable(resolved: ResolvedWindowsShell): void {
  if (provisionalRechecks?.stamp !== resolved.stamp) {
    provisionalRechecks = { stamp: resolved.stamp, count: 0 };
  }
  const rechecks = provisionalRechecks;
  if (rechecks.count >= MAX_PROVISIONAL_RECHECKS) return;
  rechecks.count++;
  void windowsPathEntriesReadable(resolved.skipped).then(() => {
    if (windowsShell !== resolved) return;
    resolved.recheck = true;
    // Against the PATH in force now: if it changed meanwhile, that answer is
    // the one wanted anyway.
    void prewarmWindowsShell();
  });
}

/**
 * Wait, at most `maxWaitMs`, until the default shell has an answer for the
 * current PATH, for a caller about to use it for something it cannot change
 * afterwards (the shell a command launch runs in). Returns at once when the
 * answer is already settled for this PATH, or when it is provisional with
 * nothing in flight that could improve it; only a PATH it has not been
 * resolved against yet (startup, a PATH that just changed) or a re-check under
 * way is waited for. Never rejects.
 */
export async function waitForWindowsShell(maxWaitMs: number): Promise<void> {
  if (process.platform !== "win32") return;
  const currentPath = windowsEnvValue(process.env, "PATH") ?? "";
  const resolved = windowsShell;
  if (resolved && resolved.path === currentPath && !resolved.recheck) {
    // A re-read of the same PATH (a new cache generation) is re-resolved in
    // the background, as `findWindowsShell` would.
    if (resolved.stamp !== windowsShellStamp(process.env)) void prewarmWindowsShell();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prewarmWindowsShell().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Always an absolute path: PowerShell 7 or Windows PowerShell from PATH, then
 * the in-box Windows PowerShell, then cmd.exe. Looked up in PATH only, so a
 * same-named file in the directory Daintree was started from is never chosen.
 * `skipped` lists the PATH entries the deciding lookups went past without an
 * answer; any makes the answer provisional.
 */
async function probeWindowsShell(
  env: NodeJS.ProcessEnv
): Promise<{ shell: string; skipped: string[] }> {
  const [pwsh, powershell] = await Promise.all(
    ["pwsh.exe", "powershell.exe"].map((shell) => lookupWindowsExecutable(shell, env))
  );
  if (pwsh.file) return { shell: pwsh.file, skipped: pwsh.skipped };
  const skipped = [...new Set([...pwsh.skipped, ...powershell.skipped])];
  if (powershell.file) return { shell: powershell.file, skipped };
  const inbox = windowsSystemTool("powershell.exe", env);
  if (await isWindowsLaunchFileAsync(inbox)) return { shell: inbox, skipped };
  const comspec = windowsEnvValue(env, "COMSPEC");
  return {
    shell: comspec && isWindowsAbsolutePath(comspec) ? comspec : windowsSystemTool("cmd.exe", env),
    skipped,
  };
}

/** Test-only: drop the memoized Windows shell so a case can re-probe. */
export function resetWindowsShellCache(): void {
  windowsShell = null;
  windowsShellProbe = null;
  provisionalRechecks = null;
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
