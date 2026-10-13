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

/** The path lists electron-builder's AppRun prefixes with the image's AppDir. */
const APPIMAGE_PATH_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];

/**
 * Removes the entries AppRun put under `appDir` from the environment's path
 * lists. The AppDir is a mount or an extraction that vanishes when Daintree
 * exits, and its `LD_LIBRARY_PATH` would load the image's bundled libraries
 * into anything else started with this environment.
 */
export function stripAppDirPathLists(
  env: Record<string, string | undefined>,
  appDir: string
): void {
  for (const name of APPIMAGE_PATH_LISTS) {
    const value = env[name];
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((entry) => entry !== appDir && !entry.startsWith(`${appDir}/`));
    if (kept.join(":") === value) continue;
    if (kept.length > 0 || name === "PATH") env[name] = kept.join(":");
    else delete env[name];
  }
}
