// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createPluginDocumentRuntime } from "../pluginDocumentRuntime";
import type { PluginDocumentPackage } from "@shared/types/pluginDocumentPackage";

const descriptor: PluginDocumentPackage = {
  name: "@acme/editor",
  version: "1.0.0",
  buildId: "a".repeat(64),
  entryUrl: "./editor.js",
  scope: "document",
};
const first = "plugin://pi-first/__dtv-1/dist/view.js";
const second = "plugin://pi-second/__dtv-2/dist/view.js";

describe("document packages", () => {
  it("deduplicates simultaneous plugins and retains object identities across authority replacement", async () => {
    const module = { Editor: class Editor {} };
    const importer = vi.fn(async () => module);
    const runtime = createPluginDocumentRuntime(importer);
    runtime.registerView("acme.first", first);
    runtime.registerView("acme.second", second);
    const loaded = await Promise.all([
      runtime.load(first, descriptor),
      runtime.load(second, descriptor),
    ]);
    expect(loaded[0]).toBe(module);
    expect(loaded[1]).toBe(module);
    runtime.registerView("acme.first", "plugin://pi-reloaded/__dtv-3/dist/view.js");
    expect(await runtime.load("plugin://pi-reloaded/__dtv-3/dist/view.js", descriptor)).toBe(
      module
    );
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledWith("plugin://pi-first/__dtv-1/dist/editor.js");
  });

  it("isolates ordinary package instances by plugin unless document sharing is explicit", async () => {
    const importer = vi.fn(async () => ({}));
    const runtime = createPluginDocumentRuntime(importer);
    runtime.registerView("acme.first", first);
    runtime.registerView("acme.second", second);
    const a = await runtime.load(first, { ...descriptor, scope: undefined });
    const b = await runtime.load(second, { ...descriptor, scope: undefined });
    expect(a).not.toBe(b);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it.each([{ version: "2.0.0" }, { buildId: "b".repeat(64) }])(
    "refuses incompatible packages before evaluating code: %j",
    async (change) => {
      const importer = vi.fn(async () => ({}));
      const runtime = createPluginDocumentRuntime(importer);
      runtime.registerView("acme.first", first);
      runtime.registerView("acme.second", second);
      await runtime.load(first, descriptor);
      await expect(runtime.load(second, { ...descriptor, ...change })).rejects.toThrow(
        /different version or build/
      );
      expect(importer).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot()[0]).toMatchObject({
        pluginId: "acme.second",
        owner: { pluginId: "acme.first" },
      });
    }
  );

  it("retains failure because a rejected import may have partially registered elements", async () => {
    const failure = new Error("partial evaluation");
    const importer = vi.fn(async () => {
      throw failure;
    });
    const runtime = createPluginDocumentRuntime(importer);
    runtime.registerView("acme.first", first);
    await expect(runtime.load(first, descriptor)).rejects.toBe(failure);
    await expect(runtime.load(first, descriptor)).rejects.toBe(failure);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot()).toHaveLength(1);
  });

  it.each([
    "https://example.com/pkg.js",
    "plugin://pi-second/pkg.js",
    "file:///tmp/pkg.js",
    "data:text/javascript,export default 1",
    "./pkg.js?reload=1",
  ])("rejects nonlocal or unstable entry URLs: %s", async (entryUrl) => {
    const importer = vi.fn();
    const runtime = createPluginDocumentRuntime(importer);
    runtime.registerView("acme.first", first);
    await expect(runtime.load(first, { ...descriptor, entryUrl })).rejects.toThrow(
      /registered local authority/
    );
    expect(importer).not.toHaveBeenCalled();
  });

  it("doesn't accept an unregistered requester or invalid package identity", async () => {
    const runtime = createPluginDocumentRuntime(vi.fn());
    await expect(runtime.load(first, descriptor)).rejects.toThrow(/registered local authority/);
    runtime.registerView("acme.first", first);
    await expect(runtime.load(first, { ...descriptor, version: "^1.0.0" })).rejects.toThrow(
      /exact version/
    );
  });
});

