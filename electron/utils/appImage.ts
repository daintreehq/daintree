import path from "node:path";

/**
 * The AppImage this process was started from, when it was: its runtime sets
 * APPIMAGE and APPDIR and runs the binary from inside APPDIR. An APPIMAGE
 * with no such mount around this binary is only an inherited variable.
 */
export function runningAppImage(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath
): string | null {
  const image = env.APPIMAGE;
  const dir = env.APPDIR;
  if (!image || !dir || !path.isAbsolute(image) || !path.isAbsolute(dir)) return null;
  const rel = path.relative(dir, execPath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel) ? image : null;
}
