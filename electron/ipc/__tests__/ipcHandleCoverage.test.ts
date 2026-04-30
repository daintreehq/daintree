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
]);

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
    const files = [...(await walk(handlersDir)), errorHandlersPath];

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
