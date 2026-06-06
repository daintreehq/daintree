import os from "os";

/**
 * Pure path-sanitizing utility for telemetry, diagnostics, and audit
 * surfaces. Replaces the current user's home directory and common
 * macOS / Linux / Windows user paths with `~` or `USER` placeholders so
 * shareable strings don't reveal account names.
 *
 * Extracted from `TelemetryService.ts` so consumers (e.g. the MCP audit
 * log) can apply the same scrub without dragging Sentry initialization
 * into their import graph.
 */

const HOME_DIR = os.homedir();
const HOME_DIR_ESCAPED = HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HOME_DIR_REGEX = new RegExp(HOME_DIR_ESCAPED, "g");

export function sanitizePath(str: string): string {
  return (
    str
      .replace(HOME_DIR_REGEX, "~")
      // WSL UNC paths — `\\wsl$\<distro>\home\USER` and
      // `\\wsl.localhost\<distro>\home\USER`. The username lives after the
      // distro segment, so the /home/ pattern can't reach it (backslash
      // separators). `[$.]` matches both prefixes without `$` anchoring.
      // Handle the JSON-doubled backslash form before the raw form; keep the
      // distro and redact only the username.
      .replace(/(\\\\\\\\wsl[$.][^\\"]*\\\\[^\\"]+\\\\home\\\\)[^\\"]+/gi, "$1USER")
      .replace(/(\\\\wsl[$.][^\\"]*\\[^\\"]+\\home\\)[^\\"]+/gi, "$1USER")
      // macOS / Linux / Windows user profiles. Match only the username segment
      // (no required trailing separator, lesson #4979) so bare paths at the end
      // of a string are scrubbed too, and generalize the Windows drive letter so
      // non-`C:` profiles (e.g. `D:\Users\alice`) are covered.
      .replace(/(\/Users\/)[^/"\\]+/g, "$1USER")
      .replace(/(\/home\/)[^/"\\]+/g, "$1USER")
      .replace(/([A-Za-z]:\\Users\\)[^\\"]+/gi, "$1USER")
      .replace(/([A-Za-z]:\/Users\/)[^/"\\]+/gi, "$1USER")
  );
}
