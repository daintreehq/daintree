/**
 * Platform detection utilities and shell escaping functions.
 * Provides safe escaping for CLI arguments to prevent shell injection.
 */

/**
 * Detects if the current platform is Windows.
 * Works in both Node.js and browser environments.
 */
export function isWindows(): boolean {
  // Node.js environment
  if (typeof process !== "undefined" && process.platform) {
    return process.platform === "win32";
  }
  // Browser environment - check navigator.userAgent
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return /\bWindows\b|\bWin(32|64)\b/.test(navigator.userAgent);
  }
  return false;
}

/**
 * Escapes a string for safe use as a shell argument.
 * Uses single quotes on Unix (POSIX) and double quotes on Windows (cmd.exe).
 *
 * @param arg - The string to escape
 * @param platform - Optional platform override ('windows' or 'posix')
 * @returns The escaped string safe for use as a shell argument
 *
 * @example
 * // On Unix/macOS:
 * escapeShellArg("hello world") // "'hello world'"
 * escapeShellArg("it's working") // "'it'\\''s working'"
 *
 * // On Windows:
 * escapeShellArg('say "hello"') // '"say ""hello"""'
 */
export function escapeShellArg(arg: string, platform?: "windows" | "posix"): string {
  // Handle empty strings
  if (arg === "") {
    return platform === "windows" || (platform === undefined && isWindows()) ? '""' : "''";
  }

  const useWindows = platform === "windows" || (platform === undefined && isWindows());

  if (useWindows) {
    return escapeWindowsArg(arg);
  }
  return escapePosixArg(arg);
}

/**
 * Escapes a string for use in Windows cmd.exe.
 * Uses double quotes and escapes internal double quotes by doubling them.
 *
 * Windows cmd.exe rules:
 * - Wrap in double quotes
 * - Escape internal double quotes by doubling them (" → "")
 * - Backslashes before quotes need special handling
 */
