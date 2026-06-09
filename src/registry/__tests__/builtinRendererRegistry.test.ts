// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetBuiltinRendererRegistryForTests,
  getBuiltinView,
  registerBuiltinView,
  unregisterBuiltinView,
  useBuiltinView,
} from "../builtinRendererRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

function StubComponent(): null {
  return null;
}

function OtherStubComponent(): null {
  return null;
}

describe("builtinRendererRegistry", () => {
  afterEach(() => {
    __resetBuiltinRendererRegistryForTests();
    vi.restoreAllMocks();
  });

  it("returns null for unregistered slots", () => {
    expect(getBuiltinView("github.bulkCreateWorktreeDialog")).toBeNull();
  });

  it("returns the registered component", () => {
    registerBuiltinView("github.issueSelector", StubComponent);
    expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);
  });

  it("warns and overwrites when a slot is registered twice", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBuiltinView("github.issueSelector", StubComponent);
    registerBuiltinView("github.issueSelector", OtherStubComponent);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("already registered"));
    expect(getBuiltinView("github.issueSelector")).toBe(OtherStubComponent);
  });

  it("unregisters slots and reports whether anything was removed", () => {
    registerBuiltinView("github.issueSelector", StubComponent);
    expect(unregisterBuiltinView("github.issueSelector")).toBe(true);
    expect(unregisterBuiltinView("github.issueSelector")).toBe(false);
    expect(getBuiltinView("github.issueSelector")).toBeNull();
  });

  describe("plugin enable-state gating", () => {
    afterEach(() => {
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
    });

    it("resolves null while the owning plugin is disabled, and again after re-enable", () => {
      registerBuiltinView("github.issueSelector", StubComponent, {
        pluginId: "daintree.github",
      });
      expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);

      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["daintree.github"]) });
      expect(getBuiltinView("github.issueSelector")).toBeNull();

      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
      expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);
    });

    it("never gates slots registered without an owning plugin", () => {
      registerBuiltinView("host.someView", StubComponent);
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["daintree.github"]) });
      expect(getBuiltinView("host.someView")).toBe(StubComponent);
    });

    it("only gates slots owned by the disabled plugin", () => {
      registerBuiltinView("github.issueSelector", StubComponent, {
        pluginId: "daintree.github",
      });
      registerBuiltinView("other.view", OtherStubComponent, { pluginId: "acme.other" });
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["acme.other"]) });

      expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);
      expect(getBuiltinView("other.view")).toBeNull();
    });

    it("useBuiltinView re-resolves reactively when the owner's enable state flips", async () => {
      const { renderHook, waitFor, act } = await import("@testing-library/react");
      registerBuiltinView("github.issueSelector", StubComponent, {
        pluginId: "daintree.github",
      });

      const { result } = renderHook(() => useBuiltinView("github.issueSelector"));
      expect(result.current).toBe(StubComponent);

      act(() => {
        usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["daintree.github"]) });
      });
      await waitFor(() => {
        expect(result.current).toBeNull();
      });

      act(() => {
        usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
      });
      await waitFor(() => {
        expect(result.current).toBe(StubComponent);
      });
    });
  });
});
