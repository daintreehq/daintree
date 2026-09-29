import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_CTS = path.resolve(__dirname, "..", "..", "preload.cts");

/**
 * Main delivers every plugin push inside a batch message, so a preload that
 * stopped listening for batches would silently deliver nothing to any plugin
 * view. Read as text: `preload.cts` is CommonJS for the Electron sandbox and
 * pulls in `electron` at module scope.
 */
describe("preload unpacks batched plugin pushes", () => {
  it("listens on the batch channel and replays entries through the per-channel dispatcher", async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    expect(source).toContain(
      'import { PLUGIN_PUSH_BATCH_CHANNEL } from "./services/plugin/pluginPushProtocol.js";'
    );
    expect(source).toMatch(/ipcRenderer\.on\(PLUGIN_PUSH_BATCH_CHANNEL,/);
    expect(source).toMatch(
      /_pluginPushChannels\.get\(entry\[0\]\)\?\.handler\(event, entry\[1\]\)/
    );
    // Attached before the first subscriber can miss a batch.
    const pushOn = source.indexOf("function _pluginPushOn(");
    expect(pushOn).toBeGreaterThan(-1);
    expect(source.indexOf("_attachPluginPushBatchListener();", pushOn)).toBeGreaterThan(pushOn);
  });
});
