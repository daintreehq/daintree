import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Channels that intentionally use raw `ipcMain.handle(...)` instead of
 * `typedHandle`/`typedHandleWithContext`. Adding to this list requires a
 * documented reason in the handler file.
 */
const RAW_HANDLE_ALLOWLIST = new Set<string>([
  // plugin:invoke — variadic ...args + senderFrame.url trust check is
  // incompatible with IpcInvokeMap typing; see electron/ipc/handlers/plugin.ts.
  "CHANNELS.PLUGIN_INVOKE",

  // Window-management handlers in electron/window/createWindow.ts. These
  // operate on `event.sender` directly (BrowserWindow.fromWebContents,
  // zoom factor mutations, devtools toggling) — wrapping each through
  // typedHandle would force unnecessary IpcInvokeMap noise for what are
  // genuinely event-sender-coupled commands. They share the multi-window
  // bootstrap path with `WINDOW_NEW`.
  "CHANNELS.WINDOW_NEW",
  "CHANNELS.WINDOW_TOGGLE_FULLSCREEN",
  "CHANNELS.WINDOW_RELOAD",
  "CHANNELS.WINDOW_FORCE_RELOAD",
  "CHANNELS.WINDOW_TOGGLE_DEVTOOLS",
  "CHANNELS.WINDOW_ZOOM_IN",
  "CHANNELS.WINDOW_ZOOM_OUT",
  "CHANNELS.WINDOW_ZOOM_RESET",
  "CHANNELS.WINDOW_CLOSE",

  // Windows-Store auto-update settings handlers in
  // electron/services/WindowsStoreNotifierService.ts — registered lazily by
  // a service constructor (not in handlers/) and only on Windows-Store
  // builds. The typed-handle adapter assumes ipc/handlers/ wiring; until the
  // service migrates, the four channels stay on raw `ipcMain.handle`.
  "CHANNELS.STORE_UPDATE_GET_SETTINGS",
  "CHANNELS.STORE_UPDATE_SET_SETTINGS",
  "CHANNELS.STORE_UPDATE_GET_LATEST",
  "CHANNELS.STORE_UPDATE_DISMISS",
]);

/**
 * Additional files outside `electron/ipc/handlers/` that register
 * `ipcMain.handle` calls. Adding a file here widens the drift scan; the
 * matching channels typically need an entry in `RAW_HANDLE_ALLOWLIST` above.
 */
const EXTRA_HANDLER_FILES = [
  path.join("electron", "window", "createWindow.ts"),
  path.join("electron", "services", "WindowsStoreNotifierService.ts"),
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const results: string[] = [];
  for (const entry of entries) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      results.push(...(await walk(full)));
    } else if (entry.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("IPC handler coverage", () => {
  it("uses typedHandle/typedHandleWithContext for every ipcMain.handle call", async () => {
    const handlersDir = path.join(__dirname, "..", "handlers");
    const errorHandlersPath = path.join(__dirname, "..", "errorHandlers.ts");
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const extraFiles = EXTRA_HANDLER_FILES.map((rel) => path.join(repoRoot, rel));
    const files = [...(await walk(handlersDir)), errorHandlersPath, ...extraFiles];

    const violations: Array<{ file: string; line: string }> = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const lines = source.split("\n");
      for (const line of lines) {
        const match = line.match(/ipcMain\.handle\(\s*(CHANNELS\.\w+)/);
        if (!match) continue;
        const ref = match[1];
        if (RAW_HANDLE_ALLOWLIST.has(ref)) continue;
        violations.push({ file: path.relative(process.cwd(), file), line: line.trim() });
      }
    }

    expect(
      violations,
      `Handler files must use typedHandle/typedHandleWithContext (see electron/ipc/utils.ts). ` +
        `Add the channel to RAW_HANDLE_ALLOWLIST only if the channel cannot be expressed ` +
        `through IpcInvokeMap — document the reason in the handler file.`
    ).toEqual([]);
  });
});
