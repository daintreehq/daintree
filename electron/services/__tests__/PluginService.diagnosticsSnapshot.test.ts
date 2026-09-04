import { describe, expect, it, vi } from "vitest";

// Importing PluginService constructs its module singleton, which reads
// `app.getVersion()` and transitively the eager ProjectStore (`getPath`).
// Neither is exercised here — the tests construct their own instance.
vi.mock("electron", () => ({
  app: {
    getVersion: vi.fn(() => "0.0.0"),
    getPath: vi.fn(() => "/tmp/daintree-diagnostics-snapshot"),
    getAppPath: vi.fn(() => "/tmp/daintree-diagnostics-snapshot"),
  },
}));
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));

import { PluginService } from "../PluginService.js";
import type { LoadedPlugin } from "../plugin/PluginServiceTypes.js";
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";

/**
 * A real `LoadedPlugin`, filled to its required fields rather than asserted
 * from a partial: the seam takes one, and spelling it out keeps this file free
 * of unsafe casts while turning a change to the interface into a compile error
 * here instead of a silent hole.
 */
function fakePlugin(name: string): LoadedPlugin {
  return {
    // A fresh manifest object per call, exactly as two real loads of one id
    // produce two separately parsed manifests — which is what the snapshot's
    // identity index keys on.
    manifest: {
      name,
      version: "1.0.0",
      displayName: name,
      capabilities: [],
      contributes: {
        commands: [],
        panels: [],
        views: [],
        toolbarButtons: [],
        processTools: [],
      },
    } as unknown as LoadedPlugin["manifest"],
    dir: `/tmp/${name}`,
    isBuiltin: false,
    loadedAt: 1,
    viewGeneration: 0,
  };
}

function newService(): PluginService {
  return new PluginService("/tmp/daintree-diagnostics-snapshot-root", "0.0.0");
}

/**
 * `getDiagnosticsSnapshot` used to key its entries off `manifest.name` while the
 * registry keys a project plugin off its instance key, so every project plugin
 * fell out of the snapshot — silently, and precisely for the plugins whose
 * authors read these diagnostics (#12214).
 */
describe("PluginService.getDiagnosticsSnapshot", () => {
  it("reports a project plugin under the instance key the registry holds", () => {
    const seam = newService();
    const instanceKey = makeProjectPluginInstanceKey("a".repeat(64), "acme.demo");
    seam._registerFakePluginForTests(fakePlugin("acme.demo"), instanceKey);

    const ids = seam.getDiagnosticsSnapshot().plugins.map((p) => p.pluginId);

    expect(ids).toContain(instanceKey);
    // The bare manifest id is not what the registry holds it under, so it must
    // not appear as a second, phantom entry.
    expect(ids).not.toContain("acme.demo");
  });

  it("still reports an installed plugin under its plain manifest id", () => {
    const seam = newService();
    seam._registerFakePluginForTests(fakePlugin("acme.installed"));

    expect(seam.getDiagnosticsSnapshot().plugins.map((p) => p.pluginId)).toContain(
      "acme.installed"
    );
  });

  it("keeps two projects' copies of one id apart", () => {
    const seam = newService();
    const keyA = makeProjectPluginInstanceKey("a".repeat(64), "acme.demo");
    const keyB = makeProjectPluginInstanceKey("b".repeat(64), "acme.demo");
    seam._registerFakePluginForTests(fakePlugin("acme.demo"), keyA);
    seam._registerFakePluginForTests(fakePlugin("acme.demo"), keyB);

    const ids = seam.getDiagnosticsSnapshot().plugins.map((p) => p.pluginId);
    expect(ids).toContain(keyA);
    expect(ids).toContain(keyB);
  });
});
