import { afterEach, expect, it, vi } from "vitest";
import { loadDocumentPackage } from "../react/loadDocumentPackage.js";
import { PLUGIN_DOCUMENT_PACKAGE_BRIDGE } from "../../../../shared/types/pluginDocumentPackage.js";

afterEach(() => vi.unstubAllGlobals());

it("passes the caller URL and package identity to the host rather than caching in the reloading SDK", async () => {
  const module = { Editor: class {} };
  const load = vi.fn(async () => module);
  vi.stubGlobal(PLUGIN_DOCUMENT_PACKAGE_BRIDGE, { load });
  const descriptor = {
    name: "editor",
    version: "1.0.0",
    buildId: "a".repeat(64),
    entryUrl: "./editor.js",
  };
  const url = "plugin://pi-example/__dtv-1/view.js";
  expect(await loadDocumentPackage(url, descriptor)).toBe(module);
  expect(load).toHaveBeenCalledWith(url, descriptor);
});

it("rejects with an actionable compatibility error on an older host", async () => {
  await expect(
    loadDocumentPackage("plugin://pi-example/view.js", {
      name: "editor",
      version: "1.0.0",
      buildId: "a".repeat(64),
      entryUrl: "./editor.js",
    })
  ).rejects.toThrow(/doesn't support document packages/);
});
