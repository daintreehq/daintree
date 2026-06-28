// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";

// `TerminalPane` pulls in xterm and a long dependency tree; the hook only
// needs an identifier to register so we replace it with a sentinel function.
vi.mock("@/components/Terminal/TerminalPane", () => ({
  TerminalPane: function TerminalPaneMock() {
    return null;
  },
}));

// `makePluginViewHost` pulls in ErrorBoundary, Suspense, and Vite ignored
// dynamic imports — none of which the registration hook actually exercises.
// Return a sentinel component identified by the kind id so assertions can
// confirm the right factory was invoked per kind.
vi.mock("@/components/Plugin/PluginViewHost", () => ({
  makePluginViewHost: vi.fn((config: { id: string }) => {
    function PluginViewHostMock() {
      return null;
    }
    PluginViewHostMock.displayName = `PluginViewHostMock(${config.id})`;
    return PluginViewHostMock;
  }),
}));

const { getPanelKindsMock, onPanelKindsChangedMock } = vi.hoisted(() => ({
  getPanelKindsMock: vi.fn(),
  onPanelKindsChangedMock: vi.fn(),
}));

function pluginKind(overrides: Partial<PanelKindConfig> = {}): PanelKindConfig {
  return {
    id: "acme.viewer",
    name: "Viewer",
    iconId: "eye",
    color: "#abcdef",
    hasPty: true,
    canRestart: true,
    canConvert: false,
    extensionId: "acme",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: unknown }).window = Object.assign(globalThis.window ?? {}, {
    electron: {
      plugin: {
        getPanelKinds: getPanelKindsMock,
        onPanelKindsChanged: onPanelKindsChangedMock,
      },
    },
  });
  vi.resetModules();
  getPanelKindsMock.mockResolvedValue([]);
  onPanelKindsChangedMock.mockReturnValue(() => {});
});

