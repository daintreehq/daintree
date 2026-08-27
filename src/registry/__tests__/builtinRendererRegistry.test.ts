// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetBuiltinRendererRegistryForTests,
  getBuiltinView,
  registerBuiltinView,
  unregisterBuiltinView,
  useBuiltinView,
} from "../builtinRendererRegistry";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

// The slot guard renders a real ErrorBoundary; these are its reporting side
// channels, not anything under test here.
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/utils/rendererSentry", () => ({
  captureRendererException: vi.fn(),
  getRendererSentryConsent: vi.fn(() => ({ level: "off", hasSeenPrompt: false })),
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

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

  describe("dev-mode warn-on-miss", () => {
    it("warns when a non-empty slot ref was never registered", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(getBuiltinView("github.bulkCreateWorktreeDialog")).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("github.bulkCreateWorktreeDialog")
      );
    });

    it("warns only once per missing slot ref, not on every resolution", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      getBuiltinView("github.bulkCreateWorktreeDialog");
      getBuiltinView("github.bulkCreateWorktreeDialog");
      getBuiltinView("github.bulkCreateWorktreeDialog");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does not warn for an empty slot ref (the documented 'no slot' sentinel)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(getBuiltinView("")).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when the slot is registered but gated off by a disabled plugin", () => {
      registerBuiltinView("github.issueSelector", StubComponent, {
        pluginId: "daintree.github",
      });
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["daintree.github"]) });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(getBuiltinView("github.issueSelector")).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();

      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
    });
  });

  describe("slot failure isolation", () => {
    async function resolveSlotComponent(slotId: string) {
      const { renderHook } = await import("@testing-library/react");
      const { result } = renderHook(() => useBuiltinView<Record<string, unknown>>(slotId));
      return result.current;
    }

    it("contains a throwing slot view in a component-variant fallback", async () => {
      const { render, screen } = await import("@testing-library/react");
      vi.spyOn(console, "error").mockImplementation(() => {});
      function Exploding(): null {
        throw new Error("Failed to fetch dynamically imported module");
      }
      registerBuiltinView("github.statsDropdown", Exploding, { label: "GitHub list" });

      const Slot = await resolveSlotComponent("github.statsDropdown");
      expect(Slot).not.toBeNull();
      render(createElement(Slot!));

      // Rendering at all is the assertion: an unguarded throw would propagate
      // out of render() and fail the test instead of painting a fallback.
      expect(screen.getByTestId("error-fallback").dataset.variant).toBe("component");
      expect(screen.getByTestId("error-fallback-title").textContent).toContain("GitHub list");
    });

    it("passes slot props through to the wrapped view", async () => {
      const { render, screen } = await import("@testing-library/react");
      function Greeter({ name }: { name: string }) {
        return createElement("span", { "data-testid": "greeting" }, name);
      }
      registerBuiltinView("github.issueSelector", Greeter);

      const Slot = await resolveSlotComponent("github.issueSelector");
      render(createElement(Slot!, { name: "octocat" }));

      expect(screen.getByTestId("greeting").textContent).toBe("octocat");
    });

    it("rebuilds the wrapper when a slot is re-registered with a different view", async () => {
      registerBuiltinView("github.issueSelector", StubComponent);
      const first = await resolveSlotComponent("github.issueSelector");

      vi.spyOn(console, "warn").mockImplementation(() => {});
      registerBuiltinView("github.issueSelector", OtherStubComponent);
      const second = await resolveSlotComponent("github.issueSelector");

      expect(second).not.toBe(first);
    });
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
      const resolved = result.current;
      expect(resolved).not.toBeNull();

      act(() => {
        usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["daintree.github"]) });
      });
      await waitFor(() => {
        expect(result.current).toBeNull();
      });

      act(() => {
        usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
      });
      // Same component type back, not merely an equivalent one: a fresh wrapper
      // identity would remount the slot subtree on every enable-state change.
      await waitFor(() => {
        expect(result.current).toBe(resolved);
      });
    });
  });
});
