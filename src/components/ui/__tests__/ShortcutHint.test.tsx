// @vitest-environment jsdom
// Issue #8942 — the shortcut-hint live region was carried on the visual tooltip
// portal, which unmounts when no hint is active. Re-creating an aria-live node
// makes Chromium treat its mount-time text as pre-existing static content and
// never announces it. The fix keeps a dedicated sr-only status node always
// mounted (decoupled from the visual tooltip) so only its text changes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { ShortcutHint } from "../ShortcutHint";
import { shortcutHintStore, type ShortcutHintOrigin } from "@/store/shortcutHintStore";

// Make presence deterministic: render + visibility track isOpen directly so we
// don't depend on animation timers. shouldRender drives the visual tooltip only.
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

// Pin the platform: chip grammar and spoken key names both depend on it.
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

// The component resolves the action's title from the ActionService registry to
// label the hint. Mock that lookup so we can drive titled vs. untitled behaviour
// without registering real actions.
const getTitleMock = vi.hoisted(() => vi.fn<(id: string) => string>(() => ""));
vi.mock("@/services/ActionService", () => ({
  actionService: { getTitle: getTitleMock },
}));

function activate(
  combo: string,
  origin: ShortcutHintOrigin = "focus",
  extra: Partial<{
    x: number;
    y: number;
    trigger: { left: number; top: number; right: number; bottom: number };
  }> = {}
) {
  act(() => {
    shortcutHintStore.setState({
      activeHint: { actionId: "test.action", combo, origin, x: 100, y: 100, ...extra },
    });
  });
}

function deactivate() {
  act(() => {
    shortcutHintStore.setState({ activeHint: null });
  });
}

const liveRegion = () => document.querySelector('[role="status"]');
const card = () => document.querySelector<HTMLElement>("[data-shortcut-hint-surface]");
const keys = () => Array.from(card()?.querySelectorAll("kbd") ?? []).map((k) => k.textContent);

describe("ShortcutHint live region — issue #8942", () => {
  beforeEach(() => {
    shortcutHintStore.setState({ activeHint: null });
    getTitleMock.mockReset();
    getTitleMock.mockReturnValue("");
  });

  afterEach(() => {
    cleanup();
    shortcutHintStore.setState({ activeHint: null });
  });

  it("mounts the aria-live status node even when no hint is active", () => {
    render(<ShortcutHint />);
    const region = liveRegion();
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.textContent).toBe("");
  });

  it("keeps the same status DOM node across activate → deactivate → reactivate", () => {
    render(<ShortcutHint />);
    const initial = liveRegion();
    expect(initial).not.toBeNull();

    activate("Cmd+K");
    expect(liveRegion()).toBe(initial);
    expect(initial?.textContent).toContain("Command K");

    deactivate();
    expect(liveRegion()).toBe(initial);
    expect(initial?.textContent).toBe("");

    activate("Cmd+P");
    expect(liveRegion()).toBe(initial);
    expect(initial?.textContent).toContain("Command P");
  });

  it("renders the visual tooltip only while a hint is active", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    expect(card()).toBeNull();

    activate("Cmd+K");
    expect(card()).not.toBeNull();

    deactivate();
    expect(card()).toBeNull();
  });

  it("labels the visual tooltip with the resolved action title", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    activate("Cmd+K");
    expect(card()?.textContent).toContain("Open command palette");
  });

  it.each(["", "   "])("shows the keys alone when the title is %j", (title) => {
    getTitleMock.mockReturnValue(title);
    render(<ShortcutHint />);
    activate("Cmd+K");
    // Nothing but the chord: no filler label standing in for a missing title.
    expect(card()?.children).toHaveLength(1);
    expect(keys()).toEqual(["⌘", "K"]);
    expect(liveRegion()?.textContent).toBe("Shortcut: Command K");
  });

  it("marks the visual tooltip aria-hidden so it doesn't double-announce", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    activate("Cmd+K");
    expect(card()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the action title and the keys by name", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    activate("Cmd+Shift+P");
    expect(liveRegion()?.textContent).toBe("Open command palette: Command Shift P");
  });

  it("never speaks a modifier glyph", () => {
    render(<ShortcutHint />);
    for (const combo of ["Cmd+Shift+P", "Ctrl+Alt+L", "Cmd+K Cmd+S", "Shift+Enter"]) {
      activate(combo);
      expect(liveRegion()?.textContent).not.toMatch(/[⌘⇧⌥⌃⏎]/);
    }
  });
});

describe("ShortcutHint keycaps", () => {
  afterEach(() => {
    cleanup();
    shortcutHintStore.setState({ activeHint: null });
  });

  it("gives every key its own chip, with no joiner inside a chip", () => {
    render(<ShortcutHint />);
    for (const [combo, count] of [
      ["Cmd+B", 2],
      ["Cmd+Shift+P", 3],
      ["Cmd+K Cmd+S", 4],
      ["Cmd+Alt+Shift+R", 4],
    ] as const) {
      activate(combo);
      const chips = keys();
      expect(chips).toHaveLength(count);
      for (const chip of chips) expect(chip).not.toMatch(/[+\s]/);
    }
  });
});

