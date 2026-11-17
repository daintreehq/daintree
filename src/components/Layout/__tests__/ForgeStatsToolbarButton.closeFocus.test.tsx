// @vitest-environment jsdom
/**
 * Where focus goes when a forge stats dropdown closes (#17203). The pill takes
 * focus back only when the close would otherwise strand it: Escape, or a press
 * on something that can't take focus (ringless, since a pointer did it). A
 * terminal, a control, or a modal that claimed focus on the way keeps it.
 *
 * jsdom runs no mousedown default action, so each test plays the browser's part
 * itself: a plain control is focused after the press, a non-focusable press
 * blurs to `document.body`, and xterm focuses its textarea from its own
 * mousedown listener, before the document's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ForgeStatsDropdownProps } from "../forgeStatsDropdownContract";
import { _resetForTests as resetForgeCache } from "@/lib/forgeResourceCache";
import { _resetForTests as resetEscapeStack } from "@/lib/escapeStack";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import { useUIStore } from "@/store/uiStore";

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    listIssues: vi.fn(),
    listPRs: vi.fn(),
    getRateLimitDetails: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/hooks/useRepositoryStats", () => ({
  useRepositoryStats: () => ({
    stats: { issueCount: 3, prCount: 2, commitCount: 5 },
    loading: false,
    error: null,
    isTokenError: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    isStale: false,
    lastUpdated: Date.now(),
    rateLimitResetAt: null,
    rateLimitKind: null,
    freshnessLevel: "fresh" as const,
  }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => {
  const entry = {
    pluginId: "daintree.github",
    contribution: {
      id: "github",
      name: "GitHub",
      matches: ["github.com"],
      slots: { statsDropdown: "github.statsDropdown" },
    },
  };
  return {
    useResolvedForgeProvider: () => ({
      entry,
      providerId: "daintree.github.github",
      resolvedVia: "hostname",
      issues: { entry, providerId: "daintree.github.github", resolvedVia: "code" },
      loading: false,
      refresh: () => {},
    }),
  };
});

// A focusable field inside each panel, standing in for the list's search box.
function FieldView({ kind }: ForgeStatsDropdownProps) {
  return <input aria-label={`${kind} search`} data-testid={`view-${kind}`} />;
}
vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (slotId: string) => (slotId === "github.statsDropdown" ? FieldView : null),
  preloadBuiltinView: () => {},
}));

vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteTicker: () => 0,
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (sel: (s: { activeWorktreeId: string | null }) => unknown) =>
    sel({ activeWorktreeId: null }),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees: new Map() }),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// The exit animation outlasts every task these tests flush, so once opened a
// panel stays rendered, the way a closing one does for its 120ms exit. Commits
// isn't kept mounted, and without this its field would vanish (and focus fall
// to the body) at the close itself.
vi.mock("@/hooks/useAnimatedPresence", async () => {
  const { useState } = await import("react");
  return {
    useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => {
      const [opened, setOpened] = useState(isOpen);
      if (isOpen && !opened) setOpened(true);
      return { isVisible: isOpen, shouldRender: isOpen || opened };
    },
  };
});

vi.mock("../ForgeStatusIndicator", () => ({
  ForgeStatusIndicator: () => null,
}));

import { ForgeStatsToolbarButton } from "../ForgeStatsToolbarButton";
import type { Project } from "@shared/types";

const PROJECT: Project = {
  id: "test-proj",
  path: "/test/proj",
  name: "proj",
  emoji: "🌲",
  lastOpened: 0,
};

// FixedDropdown treats overlay rises inside this window as already in flight.
const OVERLAY_GRACE_MS = 300;

type Kind = "issues" | "prs" | "commits";

function Harness() {
  useGlobalEscapeDispatcher();
  return <ForgeStatsToolbarButton currentProject={PROJECT} />;
}

function pill(kind: Kind): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid="forge-stat-pill-${kind}"]`);
  if (!el) throw new Error(`No ${kind} pill rendered`);
  return el;
}

function field(kind: Kind): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="view-${kind}"]`);
  if (!el) throw new Error(`No ${kind} panel rendered`);
  return el;
}

/** Opens `kind` the way a click does, with focus moved into its panel. */
function openWithFocusInside(kind: Kind): void {
  const trigger = pill(kind);
  act(() => {
    trigger.focus();
    fireEvent.click(trigger);
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  act(() => field(kind).focus());
}

function flushTask(): void {
  act(() => {
    vi.advanceTimersByTime(1);
  });
}

function outside<T extends HTMLElement>(tag: string): T {
  const el = document.createElement(tag) as T;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  resetForgeCache();
  resetEscapeStack();
  useUIStore.setState({ overlayStack: [] });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  resetEscapeStack();
  useUIStore.setState({ overlayStack: [] });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each<Kind>(["issues", "prs", "commits"])("closing the %s dropdown", (kind) => {
  it("leaves focus on a terminal that took it during the press", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    // xterm focuses its helper textarea from its own mousedown listener, which
    // runs before the document listener that closes the dropdown.
    const terminal = outside<HTMLTextAreaElement>("textarea");
    terminal.addEventListener("mousedown", () => terminal.focus());

    fireEvent.mouseDown(terminal);
    flushTask();

    expect(pill(kind).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(terminal);
  });

  it("leaves focus on a control the press focused after the close", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    const focusSpy = vi.spyOn(pill(kind), "focus");
    const control = outside<HTMLButtonElement>("button");

    fireEvent.mouseDown(control);
    // The browser's mousedown default action, after dispatch.
    act(() => control.focus());
    flushTask();

    expect(document.activeElement).toBe(control);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("returns focus left inside the closed panel to the pill", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    const trigger = pill(kind);
    const focusSpy = vi.spyOn(trigger, "focus");

    // No blur: a browser that has not run its focus fixup yet leaves focus on
    // the inert field.
    fireEvent.mouseDown(outside<HTMLDivElement>("div"));
    expect(document.activeElement).toBe(field(kind));
    flushTask();

    expect(document.activeElement).toBe(trigger);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("returns focus to the pill without a ring after a press on nothing focusable", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    const trigger = pill(kind);
    const focusSpy = vi.spyOn(trigger, "focus");
    const canvas = outside<HTMLDivElement>("div");

    fireEvent.mouseDown(canvas);
    // A press on nothing focusable blurs whatever had focus.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    flushTask();

    expect(document.activeElement).toBe(trigger);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("returns focus to the pill with its ring on Escape", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    const trigger = pill(kind);
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // At once, not a task later: nothing else is going to take it.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves focus where it is on Escape when it already left the panel", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    const focusSpy = vi.spyOn(pill(kind), "focus");
    const control = outside<HTMLButtonElement>("button");
    act(() => control.focus());

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    flushTask();

    expect(pill(kind).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(control);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

// Issues persists through child overlays (its view opens its own dialogs), so
// only PRs and Commits close when a modal rises over them.
describe.each<Kind>(["prs", "commits"])("a modal rising over the open %s dropdown", (kind) => {
  it("keeps the focus the modal claimed", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    act(() => {
      vi.advanceTimersByTime(OVERLAY_GRACE_MS + 1);
    });
    const focusSpy = vi.spyOn(pill(kind), "focus");
    const modalField = outside<HTMLInputElement>("input");

    act(() => {
      useUIStore.getState().addOverlayClaim("test-modal");
      modalField.focus();
    });
    flushTask();

    expect(pill(kind).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(modalField);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("hands the pill nothing while a modal has yet to take focus", () => {
    render(<Harness />);
    openWithFocusInside(kind);
    act(() => {
      vi.advanceTimersByTime(OVERLAY_GRACE_MS + 1);
    });
    const focusSpy = vi.spyOn(pill(kind), "focus");
    const modalField = outside<HTMLInputElement>("input");

    act(() => {
      useUIStore.getState().addOverlayClaim("test-modal");
    });
    expect(pill(kind).getAttribute("aria-expanded")).toBe("false");
    // AppDialog focuses its field a frame after it mounts, later than a task.
    flushTask();
    expect(focusSpy).not.toHaveBeenCalled();
    act(() => modalField.focus());

    expect(document.activeElement).toBe(modalField);
  });
});

describe("a modal rising over the open issues dropdown", () => {
  it("leaves the dropdown open and the modal's focus alone", () => {
    render(<Harness />);
    openWithFocusInside("issues");
    act(() => {
      vi.advanceTimersByTime(OVERLAY_GRACE_MS + 1);
    });
    const focusSpy = vi.spyOn(pill("issues"), "focus");
    const modalField = outside<HTMLInputElement>("input");

    act(() => {
      useUIStore.getState().addOverlayClaim("test-modal");
      modalField.focus();
    });
    flushTask();

    expect(pill("issues").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(modalField);
    expect(focusSpy).not.toHaveBeenCalled();
  });
});
