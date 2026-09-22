// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetBuiltinRendererRegistryForTests,
  getBuiltinView,
  registerBuiltinView,
  unregisterBuiltinView,
  useBuiltinPanelView,
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

const GITHUB = "daintree.github";

/**
 * The runtime mirror as it stands once a `plugin.list()` snapshot has landed.
 * Owned slots resolve to null until then, so every case about an *enabled*
 * plugin has to seed it — an empty mirror is "unknown", not "enabled".
 */
function seedKnownPlugins(...pluginIds: string[]): void {
  usePluginRuntimeStore.setState({
    pluginMetaById: new Map(
      pluginIds.map((id) => [
        id,
        { devMode: false, displayName: id, previewToolIds: new Set<string>() },
      ])
    ),
  });
}

function resetRuntimeMirror(): void {
  usePluginRuntimeStore.setState({
    disabledPluginIds: new Set<string>(),
    pluginMetaById: new Map(),
  });
}

describe("builtinRendererRegistry", () => {
  afterEach(() => {
    __resetBuiltinRendererRegistryForTests();
    resetRuntimeMirror();
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
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });
      // Seeded so resolution reaches the *disabled* check: an unseeded owner
      // exits at the unknown gate and the case would prove nothing about it.
      seedKnownPlugins(GITHUB);
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set([GITHUB]) });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(getBuiltinView("github.issueSelector")).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
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
    it("resolves null while the owning plugin is disabled, and again after re-enable", () => {
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });
      seedKnownPlugins(GITHUB);
      expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);

      usePluginRuntimeStore.setState({ disabledPluginIds: new Set([GITHUB]) });
      expect(getBuiltinView("github.issueSelector")).toBeNull();

      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
      expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);
    });

    it("never gates slots registered without an owning plugin", () => {
      registerBuiltinView("host.someView", StubComponent);
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set([GITHUB]) });
      // Not seeded: a null-owner slot answers before any snapshot exists.
      expect(getBuiltinView("host.someView")).toBe(StubComponent);
    });

    it("only gates slots owned by the disabled plugin", () => {
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });
      registerBuiltinView("other.view", OtherStubComponent, { pluginId: "acme.other" });
      seedKnownPlugins(GITHUB, "acme.other");
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set(["acme.other"]) });

      expect(getBuiltinView("github.issueSelector")).toBe(StubComponent);
      expect(getBuiltinView("other.view")).toBeNull();
    });

    it("resolves null for an owned slot before the first plugin snapshot lands", () => {
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });
      // Empty disabled set plus empty mirror is the cold-start state: unknown,
      // and unknown must not render.
      expect(getBuiltinView("github.issueSelector")).toBeNull();
    });

    it("resolves null for an owned slot whose plugin the snapshot never mentions", () => {
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });
      seedKnownPlugins("acme.other");
      expect(getBuiltinView("github.issueSelector")).toBeNull();
    });

    it("useBuiltinView admits an owned slot once its plugin's metadata arrives", async () => {
      const { renderHook, waitFor, act } = await import("@testing-library/react");
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });

      const { result } = renderHook(() => useBuiltinView("github.issueSelector"));
      expect(result.current).toBeNull();

      act(() => seedKnownPlugins(GITHUB));
      await waitFor(() => {
        expect(result.current).not.toBeNull();
      });
    });

    it("useBuiltinView re-resolves reactively when the owner's enable state flips", async () => {
      const { renderHook, waitFor, act } = await import("@testing-library/react");
      registerBuiltinView("github.issueSelector", StubComponent, { pluginId: GITHUB });
      seedKnownPlugins(GITHUB);

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

  describe("late slot registration", () => {
    it("useBuiltinView picks up a slot registered after the consumer mounted", async () => {
      const { renderHook, act } = await import("@testing-library/react");
      const { result } = renderHook(() => useBuiltinView("github.statsDropdown"));
      expect(result.current).toBeNull();

      act(() => registerBuiltinView("github.statsDropdown", StubComponent));
      expect(result.current).not.toBeNull();
    });

    it("useBuiltinView drops a slot unregistered under it", async () => {
      const { renderHook, act } = await import("@testing-library/react");
      registerBuiltinView("github.statsDropdown", StubComponent);
      const { result } = renderHook(() => useBuiltinView("github.statsDropdown"));
      expect(result.current).not.toBeNull();

      act(() => {
        unregisterBuiltinView("github.statsDropdown");
      });
      expect(result.current).toBeNull();
    });

    it("keeps the guarded wrapper stable across re-renders that change nothing", async () => {
      const { renderHook } = await import("@testing-library/react");
      registerBuiltinView("github.statsDropdown", StubComponent);
      const { result, rerender } = renderHook(() => useBuiltinView("github.statsDropdown"));
      const first = result.current;

      rerender();
      // A fresh wrapper identity per render would remount the slot subtree
      // every time the host re-rendered.
      expect(result.current).toBe(first);
    });
  });

  describe("useBuiltinPanelView", () => {
    const KIND = "daintree.sveltekit-builder.inspector";
    const OWNER = "daintree.sveltekit-builder";

    afterEach(() => {
      usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
    });

    it("probes an unregistered kind silently, since most kinds are plugin:// views", async () => {
      const { renderHook } = await import("@testing-library/react");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { result } = renderHook(() => useBuiltinPanelView(KIND, OWNER));
      expect(result.current.status).toBe("none");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("ignores a slot owned by a different plugin than the kind's", async () => {
      const { renderHook } = await import("@testing-library/react");
      registerBuiltinView(KIND, StubComponent, { pluginId: "daintree.github" });
      const { result } = renderHook(() => useBuiltinPanelView(KIND, OWNER));
      expect(result.current.status).toBe("none");
    });

    it("returns the registered component unguarded", async () => {
      const { renderHook } = await import("@testing-library/react");
      registerBuiltinView(KIND, StubComponent, { pluginId: OWNER });
      const { result } = renderHook(() => useBuiltinPanelView(KIND, OWNER));
      // The panel content owns the boundary; a slot guard here would swallow
      // the throw before its diagnostics fallback could see it.
      expect(result.current).toEqual({ status: "ready", component: StubComponent });
    });

    it("re-resolves on registration, unregistration, and the owner's enable toggle", async () => {
      const { renderHook, act } = await import("@testing-library/react");
      const { result } = renderHook(() => useBuiltinPanelView(KIND, OWNER));
      expect(result.current.status).toBe("none");

      act(() => registerBuiltinView(KIND, StubComponent, { pluginId: OWNER }));
      expect(result.current).toEqual({ status: "ready", component: StubComponent });

      act(() => {
        usePluginRuntimeStore.setState({ disabledPluginIds: new Set([OWNER]) });
      });
      expect(result.current.status).toBe("disabled");

      act(() => {
        usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
      });
      expect(result.current.status).toBe("ready");

      act(() => {
        unregisterBuiltinView(KIND);
      });
      expect(result.current.status).toBe("none");
    });
  });
});
