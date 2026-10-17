import { afterEach, describe, expect, it, vi } from "vitest";
import { getPluginKitHost, setPluginKitHost } from "../kitHost";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe("kitHost", () => {
  it("is inert without a host: refusals, never throws on read", async () => {
    const host = getPluginKitHost();
    const result = await host.dispatchAction("file.view", {}, { source: "user" });
    expect(result.ok).toBe(false);
    expect(host.getAction("file.view")).toBeNull();
    expect(host.showToast({ type: "info", message: "x" })).toBeNull();
    expect(() => host.dismissToast("n1")).not.toThrow();
    expect(host.pluginDisplayName("acme")).toBeUndefined();
    await expect(host.invokePlugin("acme", "sendToAgent", {})).rejects.toThrow();
    expect(host.DiffViewer).toBeNull();
  });

  it("keeps capabilities a new host leaves out inert, not the last host's", () => {
    const first = vi.fn(() => "a");
    const disposeFirst = setPluginKitHost({ showToast: first });
    dispose = setPluginKitHost({ pluginDisplayName: () => "Acme" });
    expect(getPluginKitHost().showToast({ type: "info", message: "x" })).toBeNull();
    expect(first).not.toHaveBeenCalled();
    expect(getPluginKitHost().pluginDisplayName("acme")).toBe("Acme");
    disposeFirst();
  });

  it("treats an undefined capability as left out", () => {
    dispose = setPluginKitHost({ showToast: undefined, DiffViewer: null });
    expect(getPluginKitHost().showToast({ type: "info", message: "x" })).toBeNull();
  });

  it("lets only the current host's disposer clear it", () => {
    const disposeOld = setPluginKitHost({ pluginDisplayName: () => "Old" });
    dispose = setPluginKitHost({ pluginDisplayName: () => "New" });
    disposeOld();
    expect(getPluginKitHost().pluginDisplayName("acme")).toBe("New");
    dispose();
    dispose = undefined;
    expect(getPluginKitHost().pluginDisplayName("acme")).toBeUndefined();
  });
});
