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

  it("does not register a definition for non-PTY plugin kinds", async () => {
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
