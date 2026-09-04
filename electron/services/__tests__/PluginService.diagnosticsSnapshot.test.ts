import { describe, expect, it, vi } from "vitest";
import type { PluginDiagnosticsSnapshot } from "../../../shared/types/ipc/pluginDiagnostics.js";

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
import { makeProjectPluginInstanceKey } from "../../../shared/types/plugin.js";

/**
 * The seam under test, declared structurally. Method syntax makes the parameter
 * bivariant, so a real `PluginService` is assignable here without an assertion
 * and this file adds no unsafe cast of its own.
 */
interface DiagnosticsSeam {
  _registerFakePluginForTests(plugin: FakeLoadedPlugin, instanceKey?: string): void;
  getDiagnosticsSnapshot(): PluginDiagnosticsSnapshot;
}

interface FakeLoadedPlugin {
  manifest: { name: string; version: string; displayName: string };
  dir: string;
  isBuiltin: boolean;
  loadedAt: number;
}

function fakePlugin(name: string): FakeLoadedPlugin {
  return {
    // A fresh object per call, exactly as two real loads of one id produce two
    // separately parsed manifests.
    manifest: { name, version: "1.0.0", displayName: name },
    dir: `/tmp/${name}`,
    isBuiltin: false,
    loadedAt: 1,
  };
}

function newSeam(): DiagnosticsSeam {
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
    const seam = newSeam();
    const instanceKey = makeProjectPluginInstanceKey("a".repeat(64), "acme.demo");
    seam._registerFakePluginForTests(fakePlugin("acme.demo"), instanceKey);

    const ids = seam.getDiagnosticsSnapshot().plugins.map((p) => p.pluginId);

    expect(ids).toContain(instanceKey);
    // The bare manifest id is not what the registry holds it under, so it must
    // not appear as a second, phantom entry.
    expect(ids).not.toContain("acme.demo");
  });

  it("still reports an installed plugin under its plain manifest id", () => {
    const seam = newSeam();
    seam._registerFakePluginForTests(fakePlugin("acme.installed"));

    expect(seam.getDiagnosticsSnapshot().plugins.map((p) => p.pluginId)).toContain(
      "acme.installed"
    );
  });

  it("keeps two projects' copies of one id apart", () => {
    const seam = newSeam();
    const keyA = makeProjectPluginInstanceKey("a".repeat(64), "acme.demo");
    const keyB = makeProjectPluginInstanceKey("b".repeat(64), "acme.demo");
    seam._registerFakePluginForTests(fakePlugin("acme.demo"), keyA);
    seam._registerFakePluginForTests(fakePlugin("acme.demo"), keyB);

    const ids = seam.getDiagnosticsSnapshot().plugins.map((p) => p.pluginId);
    expect(ids).toContain(keyA);
    expect(ids).toContain(keyB);
  });
});
