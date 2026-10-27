// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { RecentDictation } from "@shared/types";

// jsdom ships neither, and the palette body's scroll-shadow hook and the
// dialog's motion query both reach for them on mount.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
}

const recovery = vi.hoisted(() => ({
  insertRecentDictation: vi.fn<(d: RecentDictation, version?: string) => string | null>(),
  copyRecentDictation: vi.fn<(d: RecentDictation, version?: string) => void>(),
  focusRecoveredComposer: vi.fn<(panelId: string) => void>(),
}));
vi.mock("@/services/recentDictationRecovery", () => recovery);

// Copy is Cmd+Enter on macOS and Ctrl+Enter elsewhere; each test picks one.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
}));

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("matchMedia", matchMediaStub);
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
});

afterAll(() => {
  vi.unstubAllGlobals();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const { RecentDictationsPalette } = await import("@/components/Terminal/RecentDictationsPalette");
const { UI_PALETTE_EXIT_DURATION } = await import("@/lib/animationUtils");

// Comfortably past the palette's exit, when it would restore focus.
const PAST_PALETTE_EXIT_MS = UI_PALETTE_EXIT_DURATION * 4;
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { usePaletteStore } = await import("@/store/paletteStore");
const { useRecentDictationsStore } = await import("@/store/recentDictationsStore");

const NEWER: RecentDictation = {
  id: "s2",
  rawText: "basically ship the lexr fix",
  correctedText: "Ship the lexer fix.",
  target: { panelId: "p2", panelTitle: "Codex", projectName: "daintree", worktreeLabel: "main" },
  endedAt: Date.now() - 60_000,
};
const OLDER: RecentDictation = {
  id: "s1",
  rawText: "first paragraph\nsecond paragraph",
  correctedText: null,
  target: { panelId: "p1", panelTitle: "Claude" },
  endedAt: Date.now() - 600_000,
};

function renderPalette() {
  render(
    <TooltipProvider>
      <RecentDictationsPalette />
    </TooltipProvider>
  );
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  expect(input).toBeTruthy();
  return input;
}

const options = () =>
  [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent ?? "");
const isOpen = () => usePaletteStore.getState().activePaletteId === "recent-dictations";

async function press(input: HTMLInputElement, init: KeyboardEventInit) {
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter", ...init });
  });
}

describe("RecentDictationsPalette", () => {
  beforeEach(() => {
    recovery.insertRecentDictation.mockReset().mockReturnValue("p9");
    recovery.copyRecentDictation.mockReset();
    recovery.focusRecoveredComposer.mockReset();
    platform.mac = true;
    useRecentDictationsStore.getState().setDictations([NEWER, OLDER]);
    usePaletteStore.getState().openPalette("recent-dictations");
  });

  afterEach(() => {
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("lists the session's dictations newest first, cleaned text and where it went", () => {
    renderPalette();

    const rows = options();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Ship the lexer fix.");
    expect(rows[0]).toContain("Codex · daintree / main");
    // A paragraph break reads as a space on the one-line excerpt.
    expect(rows[1]).toContain("first paragraph second paragraph");
  });

  it("adds the selection to the focused draft and hands that composer the keyboard", async () => {
    const input = renderPalette();
    await press(input, {});

    expect(recovery.insertRecentDictation).toHaveBeenCalledWith(NEWER, "cleaned");
    expect(recovery.focusRecoveredComposer).toHaveBeenCalledWith("p9");
    expect(isOpen()).toBe(false);
  });

  it("leaves the keyboard in the composer through the palette's exit", async () => {
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
    const opener = document.createElement("button");
    const composer = document.createElement("textarea");
    document.body.append(opener, composer);
    recovery.focusRecoveredComposer.mockImplementation(() => composer.focus());
    opener.focus();
    usePaletteStore.getState().openPalette("recent-dictations");
    const input = renderPalette();

    await press(input, {});
    // Past the exit animation, when a palette hands focus back to its opener.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, PAST_PALETTE_EXIT_MS));
    });
    expect(document.activeElement).toBe(composer);
    opener.remove();
    composer.remove();
  });

  it("closes without moving focus when the add is refused", async () => {
    recovery.insertRecentDictation.mockReturnValue(null);
    const input = renderPalette();
    await press(input, {});

    expect(recovery.focusRecoveredComposer).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it.each([
    { mac: true, copy: { metaKey: true }, notCopy: { ctrlKey: true } },
    { mac: false, copy: { ctrlKey: true }, notCopy: { metaKey: true } },
  ])("copies with the platform's modifier (mac: $mac)", async ({ mac, copy, notCopy }) => {
    platform.mac = mac;
    const input = renderPalette();
    await press(input, notCopy);
    expect(recovery.insertRecentDictation).toHaveBeenCalledTimes(1);
    expect(recovery.copyRecentDictation).not.toHaveBeenCalled();

    cleanup();
    usePaletteStore.getState().openPalette("recent-dictations");
    await press(renderPalette(), copy);
    expect(recovery.copyRecentDictation).toHaveBeenCalledWith(NEWER, "cleaned");
    expect(recovery.insertRecentDictation).toHaveBeenCalledTimes(1);
  });

  it("uses the original with Alt, to add or to copy", async () => {
    await press(renderPalette(), { altKey: true });
    expect(recovery.insertRecentDictation).toHaveBeenCalledWith(NEWER, "original");

    cleanup();
    usePaletteStore.getState().openPalette("recent-dictations");
    await press(renderPalette(), { altKey: true, metaKey: true });
    expect(recovery.copyRecentDictation).toHaveBeenCalledWith(NEWER, "original");
  });

  it("finds a dictation by a word only its original has", async () => {
    const input = renderPalette();
    await act(async () => {
      // The cleanup dropped the filler word, so only the original holds it.
      fireEvent.change(input, { target: { value: "basically" } });
    });

    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("Ship the lexer fix.");
  });
});
