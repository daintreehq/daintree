import { isValidWslDistroName } from "../../../shared/types/remoteHosts.js";
import { windowsSystemTool } from "../../utils/windowsExecutable.js";
import type { CommandResult } from "./commandRunner.js";

/**
 * How Daintree runs a program inside a WSL distro: always
 * `wsl.exe -d <distro> --cd ~ --exec <program> <args…>`.
 *
 * `--exec` hands the argv to the program exactly as given, with no Linux shell
 * in between; `--` would run the line through the user's login shell, which
 * splits and expands it again. `--cd ~` starts in the distro user's home
 * rather than the Windows working directory under /mnt/c.
 */

/** wsl.exe's own messages (a missing distro, WSL not installed) in UTF-8 rather than UTF-16LE. */
export const WSL_ENV: Readonly<Record<string, string>> = { WSL_UTF8: "1" };

/** System32's wsl.exe, which forwards to whichever WSL (inbox or Store) is installed. */
export function wslExecutable(): string {
  return windowsSystemTool("wsl.exe");
}

export function wslExecArgs(distro: string, argv: readonly string[]): string[] {
  if (!isValidWslDistroName(distro)) throw new Error(`Not a usable WSL distribution: ${distro}`);
  const program = argv[0];
  if (!program || !program.startsWith("/")) {
    throw new Error("A program run in WSL must be an absolute Linux path");
  }
  return ["-d", distro, "--cd", "~", "--exec", ...argv];
}

/**
 * wsl.exe's exit code when it failed before running anything (no such
 * distro, the WSL service unavailable): -1 as an unsigned DWORD.
 */
export function isWslServiceFailure(code: number | null): boolean {
  return code === 4294967295 || code === -1;
}

/**
 * When wsl.exe itself fails, the program never ran and what came out on
 * stdout is wsl.exe's own message, so it moves to stderr, where a failure is
 * read from (see failureDetail).
 */
export function withWslDiagnostics(result: CommandResult): CommandResult {
  if (!isWslServiceFailure(result.code) || result.stdout.trim().length === 0) return result;
  return {
    ...result,
    stdout: "",
    stderr: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
  };
}
