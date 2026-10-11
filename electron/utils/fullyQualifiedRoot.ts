import path from "path";

/**
 * Whether a workspace root is safe to join against. An empty or relative root —
 * which SQLite's NOT NULL columns still permit from corrupt or legacy state —
 * would silently resolve against the main process's own cwd.
 *
 * `path.win32.isAbsolute` also accepts rooted-but-not-qualified paths such as a
 * bare leading separator, which `resolve` then completes with the process's
 * *current drive* — the same context-dependent root. So on Windows require a
 * drive root or a full UNC share.
 */
export function isFullyQualifiedRoot(rootPath: string): boolean {
  if (rootPath === "") return false;
  return process.platform === "win32"
    ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/])/.test(rootPath)
    : path.isAbsolute(rootPath);
}
