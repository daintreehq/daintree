import * as nodePath from "path";
import { AppError } from "./errorTypes.js";

// Extensions that shell.openPath / the OS would execute rather than reveal.
// On macOS, opening a .app (or .command/.scpt) launches it; on Windows a
// .exe/.bat/.lnk runs; on Linux a .desktop/.sh/.AppImage executes. We deny
// these for caller-supplied paths regardless of containment, since a
// malicious file dropped inside an allowed root must not become a launch
// primitive. Selected per-platform at module init.
//
// Lives in electron/utils rather than beside the system IPC handler because
// both the handler and the plugin host (`PluginHostFactory.buildSystemApi`)
// need the identical deny-list, and the plugin host must not import an
// IPC-handler module to get it.
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
