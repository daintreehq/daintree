import * as nodePath from "path";
import * as nodeFs from "fs";
import { AppError } from "../../utils/errorTypes.js";

// Extensions that shell.openPath / the OS would execute rather than reveal.
// On macOS, opening a .app (or .command/.scpt) launches it; on Windows a
// .exe/.bat/.lnk runs; on Linux a .desktop/.sh/.AppImage executes. We deny
// these for caller-supplied paths regardless of containment, since a
// malicious file dropped inside an allowed root must not become a launch
// primitive. Selected per-platform at module init.
//
// Lives here rather than beside the system IPC handler because the plugin host
// (`PluginHostFactory`) needs the identical deny-list for `host.system.openPath`
// and must not import an IPC-handler module to get it.
const DENIED_EXTENSIONS_BY_PLATFORM: Record<string, readonly string[]> = {
  darwin: [".app", ".command", ".terminal", ".scpt", ".scptd", ".pkg", ".dmg", ".desktop"],
  linux: [".desktop", ".sh", ".appimage", ".run"],
  win32: [
    ".exe",
    ".bat",
    ".cmd",
    ".com",
    ".scr",
    ".pif",
    ".vbs",
    ".ps1",
    ".msi",
    ".lnk",
    ".jar",
    ".reg",
    ".cpl",
    ".wsf",
    ".hta",
  ],
};

const DENIED_EXTENSIONS = new Set<string>(DENIED_EXTENSIONS_BY_PLATFORM[process.platform] ?? []);

/**
 * Reject a path whose extension the OS would execute rather than open.
 *
 * Callers that hand a path to a launcher (`shell.openPath`) must run this
 * twice — once on the raw input and once on the realpath-resolved target — so
 * a benignly-named symlink (`notes.txt` → `Evil.app`) inside an allowed root
 * can't smuggle an executable past the deny-list. Reveal-only sinks
 * (`shell.showItemInFolder`) and read-only sinks (an editor) don't need it:
 * they display the file, they don't run it.
 */
export function assertExtensionAllowed(candidate: string): void {
  const ext = nodePath.extname(candidate).toLowerCase();
  if (DENIED_EXTENSIONS.has(ext)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: `Refusing to open executable file type: ${ext}`,
      context: { candidate, ext },
    });
  }
}

/**
 * Resolve a renderer-supplied path and assert it is contained within one of
 * the allowed roots. Both the target and each root are run through
 * `fs.realpath` (re-resolved at call time) so symlinks can't smuggle a path
 * out of its root after the fact — the same containment idiom used by
 * `electron/ipc/handlers/files.ts` (PR #6263).
 *
 * Returns the canonical (realpath-resolved) target so callers can hand the
 * resolved path to the sink rather than the original string, shrinking the
 * TOCTOU window between check and use.
 *
 * Throws `AppError` with code `INVALID_PATH` for non-absolute or
 * unresolvable paths, and `OUTSIDE_ROOT` when the target is not contained in
 * any allowed root.
 */
export async function resolveContainedPath(
  targetPath: string,
  roots: readonly string[]
): Promise<string> {
  if (!nodePath.isAbsolute(targetPath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Only absolute paths are allowed",
      context: { targetPath },
    });
  }

  let realTarget: string;
  try {
    realTarget = await nodeFs.promises.realpath(targetPath);
  } catch (error) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Could not resolve path",
      context: { targetPath },
      cause: error instanceof Error ? error : undefined,
    });
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await nodeFs.promises.realpath(root);
    } catch {
      // A stale or deleted root can't contain anything — skip it.
      continue;
    }
    // realRoot === path.sep is degenerate (realRoot + sep becomes "//", which
    // never prefix-matches); treat any absolute path as contained then.
    const contained =
      realRoot === nodePath.sep
        ? realTarget.startsWith(nodePath.sep)
        : realTarget === realRoot || realTarget.startsWith(realRoot + nodePath.sep);
    if (contained) {
      return realTarget;
    }
  }

  throw new AppError({
    code: "OUTSIDE_ROOT",
    message: "Path is outside all allowed roots",
    context: { targetPath },
  });
}
