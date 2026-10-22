// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppColorScheme } from "@shared/theme";

const { getThemesMock, onThemesChangedMock, getConfigMock } = vi.hoisted(() => ({
  getThemesMock: vi.fn(),
  onThemesChangedMock: vi.fn(),
  getConfigMock: vi.fn(),
}));

vi.mock("@/clients/appThemeClient", () => ({ appThemeClient: { get: getConfigMock } }));

import { BUILT_IN_APP_SCHEMES } from "@/config/appColorSchemes";
import { flushPendingTheme, useAppThemeStore } from "@/store/appThemeStore";
import { usePluginThemes } from "../usePluginThemes";

const daintree = BUILT_IN_APP_SCHEMES.find((s) => s.id === "daintree")!;
const MIDNIGHT_ID = "plugin:acme.themes:midnight";
const midnight: AppColorScheme = {
  ...daintree,
  id: MIDNIGHT_ID,
  name: "Midnight",
  builtin: false,
  plugin: { id: "acme.themes", name: "Acme Themes" },
};

type Push = (payload: { themes: AppColorScheme[]; fallbackSchemeId?: string }) => void;
let push: Push | null;

beforeEach(() => {
  push = null;
  getThemesMock.mockReset().mockResolvedValue([]);
  getConfigMock.mockReset();
  onThemesChangedMock.mockReset().mockImplementation((cb: Push) => {
    push = cb;
    return () => {};
  });
  Reflect.set(window, "electron", {
    plugin: { getThemes: getThemesMock, onThemesChanged: onThemesChangedMock },
  });
  useAppThemeStore.setState({
    selectedSchemeId: "daintree",
    customSchemes: [],
    pluginSchemes: [],
    pluginSnapshotScheme: null,
    previewSchemeId: null,
    recentSchemeIds: [],
  });
});

afterEach(() => {
  cleanup();
  flushPendingTheme();
});

describe("usePluginThemes (#13832)", () => {
  it("mirrors the pulled catalog into the store", async () => {
    getThemesMock.mockResolvedValue([midnight]);
    renderHook(() => usePluginThemes());

    await waitFor(() => expect(useAppThemeStore.getState().pluginSchemes).toEqual([midnight]));
  });

  it("drops a pull that lands after a push", async () => {
    let resolvePull: (themes: AppColorScheme[]) => void = () => {};
    getThemesMock.mockReturnValue(new Promise((resolve) => (resolvePull = resolve)));
    renderHook(() => usePluginThemes());

    act(() => push!({ themes: [midnight] }));
    await act(async () => resolvePull([]));

    expect(useAppThemeStore.getState().pluginSchemes).toEqual([midnight]);
  });

  it("moves off a selected plugin theme when main reports a fallback", async () => {
    useAppThemeStore.setState({
      selectedSchemeId: MIDNIGHT_ID,
      pluginSnapshotScheme: midnight,
      recentSchemeIds: [MIDNIGHT_ID],
    });
    renderHook(() => usePluginThemes());

    act(() => push!({ themes: [], fallbackSchemeId: "bondi" }));

    const state = useAppThemeStore.getState();
    expect(state.selectedSchemeId).toBe("bondi");
    expect(state.pluginSnapshotScheme).toBeNull();
    expect(state.recentSchemeIds).toEqual([]);
  });

  it("ignores a fallback for a selection the view already moved off", () => {
    useAppThemeStore.setState({ selectedSchemeId: "svalbard" });
    renderHook(() => usePluginThemes());

    act(() => push!({ themes: [], fallbackSchemeId: "bondi" }));

    expect(useAppThemeStore.getState().selectedSchemeId).toBe("svalbard");
  });

  it("reads the persisted selection back when it subscribed after main's fallback", async () => {
    useAppThemeStore.setState({ selectedSchemeId: MIDNIGHT_ID, pluginSnapshotScheme: midnight });
    getConfigMock.mockResolvedValue({ colorSchemeId: "bondi" });
    renderHook(() => usePluginThemes());

    await waitFor(() => expect(useAppThemeStore.getState().selectedSchemeId).toBe("bondi"));
    expect(useAppThemeStore.getState().pluginSnapshotScheme).toBeNull();
  });

  it("keeps a selected plugin theme the catalog still offers", async () => {
    useAppThemeStore.setState({ selectedSchemeId: MIDNIGHT_ID, pluginSnapshotScheme: midnight });
    getThemesMock.mockResolvedValue([midnight]);
    renderHook(() => usePluginThemes());

    await waitFor(() => expect(useAppThemeStore.getState().pluginSchemes).toEqual([midnight]));
    expect(getConfigMock).not.toHaveBeenCalled();
    expect(useAppThemeStore.getState().selectedSchemeId).toBe(MIDNIGHT_ID);
  });
});
