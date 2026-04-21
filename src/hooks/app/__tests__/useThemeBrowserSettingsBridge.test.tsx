// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSettingsStore, useThemeBrowserStore } from "@/store";
import { useThemeBrowserSettingsBridge } from "../useThemeBrowserSettingsBridge";

function Harness({
  isSettingsOpen,
  setIsSettingsOpen,
}: {
  isSettingsOpen: boolean;
  setIsSettingsOpen: (open: boolean) => void;
}) {
  useThemeBrowserSettingsBridge(isSettingsOpen, setIsSettingsOpen);
  return null;
}

describe("useThemeBrowserSettingsBridge", () => {
  beforeEach(() => {
    useThemeBrowserStore.setState({ isOpen: false });
    useSettingsStore.setState({ activeTab: null, activeSubtab: null, activeSectionId: null });
  });

  afterEach(() => {
    cleanup();
    useThemeBrowserStore.setState({ isOpen: false });
    useSettingsStore.setState({ activeTab: null, activeSubtab: null, activeSectionId: null });
  });

  it("closes Settings when the theme browser opens", () => {
    const setIsSettingsOpen = vi.fn();
    render(<Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />);

    act(() => {
      useThemeBrowserStore.getState().open();
    });

    expect(setIsSettingsOpen).toHaveBeenCalledWith(false);
  });

  it("reopens Settings on close IF the browser was opened while Settings was open", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    // Simulate being on general tab in Settings
    useSettingsStore.setState({ activeTab: "general", activeSubtab: null, activeSectionId: null });

    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();

    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);

    act(() => {
      useThemeBrowserStore.getState().close();
    });

    const settingsEvents = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:open-settings-tab"
      );
    expect(settingsEvents).toHaveLength(1);
    const detail = settingsEvents[0]!.detail as { tab?: string; sectionId?: string };
    expect(detail.tab).toBe("general");
    expect(detail.sectionId).toBe("appearance-theme");

    dispatchSpy.mockRestore();
  });

  it("restores to terminalAppearance tab when browser was opened from that tab", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    // Simulate being on terminalAppearance tab in Settings
    useSettingsStore.setState({
      activeTab: "terminalAppearance",
      activeSubtab: null,
      activeSectionId: null,
    });

    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();

    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);

    act(() => {
      useThemeBrowserStore.getState().close();
    });

    const settingsEvents = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:open-settings-tab"
      );
    expect(settingsEvents).toHaveLength(1);
    const detail = settingsEvents[0]!.detail as { tab?: string; sectionId?: string };
    expect(detail.tab).toBe("terminalAppearance");
    expect(detail.sectionId).toBe("appearance-theme");

    dispatchSpy.mockRestore();
  });

  it("does NOT reopen Settings on close if the browser was opened with Settings closed", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    render(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);

    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();

    act(() => {
      useThemeBrowserStore.getState().close();
    });

    const settingsEvents = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] instanceof CustomEvent && (c[0] as CustomEvent).type === "daintree:open-settings-tab"
    );
    expect(settingsEvents).toHaveLength(0);

    dispatchSpy.mockRestore();
  });

  it("ignores isSettingsOpen changes that happen while the browser is open", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();

    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);
    rerender(<Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />);

    const settingsEvents = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] instanceof CustomEvent && (c[0] as CustomEvent).type === "daintree:open-settings-tab"
    );
    expect(settingsEvents).toHaveLength(0);

    dispatchSpy.mockRestore();
  });

  it("restores to the most recent tab when opened from different tabs in sequence", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    // First open from general tab.
    useSettingsStore.setState({ activeTab: "general", activeSubtab: null, activeSectionId: null });
    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();
    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);
    act(() => {
      useThemeBrowserStore.getState().close();
    });
    let settingsEvents = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:open-settings-tab"
      );
    expect(settingsEvents).toHaveLength(1);
    expect((settingsEvents[0]!.detail as { tab?: string }).tab).toBe("general");

    // Reset and open again from terminalAppearance tab.
    dispatchSpy.mockClear();
    rerender(<Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />);
    useSettingsStore.setState({
      activeTab: "terminalAppearance",
      activeSubtab: null,
      activeSectionId: null,
    });
    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();
    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);
    act(() => {
      useThemeBrowserStore.getState().close();
    });
    settingsEvents = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:open-settings-tab"
      );
    expect(settingsEvents).toHaveLength(1);
    const detail = settingsEvents[0]!.detail as { tab?: string; sectionId?: string };
    expect(detail.tab).toBe("terminalAppearance");
    expect(detail.sectionId).toBe("appearance-theme");

    dispatchSpy.mockRestore();
  });

  it("preserves subtab when present", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    useSettingsStore.setState({
      activeTab: "terminal",
      activeSubtab: "app",
      activeSectionId: null,
    });

    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();
    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);
    act(() => {
      useThemeBrowserStore.getState().close();
    });

    const settingsEvents = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:open-settings-tab"
      );
    expect(settingsEvents).toHaveLength(1);
    const detail = settingsEvents[0]!.detail as {
      tab?: string;
      subtab?: string;
      sectionId?: string;
    };
    expect(detail.tab).toBe("terminal");
    expect(detail.subtab).toBe("app");
    expect(detail.sectionId).toBe("appearance-theme");

    dispatchSpy.mockRestore();
  });

  it("falls back to general when activeTab is null", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    // Settings is open but no active tab set (e.g., just opened via menu, not yet rendered)
    useSettingsStore.setState({ activeTab: null, activeSubtab: null, activeSectionId: null });

    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();
    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);
    act(() => {
      useThemeBrowserStore.getState().close();
    });

    const settingsEvents = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (e): e is CustomEvent => e instanceof CustomEvent && e.type === "daintree:open-settings-tab"
      );
    expect(settingsEvents).toHaveLength(1);
    const detail = settingsEvents[0]!.detail as { tab?: string };
    expect(detail.tab).toBe("general");

    dispatchSpy.mockRestore();
  });
});
