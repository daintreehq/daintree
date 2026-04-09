// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { DEFAULT_SCHEME_ID } from "@/config/terminalColorSchemes";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useAppThemeStore } from "@/store/appThemeStore";

vi.mock("@/clients/terminalConfigClient", () => ({
  terminalConfigClient: {
    setColorScheme: vi.fn().mockResolvedValue(undefined),
    setRecentSchemeIds: vi.fn().mockResolvedValue(undefined),
    setCustomSchemes: vi.fn().mockResolvedValue(undefined),
    importColorScheme: vi.fn().mockResolvedValue({ ok: false }),
  },
}));

import { ColorSchemePicker } from "../ColorSchemePicker";

let pendingRaf: Array<{ handle: number; cb: FrameRequestCallback }> = [];
let nextHandle = 0;
const flushRaf = () => {
  act(() => {
    const pending = pendingRaf;
    pendingRaf = [];
    for (const entry of pending) entry.cb(0);
  });
};

describe("ColorSchemePicker hover preview", () => {
  beforeEach(() => {
    pendingRaf = [];
    nextHandle = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      nextHandle += 1;
      pendingRaf.push({ handle: nextHandle, cb });
      return nextHandle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      pendingRaf = pendingRaf.filter((entry) => entry.handle !== handle);
    });

    useTerminalColorSchemeStore.setState({
      selectedSchemeId: DEFAULT_SCHEME_ID,
      customSchemes: [],
      recentSchemeIds: [],
      previewSchemeId: null,
    });
    useAppThemeStore.setState({ selectedSchemeId: "daintree" });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useTerminalColorSchemeStore.setState({ previewSchemeId: null });
  });

  it("sets previewSchemeId in the store on pointer enter", () => {
    render(<ColorSchemePicker />);

    const draculaCard = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;
    fireEvent.pointerEnter(draculaCard);

    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");
  });

  it("clears previewSchemeId on pointer leave after rAF flush", () => {
    render(<ColorSchemePicker />);

    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);

    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");
    flushRaf();
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("clears previewSchemeId when the picker unmounts mid-preview", () => {
    const { unmount } = render(<ColorSchemePicker />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;
    fireEvent.pointerEnter(card);
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");

    unmount();
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("keyboard focus mirrors pointer preview behavior", () => {
    render(<ColorSchemePicker />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;

    fireEvent.focus(card);
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");

    fireEvent.blur(card);
    flushRaf();
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("commit via click clears the preview override", () => {
    render(<ColorSchemePicker />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;

    fireEvent.pointerEnter(card);
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBe("dracula");

    fireEvent.click(card);
    expect(useTerminalColorSchemeStore.getState().selectedSchemeId).toBe("dracula");
    expect(useTerminalColorSchemeStore.getState().previewSchemeId).toBeNull();
  });

  it("announces the currently previewed scheme via aria-live", () => {
    const { container } = render(<ColorSchemePicker />);
    const card = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.toLowerCase().includes("dracula"))!;

    fireEvent.pointerEnter(card);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/Previewing:/);

    fireEvent.pointerLeave(card);
    flushRaf();
    expect(live?.textContent).toBe("");
  });
});