describe("custom element observation", () => {
  it("warns every consumer when a retained package's deferred registration conflicts", async () => {
    const runtime = createPluginDocumentRuntime(async () => ({}));
    runtime.registerView("acme.first", first);
    runtime.registerView("acme.second", second);
    await runtime.load(first, descriptor);
    await runtime.load(second, descriptor);
    const name = `test-${crypto.randomUUID()}`;
    customElements.define(name, class extends HTMLElement {});
    const restore = runtime.observe(customElements);
    try {
      const call = new Function(
        "registry",
        "name",
        "ctor",
        `registry.define(name, ctor);\n//# sourceURL=plugin://pi-first/__dtv-1/dist/editor.js`
      );
      expect(() => call(customElements, name, class extends HTMLElement {})).toThrow();
      expect(new Set(runtime.getSnapshot().map((item) => item.pluginId))).toEqual(
        new Set(["acme.first", "acme.second"])
      );
      runtime.registerView("acme.later", "plugin://pi-later/__dtv-3/view.js");
      await runtime.load("plugin://pi-later/__dtv-3/view.js", descriptor);
      expect(runtime.getSnapshot().some((item) => item.pluginId === "acme.later")).toBe(true);
    } finally {
      restore();
    }
  });

  it("records timer-source ownership, preserves the native exception and constructor, and attributes the error", () => {
    const runtime = createPluginDocumentRuntime();
    runtime.registerView("acme.first", first);
    runtime.registerView("acme.second", second);
    const restore = runtime.observe(customElements);
    class First extends HTMLElement {}
    class Second extends HTMLElement {}
    const name = `test-${crypto.randomUUID()}`;
    // Source URLs mimic browser frames; ownership is captured at define(), not import time.
    const define = (url: string, ctor: CustomElementConstructor) => {
      const call = new Function(
        "registry",
        "name",
        "ctor",
        `registry.define(name, ctor);\n//# sourceURL=${url}`
      );
      call(customElements, name, ctor);
    };
    try {
      define(first, First);
      let thrown: unknown;
      try {
        define(second, Second);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DOMException);
      if (!(thrown instanceof DOMException)) throw new Error("Expected native DOMException");
      expect(thrown.name).toBe("NotSupportedError");
      expect(customElements.get(name)).toBe(First);
      expect(runtime.errorSource(thrown)).toMatchObject({
        pluginId: "acme.second",
        generation: "__dtv-2",
      });
      expect(runtime.getSnapshot()[0]).toMatchObject({
        owner: { pluginId: "acme.first" },
        attempted: { pluginId: "acme.second" },
      });
    } finally {
      restore();
    }
  });

  it("leaves unrelated native failures untouched and never guesses an unknown source", () => {
    const runtime = createPluginDocumentRuntime();
    const restore = runtime.observe(customElements);
    try {
      expect(() => customElements.define("invalid", class extends HTMLElement {})).toThrow();
      expect(runtime.getSnapshot()).toEqual([]);
      expect(
        runtime.sourceForStack("at plugin://unregistered/__dtv-9/view.js:1:42")
      ).toBeUndefined();
      runtime.registerView("acme.first", first);
      expect(
        runtime.sourceForStack(`at plugin://unknown/view.js:1:2\nat ${first}:1:42`)
      ).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("reload confirmation", () => {
  it("resolves the pending request with the user's answer and supersedes an earlier one", async () => {
    const runtime = createPluginDocumentRuntime();
    expect(runtime.getReloadConfirmation()).toBeNull();
    const first = runtime.requestReloadConfirmation();
    const second = runtime.requestReloadConfirmation();
    expect(await first).toBe(false);
    expect(runtime.getReloadConfirmation()).not.toBeNull();
    runtime.resolveReloadConfirmation(true);
    expect(await second).toBe(true);
    expect(runtime.getReloadConfirmation()).toBeNull();
  });
});
