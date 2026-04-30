// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/theme/applyAppTheme", () => ({
  applyAppThemeToRoot: vi.fn(),
  applyColorVisionMode: vi.fn(),
}));

import {
  getTerminalAppearanceSnapshot,
  useTerminalAppearance,
} from "@/hooks/useTerminalAppearance";
import { useAppThemeStore } from "@/store/appThemeStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";

const initialFontStore = useTerminalFontStore.getState();
const initialScrollbackStore = useScrollbackStore.getState();
const initialPerfStore = usePerformanceModeStore.getState();
const initialScreenReaderStore = useScreenReaderStore.getState();
const initialAppThemeStore = useAppThemeStore.getState();
const initialColorSchemeStore = useTerminalColorSchemeStore.getState();
const initialProjectSettingsStore = useProjectSettingsStore.getState();

describe("useTerminalAppearance", () => {
  beforeEach(() => {
    useTerminalFontStore.setState(initialFontStore, true);
    useScrollbackStore.setState(initialScrollbackStore, true);
    usePerformanceModeStore.setState(initialPerfStore, true);
    useScreenReaderStore.setState(initialScreenReaderStore, true);
    useAppThemeStore.setState(initialAppThemeStore, true);
    useTerminalColorSchemeStore.setState(initialColorSchemeStore, true);
    useProjectSettingsStore.setState(initialProjectSettingsStore, true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns initial values from every contributing store", () => {
    const { result } = renderHook(() => useTerminalAppearance());

    expect(result.current.fontSize).toBe(useTerminalFontStore.getState().fontSize);
    expect(result.current.fontFamily).toBe(useTerminalFontStore.getState().fontFamily);
    expect(result.current.performanceMode).toBe(false);
    expect(result.current.scrollbackLines).toBe(useScrollbackStore.getState().scrollbackLines);
    expect(result.current.projectScrollback).toBeUndefined();
    expect(result.current.screenReaderMode).toBe(false);
    expect(typeof result.current.wrapperBackground).toBe("string");
    expect(result.current.effectiveTheme).toBeDefined();
  });

  it("rerenders when terminal font size changes", () => {
    const { result } = renderHook(() => useTerminalAppearance());
    const initial = result.current.fontSize;

    act(() => {
      useTerminalFontStore.getState().setFontSize(initial + 4);
    });

    expect(result.current.fontSize).toBe(initial + 4);
  });

  it("rerenders when performance mode toggles", () => {
    const { result } = renderHook(() => useTerminalAppearance());
    expect(result.current.performanceMode).toBe(false);

    act(() => {
      usePerformanceModeStore.getState().setPerformanceMode(true);
    });

    expect(result.current.performanceMode).toBe(true);
  });

  it("rerenders wrapperBackground and effectiveTheme when app theme changes while scheme is DEFAULT_SCHEME_ID", () => {
    const { result } = renderHook(() => useTerminalAppearance());
    const initialBackground = result.current.wrapperBackground;
    const initialTheme = result.current.effectiveTheme;

    act(() => {
      useAppThemeStore.setState({ selectedSchemeId: "bondi" });
    });

    // App theme switch should propagate through selectWrapperBackground / selectEffectiveTheme
    // because the hook subscribes to appThemeStore.selectedSchemeId even though the value is discarded.
    expect(result.current.wrapperBackground).not.toBe(initialBackground);
    expect(result.current.effectiveTheme).not.toBe(initialTheme);
  });

  it("resolves screenReaderMode from screen-reader and OS accessibility state", () => {
    const { result } = renderHook(() => useTerminalAppearance());
    expect(result.current.screenReaderMode).toBe(false);

    act(() => {
      useScreenReaderStore.getState().setScreenReaderMode("on");
    });
    expect(result.current.screenReaderMode).toBe(true);

    act(() => {
      useScreenReaderStore.getState().setScreenReaderMode("off");
    });
    expect(result.current.screenReaderMode).toBe(false);

    act(() => {
      useScreenReaderStore.getState().setScreenReaderMode("auto");
      useScreenReaderStore.getState().setOsAccessibilityEnabled(true);
    });
    expect(result.current.screenReaderMode).toBe(true);

    // Explicit "off" must override OS accessibility
    act(() => {
      useScreenReaderStore.getState().setScreenReaderMode("off");
    });
    expect(result.current.screenReaderMode).toBe(false);
  });

  it("reflects project-level scrollback override when present", () => {
    const { result } = renderHook(() => useTerminalAppearance());
    expect(result.current.projectScrollback).toBeUndefined();

    act(() => {
      useProjectSettingsStore.getState().setSettings({
        runCommands: [],
        terminalSettings: { scrollbackLines: 4242 },
      });
    });

    expect(result.current.projectScrollback).toBe(4242);
  });
});

describe("getTerminalAppearanceSnapshot", () => {
  beforeEach(() => {
    useTerminalFontStore.setState(initialFontStore, true);
    useScrollbackStore.setState(initialScrollbackStore, true);
    usePerformanceModeStore.setState(initialPerfStore, true);
    useScreenReaderStore.setState(initialScreenReaderStore, true);
    useAppThemeStore.setState(initialAppThemeStore, true);
    useTerminalColorSchemeStore.setState(initialColorSchemeStore, true);
    useProjectSettingsStore.setState(initialProjectSettingsStore, true);
  });

  it("returns a current snapshot without requiring React", () => {
    useTerminalFontStore.getState().setFontSize(18);
    useScrollbackStore.getState().setScrollbackLines(7777);
    usePerformanceModeStore.getState().setPerformanceMode(true);

    const snapshot = getTerminalAppearanceSnapshot();

    expect(snapshot.fontSize).toBe(18);
    expect(snapshot.scrollbackLines).toBe(7777);
    expect(snapshot.performanceMode).toBe(true);
    expect(typeof snapshot.wrapperBackground).toBe("string");
    expect(snapshot.effectiveTheme).toBeDefined();
  });

  it("picks up project-level scrollback override", () => {
    useProjectSettingsStore.getState().setSettings({
      runCommands: [],
      terminalSettings: { scrollbackLines: 1234 },
    });

    expect(getTerminalAppearanceSnapshot().projectScrollback).toBe(1234);
  });

  it("reads current state on each call (no stale closure)", () => {
    const first = getTerminalAppearanceSnapshot();
    useTerminalFontStore.getState().setFontSize(first.fontSize + 8);
    const second = getTerminalAppearanceSnapshot();

    expect(second.fontSize).toBe(first.fontSize + 8);
  });
});
