import { isValidWslDistroName } from "../types/remoteHosts.js";

/**
 * Where Windows finds a path inside a WSL distro: `\\wsl.localhost\<distro>\…`
 * (the share WSL serves each running distro's filesystem on). Only for
 * handing a host path to this machine's file manager or another Windows
 * program; host paths stay POSIX everywhere else.
 *
 * Null for anything that isn't a plain absolute Linux path Windows can name:
 * relative, `.`/`..` segments, control characters, a backslash (a legal Linux
 * name character that Windows would read as a separator), or the characters
 * Windows file names can't hold.
 */
export function wslUncPath(distro: string, posixPath: string): string | null {
  if (!isValidWslDistroName(distro)) return null;
  if (!posixPath.startsWith("/")) return null;
  if (/[\0-\x1f\x7f\\:*?"<>|]/.test(posixPath)) return null;
  const segments = posixPath.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return `\\\\wsl.localhost\\${distro}${segments.length > 0 ? `\\${segments.join("\\")}` : "\\"}`;
}
