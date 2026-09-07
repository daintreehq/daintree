// @vitest-environment jsdom
/**
 * The host's entry point into the plugin styling contract: what
 * `PluginViewContent` actually calls.
 *
 * The runtime is mocked here on purpose. What matters at this seam is the
 * wiring — that preparation is deduped per view URL, that a styling failure can
 * never fail a mount, and that the Tailwind chunk stays behind a dynamic import
 * — none of which needs a real compiler to demonstrate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

const registerRoot = vi.fn(() => vi.fn());
const addSourceText = vi.fn();
const getReport = vi.fn(async () => ({ generated: ["p-4"], notGenerated: ["bg-red-500"] }));
const dispose = vi.fn();
const createPluginStyleRuntime = vi.fn(async () => ({
  registerRoot,
  addSourceText,
  getReport,
  dispose,
}));

vi.mock("@/services/plugin/tailwind/pluginStyleRuntime", () => ({ createPluginStyleRuntime }));

const {
  PLUGIN_STYLE_ROOT_PROPS,
  preparePluginStyles,
  registerPluginStyleRoot,
  getPluginStyleReport,
  resetPluginStyleContractForTests,
} = await import("@/services/plugin/pluginStyleContract");

function stubFetch(impl: (url: string) => Promise<Response> | Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => Promise.resolve(impl(String(input))))
  );
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  resetPluginStyleContractForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPluginStyleContractForTests();
});

describe("pluginStyleContract — the marker", () => {
  it("exposes the style-root attribute as spreadable props", () => {
    expect(PLUGIN_STYLE_ROOT_PROPS).toEqual({ [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "" });
    // Handed to plugin authors for portal containers, so it must not be
    // mutable by one view in a way that reaches the next.
    expect(Object.isFrozen(PLUGIN_STYLE_ROOT_PROPS)).toBe(true);
  });
});

describe("pluginStyleContract — preparation", () => {
  it("compiles the view's source before the mount is allowed to proceed", async () => {
    stubFetch(() => okResponse(`const cls = "p-4 gap-2";`));

    await preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js");

    expect(createPluginStyleRuntime).toHaveBeenCalledTimes(1);
    expect(addSourceText).toHaveBeenCalledWith(`const cls = "p-4 gap-2";`);
  });

  it("prepares once per view URL, however many panels mount at once", async () => {
    stubFetch(() => okResponse(`"p-4"`));
    const url = "plugin://abc/__dtv-1/dist/panel.js";

    await Promise.all([
      preparePluginStyles(url),
      preparePluginStyles(url),
      preparePluginStyles(url),
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(addSourceText).toHaveBeenCalledTimes(1);
  });

  it("prepares each hot-reload generation separately but shares one runtime", async () => {
    stubFetch(() => okResponse(`"p-4"`));

    await preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js");
    await preparePluginStyles("plugin://abc/__dtv-2/dist/panel.js");

    expect(fetch).toHaveBeenCalledTimes(2);
    // One compiler per document, not per generation.
    expect(createPluginStyleRuntime).toHaveBeenCalledTimes(1);
  });

  it("resolves even when the source read fails", async () => {
    // The source pass is an optimisation; the DOM observer styles the view
    // either way. A plugin that renders unstyled beats one that will not render,
    // so this must never reach the error boundary.
    stubFetch(() => Promise.reject(new Error("ERR_FAILED")));

    await expect(
      preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js")
    ).resolves.toBeUndefined();
    expect(addSourceText).not.toHaveBeenCalled();
  });

  it("resolves, and ingests nothing, on a non-OK response", async () => {
    stubFetch(() => new Response("", { status: 404 }));

    await expect(
      preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js")
    ).resolves.toBeUndefined();
    expect(addSourceText).not.toHaveBeenCalled();
  });

  it("resolves even when the runtime itself cannot load", async () => {
    createPluginStyleRuntime.mockRejectedValueOnce(new Error("chunk load failed"));
    stubFetch(() => okResponse(`"p-4"`));

    await expect(
      preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js")
    ).resolves.toBeUndefined();
    // Nothing to register against, but the view still mounts.
    expect(registerPluginStyleRoot(document.createElement("div"))).toBeTypeOf("function");
  });
});

describe("pluginStyleContract — root registration", () => {
  it("registers a mounted root with the document's runtime", async () => {
    stubFetch(() => okResponse(`"p-4"`));
    await preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js");

    const root = document.createElement("div");
    const unregister = registerPluginStyleRoot(root);

    expect(registerRoot).toHaveBeenCalledWith(root);
    expect(unregister).toBeTypeOf("function");
  });

  it("is a no-op for a null node", () => {
    // React calls a ref callback with null in the legacy teardown path; the
    // return value is still expected to be callable.
    expect(() => registerPluginStyleRoot(null)()).not.toThrow();
    expect(registerRoot).not.toHaveBeenCalled();
  });

  it("is a no-op before any view has prepared", () => {
    expect(() => registerPluginStyleRoot(document.createElement("div"))()).not.toThrow();
    expect(registerRoot).not.toHaveBeenCalled();
  });
});

describe("pluginStyleContract — diagnostics", () => {
  it("returns null when no plugin view has mounted in this document", async () => {
    // Distinct from "every class was fine", which is what an empty report would
    // claim (#12214).
    await expect(getPluginStyleReport()).resolves.toBeNull();
  });

  it("returns the runtime's report once a view has prepared", async () => {
    stubFetch(() => okResponse(`"p-4"`));
    await preparePluginStyles("plugin://abc/__dtv-1/dist/panel.js");

    await expect(getPluginStyleReport()).resolves.toEqual({
      generated: ["p-4"],
      notGenerated: ["bg-red-500"],
    });
  });
});