describe("usePluginPanelKinds", () => {
  it("registers plugin panel kinds from the mount-time pull", async () => {
    const config = pluginKind();
    getPanelKindsMock.mockResolvedValue([config]);

    const { getPanelKindConfig, clearPanelKindRegistry } =
      await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());

    await waitFor(() => {
      expect(getPanelKindConfig(config.id)).toBeDefined();
    });
    expect(getPanelKindDefinition(config.id)).toBeDefined();

    clearPanelKindRegistry();
  });

  it("removes plugin kinds when the push snapshot omits them", async () => {
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation(
      (cb: (payload: { kinds: PanelKindConfig[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    const { getPanelKindConfig, clearPanelKindRegistry } =
      await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    const a = pluginKind({ id: "acme.a" });
    const b = pluginKind({ id: "acme.b" });

    act(() => emit!({ kinds: [a, b] }));
    expect(getPanelKindConfig(a.id)).toBeDefined();
    expect(getPanelKindConfig(b.id)).toBeDefined();
    expect(getPanelKindDefinition(a.id)).toBeDefined();
    expect(getPanelKindDefinition(b.id)).toBeDefined();

    act(() => emit!({ kinds: [a] }));
    expect(getPanelKindConfig(a.id)).toBeDefined();
    expect(getPanelKindConfig(b.id)).toBeUndefined();
    expect(getPanelKindDefinition(b.id)).toBeUndefined();

    act(() => emit!({ kinds: [] }));
    expect(getPanelKindConfig(a.id)).toBeUndefined();
    expect(getPanelKindDefinition(a.id)).toBeUndefined();

    clearPanelKindRegistry();
  });

  it("does not register a definition for non-PTY plugin kinds without componentPath", async () => {
    const nonPty = pluginKind({ id: "acme.note", hasPty: false });
    getPanelKindsMock.mockResolvedValue([nonPty]);

    const { getPanelKindConfig, clearPanelKindRegistry } =
      await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());

    await waitFor(() => {
      expect(getPanelKindConfig(nonPty.id)).toBeDefined();
    });
    expect(getPanelKindDefinition(nonPty.id)).toBeUndefined();

    clearPanelKindRegistry();
  });

  it("registers a PluginViewHost definition when a non-PTY kind carries componentPath (#9229)", async () => {
    const viewKind = pluginKind({
      id: "acme.dashboard",
      hasPty: false,
      componentPath: "plugin://acme/dashboard.js",
    });
    getPanelKindsMock.mockResolvedValue([viewKind]);

    const { getPanelKindConfig, clearPanelKindRegistry } =
      await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { makePluginViewHost } = await import("@/components/Plugin/PluginViewHost");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());

    await waitFor(() => {
      expect(getPanelKindConfig(viewKind.id)).toBeDefined();
    });
    expect(getPanelKindDefinition(viewKind.id)).toBeDefined();
    expect(makePluginViewHost).toHaveBeenCalledWith(
      expect.objectContaining({ id: viewKind.id, componentPath: viewKind.componentPath })
    );

    clearPanelKindRegistry();
  });

  it("does not re-create the PluginViewHost on identity-equal replay pushes", async () => {
    // Regression guard: each makePluginViewHost call returns a new component
    // ref, which would unmount+remount the plugin view subtree on every
    // broadcast if the hook re-invoked it unconditionally. The hook memoizes
    // hosts per (id + componentPath) so repeated identical snapshots reuse
    // the same component ref.
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation(
      (cb: (payload: { kinds: PanelKindConfig[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    const { clearPanelKindRegistry } = await import("@shared/config/panelKindRegistry");
    const { makePluginViewHost } = await import("@/components/Plugin/PluginViewHost");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    const viewKind = pluginKind({
      id: "acme.steady",
      hasPty: false,
      componentPath: "plugin://acme/v.js",
    });

    act(() => emit!({ kinds: [viewKind] }));
    const callsAfterFirst = (makePluginViewHost as ReturnType<typeof vi.fn>).mock.calls.length;

    // Two more identical pushes — neither should produce a new component.
    act(() => emit!({ kinds: [viewKind] }));
    act(() => emit!({ kinds: [viewKind] }));
    const callsAfterReplay = (makePluginViewHost as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(callsAfterReplay).toBe(callsAfterFirst);

    // A genuine componentPath change invalidates the cache and produces a
    // fresh host.
    const updatedKind = pluginKind({
      id: "acme.steady",
      hasPty: false,
      componentPath: "plugin://acme/v.js?v=2",
    });
    act(() => emit!({ kinds: [updatedKind] }));
    const callsAfterUpdate = (makePluginViewHost as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterUpdate).toBe(callsAfterReplay + 1);

    clearPanelKindRegistry();
  });

  it("clears the view-host definition when a kind loses its componentPath via a push", async () => {
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation(
      (cb: (payload: { kinds: PanelKindConfig[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    const { clearPanelKindRegistry } = await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    const withView = pluginKind({
      id: "acme.toggle",
      hasPty: false,
      componentPath: "plugin://acme/v.js",
    });
    act(() => emit!({ kinds: [withView] }));
    expect(getPanelKindDefinition(withView.id)).toBeDefined();

    // Plugin re-emits the same kind with no view contribution attached
    // (e.g. the `views` entry was removed). Renderer must drop
    // the prior PluginViewHost definition so the panel falls back to
    // PluginMissingPanel rather than rendering a stale lazy import.
    const noView = pluginKind({ id: "acme.toggle", hasPty: false });
    act(() => emit!({ kinds: [noView] }));
    expect(getPanelKindDefinition(noView.id)).toBeUndefined();

    clearPanelKindRegistry();
  });

  it("re-registers a view-host definition after the plugin is removed and re-added (#10512)", async () => {
    // The host cache keys view entries `${id}\0${componentPath}`, but removal
    // used a bare-id delete that never matched — so a removed-then-re-added kind
    // found a stale cache hit and skipped both `makePluginViewHost` and the
    // definition re-registration, leaving the panel on PluginMissingPanel.
    // Proper eviction rebuilds the host and restores the definition.
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation(
      (cb: (payload: { kinds: PanelKindConfig[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    const { clearPanelKindRegistry } = await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { makePluginViewHost } = await import("@/components/Plugin/PluginViewHost");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    const viewKind = pluginKind({
      id: "acme.recycle",
      hasPty: false,
      componentPath: "plugin://acme/v.js",
    });

    act(() => emit!({ kinds: [viewKind] }));
    expect(getPanelKindDefinition(viewKind.id)).toBeDefined();
    const callsAfterFirst = (makePluginViewHost as ReturnType<typeof vi.fn>).mock.calls.length;

    // Remove the whole plugin from the snapshot.
    act(() => emit!({ kinds: [] }));
    expect(getPanelKindDefinition(viewKind.id)).toBeUndefined();

    // Re-add the identical kind: the host must be rebuilt and re-registered.
    act(() => emit!({ kinds: [viewKind] }));
    expect(getPanelKindDefinition(viewKind.id)).toBeDefined();
    expect((makePluginViewHost as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterFirst + 1
    );

    clearPanelKindRegistry();
  });

  it("clears registered plugin kinds on unmount", async () => {
    getPanelKindsMock.mockResolvedValue([pluginKind()]);

    const { getPanelKindConfig, clearPanelKindRegistry } =
      await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    const { unmount } = renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(getPanelKindConfig("acme.viewer")).toBeDefined());

    unmount();

    expect(getPanelKindConfig("acme.viewer")).toBeUndefined();
    expect(getPanelKindDefinition("acme.viewer")).toBeUndefined();

    clearPanelKindRegistry();
  });

  it("clears the existing definition when hasPty flips from true to false", async () => {
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation(
      (cb: (payload: { kinds: PanelKindConfig[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    const { clearPanelKindRegistry } = await import("@shared/config/panelKindRegistry");
    const { getPanelKindDefinition } = await import("@/registry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    const ptyKind = pluginKind({ id: "acme.flippy", hasPty: true });
    act(() => emit!({ kinds: [ptyKind] }));
    expect(getPanelKindDefinition(ptyKind.id)).toBeDefined();

    // Plugin re-registers the same kind with hasPty false. Without the
    // explicit unregister, the renderer would keep the stale TerminalPane
    // definition and `getPanelKindConfig.hasPty` would diverge from the
    // resolved component.
    const noPtyKind = pluginKind({ id: "acme.flippy", hasPty: false });
    act(() => emit!({ kinds: [noPtyKind] }));
    expect(getPanelKindDefinition(noPtyKind.id)).toBeUndefined();

    clearPanelKindRegistry();
  });

  it("ignores a stale mount-time pull when a push has already arrived", async () => {
    let emit: ((payload: { kinds: PanelKindConfig[] }) => void) | null = null;
    onPanelKindsChangedMock.mockImplementation(
      (cb: (payload: { kinds: PanelKindConfig[] }) => void) => {
        emit = cb;
        return () => {};
      }
    );

    let resolveGet: ((value: PanelKindConfig[]) => void) | null = null;
    getPanelKindsMock.mockImplementation(
      () =>
        new Promise<PanelKindConfig[]>((resolve) => {
          resolveGet = resolve;
        })
    );

    const { getPanelKindConfig, clearPanelKindRegistry } =
      await import("@shared/config/panelKindRegistry");
    const { usePluginPanelKinds } = await import("../usePluginPanelKinds");

    renderHook(() => usePluginPanelKinds());
    await waitFor(() => expect(onPanelKindsChangedMock).toHaveBeenCalled());

    const config = pluginKind();
    act(() => emit!({ kinds: [config] }));
    expect(getPanelKindConfig(config.id)).toBeDefined();

    await act(async () => {
      resolveGet!([]);
      await Promise.resolve();
    });

    expect(getPanelKindConfig(config.id)).toBeDefined();

    clearPanelKindRegistry();
  });
});