describe("ShortcutHint lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getTitleMock.mockReturnValue("Open command palette");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    shortcutHintStore.setState({ activeHint: null });
  });

  it("expires a hint that followed a click", () => {
    render(<ShortcutHint />);
    activate("Cmd+K", "dispatch");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it.each(["hover", "focus"] as const)("keeps a %s hint up until the user moves on", (origin) => {
    render(<ShortcutHint />);
    activate("Cmd+K", origin, { trigger: { left: 90, top: 90, right: 130, bottom: 110 } });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shortcutHintStore.getState().activeHint).not.toBeNull();
  });

  it.each(["dispatch", "hover", "focus"] as const)("dismisses a %s hint on Escape", (origin) => {
    render(<ShortcutHint />);
    activate("Cmd+K", origin);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("keeps a hover hint while the pointer stays on its trigger, and drops it once it leaves", () => {
    render(<ShortcutHint />);
    activate("Cmd+K", "hover", { trigger: { left: 90, top: 90, right: 130, bottom: 110 } });
    const move = (clientX: number, clientY: number) =>
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX, clientY }));
      });

    move(110, 100);
    expect(shortcutHintStore.getState().activeHint).not.toBeNull();

    move(400, 400);
    expect(shortcutHintStore.getState().activeHint).toBeNull();
  });

  it("keeps a hover hint along the whole path from its trigger onto the card", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(30);
    render(<ShortcutHint />);
    const trigger = { left: 300, top: 300, right: 332, bottom: 332 };
    activate("Cmd+K", "hover", { x: 310, y: 325, trigger });
    const box = card()!.getBoundingClientRect();
    // jsdom lays nothing out, so read the placement back from the style.
    const cardTop = parseFloat(card()!.style.top);
    const cardBottom = cardTop + 30;
    vi.spyOn(card()!, "getBoundingClientRect").mockReturnValue({
      ...box,
      left: parseFloat(card()!.style.left),
      right: parseFloat(card()!.style.left) + 200,
      top: cardTop,
      bottom: cardBottom,
    });
    expect(cardBottom).toBeLessThan(trigger.top);

    for (let y = trigger.top + 10; y >= cardTop + 5; y -= 1) {
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 316, clientY: y }));
      });
      expect(shortcutHintStore.getState().activeHint, `dropped at y=${y}`).not.toBeNull();
    }
    vi.restoreAllMocks();
  });
});

describe("ShortcutHint placement", () => {
  const CARD = { width: 300, height: 30 };

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.hasAttribute("data-shortcut-hint-surface") ? CARD.width : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.hasAttribute("data-shortcut-hint-surface") ? CARD.height : 0;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    shortcutHintStore.setState({ activeHint: null });
  });

  it.each([
    { name: "right edge", x: window.innerWidth - 4, y: 300 },
    { name: "left edge", x: 0, y: 300 },
    { name: "top edge", x: 200, y: 2 },
    { name: "bottom-right corner", x: window.innerWidth - 1, y: window.innerHeight - 1 },
  ])("keeps the measured card inside the viewport gutter at the $name", ({ x, y }) => {
    render(<ShortcutHint />);
    activate("Cmd+Shift+P", "dispatch", { x, y });
    const left = parseFloat(card()!.style.left);
    const top = parseFloat(card()!.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + CARD.width).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(top + CARD.height).toBeLessThanOrEqual(window.innerHeight - 8);
  });

  it("never covers the trigger that raised it", () => {
    render(<ShortcutHint />);
    for (const trigger of [
      { left: 200, top: 300, right: 232, bottom: 332 },
      { left: 200, top: 2, right: 232, bottom: 34 },
    ]) {
      // Pointer entered near the bottom of the button.
      activate("Cmd+Shift+P", "hover", { x: 210, y: trigger.bottom - 2, trigger });
      const top = parseFloat(card()!.style.top);
      const overlaps = top < trigger.bottom && top + CARD.height > trigger.top;
      expect(overlaps).toBe(false);
    }
  });

  it("re-clamps an open hint when the window narrows", () => {
    render(<ShortcutHint />);
    activate("Cmd+Shift+P", "focus", { x: window.innerWidth - 40, y: 300 });
    const original = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(parseFloat(card()!.style.left) + CARD.width).toBeLessThanOrEqual(500 - 8);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
    }
  });

  it("never covers the pointer it was raised at", () => {
    render(<ShortcutHint />);
    for (const [x, y] of [
      [200, 300],
      [200, 2],
    ] as const) {
      activate("Cmd+Shift+P", "dispatch", { x, y });
      const left = parseFloat(card()!.style.left);
      const top = parseFloat(card()!.style.top);
      const inside = x >= left && x <= left + CARD.width && y >= top && y <= top + CARD.height;
      expect(inside).toBe(false);
    }
  });
});
