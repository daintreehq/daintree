import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_CTS = path.resolve(__dirname, "..", "..", "preload.cts");

/**
 * Main skips plugin pushes for renderers that reported no subscriber, so a
 * preload that stopped reporting a new subscription would starve its views.
 * Read as text, like the batch-unpacking check beside it: the preload pulls in
 * `electron` at module scope.
 */
describe("preload reports plugin push listeners", () => {
  it("reports on the dedicated channel, whole-set, from the subscriber registry", async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    expect(source).toMatch(
      /ipcRenderer\.send\(CHANNELS\.PLUGIN_REPORT_PUSH_LISTENERS, listeners\)/
    );
    expect(source).toMatch(
      /for \(const \[fullChannel, entry\] of _pluginPushChannels\)[\s\S]{0,120}entry\.subscribers\.keys\(\)/
    );
  });

  it("marks a change when a (channel, panel) bucket appears or empties", async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    const pushOn = source.indexOf("function _pluginPushOn(");
    const body = source.slice(pushOn, source.indexOf("\n}\n", pushOn));
    expect(body).toMatch(
      /entry\.subscribers\.set\(panelId, set\);\s*_markPluginListenersChanged\(\);/
    );
    expect(body).toMatch(
      /current\.subscribers\.delete\(panelId\);\s*_markPluginListenersChanged\(\);/
    );
  });

  it("reports once at load and flushes before every plugin invoke", async () => {
    const source = await readFile(PRELOAD_CTS, "utf8");
    expect(source).toMatch(/^_markPluginListenersChanged\(\);$/m);
    expect(source).toMatch(/function _pluginInvoke\([\s\S]{0,80}_flushPluginListenerReport\(\);/);
    expect(source).toContain("...buildPluginPreloadBindings(_pluginInvoke),");
    expect(source).toMatch(
      /_pluginInvoke\(CHANNELS\.PLUGIN_INVOKE, pluginId, channel, \.\.\.args\)/
    );
  });
});
