// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useThemeBrowserStore } from "@/store";
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
  });

  afterEach(() => {
    cleanup();
    useThemeBrowserStore.setState({ isOpen: false });
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

    // Start with Settings open — rendering triggers no transition (initial mount).
    const { rerender } = render(
      <Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />
    );

    // Open browser — ref captures `true` for isSettingsOpen.
    act(() => {
      useThemeBrowserStore.getState().open();
    });
    dispatchSpy.mockClear();

    // Settings has now been closed by the bridge; rerender to reflect that.
    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);

    // Close browser.
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

  it("does NOT reopen Settings on close if the browser was opened with Settings closed", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const setIsSettingsOpen = vi.fn();

    // Settings starts closed (e.g., opened via command palette).
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

    // Settings state flips to false (bridge closed it), then some unrelated
    // effect flips it back. Those prop changes should NOT produce spurious
    // close-side dispatches — the ref captured the moment-of-open value.
    rerender(<Harness isSettingsOpen={false} setIsSettingsOpen={setIsSettingsOpen} />);
    rerender(<Harness isSettingsOpen={true} setIsSettingsOpen={setIsSettingsOpen} />);

    const settingsEvents = dispatchSpy.mock.calls.filter(
      (c) =>
        c[0] instanceof CustomEvent && (c[0] as CustomEvent).type === "daintree:open-settings-tab"
    );
    expect(settingsEvents).toHaveLength(0);

    dispatchSpy.mockRestore();
  });
});
