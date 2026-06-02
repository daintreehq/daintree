// @vitest-environment jsdom
// Issue #8942 — the shortcut-hint live region was carried on the visual tooltip
// portal, which unmounts when no hint is active. Re-creating an aria-live node
// makes Chromium treat its mount-time text as pre-existing static content and
// never announces it. The fix keeps a dedicated sr-only status node always
// mounted (decoupled from the visual tooltip) so only its text changes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { ShortcutHint } from "../ShortcutHint";
import { shortcutHintStore } from "@/store/shortcutHintStore";

// Make presence deterministic: render + visibility track isOpen directly so we
// don't depend on animation timers. shouldRender drives the visual tooltip only.
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

// The component resolves the action's title from the ActionService registry to
// label the hint. Mock that lookup so we can drive titled vs. untitled behaviour
// without registering real actions.
const getTitleMock = vi.hoisted(() => vi.fn<(id: string) => string>(() => ""));
vi.mock("@/services/ActionService", () => ({
  actionService: { getTitle: getTitleMock },
}));

function activate(combo: string) {
  act(() => {
    shortcutHintStore.setState({
      activeHint: { actionId: "test.action", displayCombo: combo, x: 100, y: 100 },
    });
  });
}

function deactivate() {
  act(() => {
    shortcutHintStore.setState({ activeHint: null });
  });
}

const liveRegion = () => document.querySelector('[role="status"]');

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

    activate("⌘K");
    expect(liveRegion()).toBe(initial);
    expect(initial?.textContent).toContain("⌘K");

    deactivate();
    expect(liveRegion()).toBe(initial);
    expect(initial?.textContent).toBe("");

    activate("⌘P");
    expect(liveRegion()).toBe(initial);
    expect(initial?.textContent).toContain("⌘P");
  });

  it("renders the visual tooltip only while a hint is active", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    const tooltip = () => document.querySelector('[aria-hidden="true"]');
    expect(tooltip()).toBeNull();

    activate("⌘K");
    expect(tooltip()).not.toBeNull();

    deactivate();
    expect(tooltip()).toBeNull();
  });

  it("labels the visual tooltip with the resolved action title", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    activate("⌘K");
    const tooltip = document.querySelector('[aria-hidden="true"]');
    expect(tooltip?.textContent).toContain("Open command palette");
    expect(tooltip?.textContent).toContain("⌘K");
    expect(tooltip?.textContent).not.toContain("Tip:");
  });

  it("falls back to 'Tip:' when the action has no resolvable title", () => {
    getTitleMock.mockReturnValue("");
    render(<ShortcutHint />);
    activate("⌘K");
    const tooltip = document.querySelector('[aria-hidden="true"]');
    expect(tooltip?.textContent).toContain("Tip:");
    expect(tooltip?.textContent).toContain("⌘K");
  });

  it("falls back to 'Tip:' when the title is only whitespace", () => {
    getTitleMock.mockReturnValue("   ");
    render(<ShortcutHint />);
    activate("⌘K");
    const tooltip = document.querySelector('[aria-hidden="true"]');
    expect(tooltip?.textContent).toContain("Tip:");
    expect(liveRegion()?.textContent).toBe("Shortcut: ⌘K");
  });

  it("marks the visual tooltip aria-hidden so it doesn't double-announce", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    activate("⌘K");
    const tooltip = document.querySelector('[aria-hidden="true"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the action title and combo in the live region", () => {
    getTitleMock.mockReturnValue("Open command palette");
    render(<ShortcutHint />);
    activate("⌘K");
    expect(liveRegion()?.textContent).toBe("Open command palette: ⌘K");
  });

  it("announces a generic shortcut label when no title resolves", () => {
    getTitleMock.mockReturnValue("");
    render(<ShortcutHint />);
    activate("⌘K");
    expect(liveRegion()?.textContent).toBe("Shortcut: ⌘K");
  });
});