export function escapeWindowsArg(arg: string): string {
  // Replace double quotes with escaped double quotes
  // Windows uses "" to escape a double quote inside a double-quoted string
  let escaped = arg.replace(/"/g, '""');

  // Handle trailing backslashes which can escape the closing quote
  // Each backslash before the closing quote needs to be doubled
  if (escaped.endsWith("\\")) {
    const match = escaped.match(/\\+$/);
    if (match) {
      escaped = escaped + match[0]; // Double the trailing backslashes
    }
  }

  return `"${escaped}"`;
}

/**
 * Escapes a string for PowerShell `-Command` / `-EncodedCommand` script input.
 * Wraps the value in single quotes and escapes embedded single quotes by
 * doubling them (PowerShell's literal-string escape rule). Single-quoted
 * PowerShell strings are literal: no variable expansion, no subexpression
 * evaluation. Use this for values interpolated into a PowerShell script body.
 *
 * @example
 *   quotePowerShellArg("C:\\Users\\O'Brien\\config.json")
 *   // "'C:\\Users\\O''Brien\\config.json'"
 */
export function quotePowerShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

/**
 * Returns true if `shellPath` resolves to a PowerShell host (`pwsh` or
 * `powershell`, with or without the `.exe` suffix). Basename-exact match —
 * never substring — so paths like `C:\src\tools\powerwash.exe` don't false-
 * match. Platform-agnostic: the caller decides whether to gate on Windows.
 */
export function isPowerShellShell(shellPath: string): boolean {
  const name =
    shellPath
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? "";
  return name === "pwsh" || name === "powershell";
}

/**
 * Returns true if `shellPath` resolves to Windows cmd.exe. Basename-exact
 * match — never substring — so paths like `C:\tools\cmder\bin\bash.exe`
 * don't false-match. Platform-agnostic: the caller decides whether to gate
 * on Windows.
 */
export function isCmdShell(shellPath: string): boolean {
  const name =
    shellPath
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? "";
  return name === "cmd";
}

/**
 * Platform- and shell-aware quoting for values interpolated into a launch
 * command string. The returned token is safe to splice into a command line
 * that will be executed by `shellPath` on `process.platform`:
 *
 * - POSIX (any shell): POSIX single-quote escaping.
 * - Windows + PowerShell (pwsh / powershell): PowerShell single-quote
 *   escaping (single quotes doubled).
 * - Windows + cmd.exe: cmd-style double-quote escaping.
 * - Windows + unknown shell: POSIX-style as a least-bad fallback. Callers
 *   should validate the shell against {@link isPowerShellShell} /
 *   {@link isCmdShell} upstream when correctness matters.
 *
 * Use this at every site that previously called a hand-rolled POSIX
 * `shellQuote` to embed an internal app-controlled value (config path,
 * subcommand flag) into a command that may run on Windows.
 */
export function quoteCommandArg(value: string, shellPath: string): string {
  if (typeof process !== "undefined" && process.platform === "win32") {
    if (isPowerShellShell(shellPath)) {
      // Windows PowerShell 5.1 and pwsh .cmd shims use legacy native argument
      // passing. Preserve embedded quotes across that second boundary
      // (notably Codex's TOML config overrides).
      return quotePowerShellArg(value.replace(/"/g, '\\"'));
    }
    if (isCmdShell(shellPath)) {
      return escapeWindowsArg(value);
    }
  }
  return escapePosixArg(value);
}

/**
 * Escapes a string for use in POSIX shells (bash, zsh, etc.).
 * Uses single quotes which prevent all interpretation except single quotes themselves.
 *
 * POSIX single quote rules:
 * - Everything inside single quotes is literal
 * - Single quotes themselves cannot be escaped inside single quotes
 * - To include a single quote: end quote, add escaped quote, restart quote
 *   Example: 'it'\''s' (end single quote, escaped single quote, restart)
 */
function escapePosixArg(arg: string): string {
  // Replace single quotes with: end quote, backslash-escaped quote, start quote
  // 'foo'bar' becomes 'foo'\''bar'
  const escaped = arg.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

/**
 * Checks if a string is safe to use without escaping.
 * Returns true if the string contains only alphanumeric characters,
 * hyphens, underscores, and forward slashes.
 */
export function isSafeUnescaped(arg: string): boolean {
  return /^[a-zA-Z0-9_\-/]+$/.test(arg);
}

/**
 * Escapes a string for shell argument, but returns it unquoted if it's "safe".
 * Use this when you want cleaner output for simple strings.
 */
export function escapeShellArgOptional(arg: string, platform?: "windows" | "posix"): string {
  if (arg === "") {
    return escapeShellArg(arg, platform);
  }
  if (isSafeUnescaped(arg)) {
    return arg;
  }
  return escapeShellArg(arg, platform);
}

// Mirrored deny-list used by `sanitizeCustomArgs` (electron/ipc/handlers/helpAssistant.ts)
// and the `customFlags` / `args` validation in src/config/agents.ts. Values flow into
// whitespace-split tokens that are appended to the launch command, so any character
// that could break out of the flag list is rejected as defense-in-depth (the real
// boundary is node-pty with no shell layer). `$(` and `${` are matched as substrings
// to avoid over-blocking legitimate bare `$` in flag values.
//
// POSIX-oriented: cmd.exe-specific metachars (`%VAR%`, `^`, `!`) are intentionally
// omitted because the spawn path is node-pty without a `cmd.exe` shell layer, so
// those characters cannot trigger expansion. If a future code path ever feeds a
// flag value through `cmd.exe`, that path needs its own escaping/validation step.
const SHELL_METACHAR_PATTERNS = [";", "|", "&", ">", "<", "$(", "${", "`", "\\"] as const;

/**
 * Returns `true` if the value contains any shell metacharacter that could
 * break out of an argv-style flag list (command separators, redirection,
 * substitution, or backslash escapes).
 */
export function hasShellMetachar(value: string): boolean {
  for (const pattern of SHELL_METACHAR_PATTERNS) {
    if (value.includes(pattern)) return true;
  }
  return false;
}
