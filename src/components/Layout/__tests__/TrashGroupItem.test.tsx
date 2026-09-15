// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TrashGroupItem } from "../TrashGroupItem";
import type { PanelInstance } from "@shared/types/panel";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";

vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: (id: string) =>
    id === "claude" ? { name: "Claude" } : id === "codex" ? { name: "Codex" } : null,
}));

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: unknown) => unknown) =>
    selector({
      restoreTrashedGroup: vi.fn(),
      restoreTerminal: vi.fn(),
      removePanel: vi.fn(),
    }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: unknown) => unknown) =>
    selector({ activeWorktreeId: "wt-active" }),
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => null,
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({
    iconId: null,
    label: "Terminal",
    isAgent: false,
    agentId: null,
    processId: null,
    runtimeKind: "none",
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.HTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    Tooltip: Pass,
    TooltipContent: Pass,
    TooltipProvider: Pass,
    TooltipTrigger: Pass,
  };
});

function makeTerminal(overrides: Partial<PanelInstance> = {}): PanelInstance {
  return {
    id: "t1",
    kind: "terminal",
    title: "claude",
    location: "trash",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PanelInstance;
}

const groupMetadata: TrashedTerminalGroupMetadata = {
  worktreeId: "wt1",
  panelIds: ["t1", "t2"],
  activeTabId: "t1",
  location: "grid",
};

const terminals = [
  {
    terminal: makeTerminal({ id: "t1", title: "First tab" }),
    trashedInfo: {
      id: "t1",
      expiresAt: Date.now() + 20000,
      originalLocation: "grid",
    } as TrashedTerminal,
  },
  {
    terminal: makeTerminal({ id: "t2", title: "Second tab" }),
    trashedInfo: {
      id: "t2",
      expiresAt: Date.now() + 30000,
      originalLocation: "grid",
    } as TrashedTerminal,
  },
];

/**
 * The row's remaining seconds, read from the timer element rather than from the
 * copy around it. The wording of the deadline is a design decision that has
 * already changed once; that the row *reports* a deadline is the invariant.
 */
function countdownSeconds(container: HTMLElement): number {
  const el = container.querySelector<HTMLElement>("[data-trash-countdown]");
  expect(el).not.toBeNull();
  const match = el!.textContent?.match(/(\d+)/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

/** The fraction of the window the meter is currently drawing, 0-1. */
function meterFraction(container: HTMLElement): number {
  const meter = container.querySelector<HTMLElement>("[data-trash-meter]");
  expect(meter).not.toBeNull();
  const fill = meter!.firstElementChild as HTMLElement | null;
  expect(fill).not.toBeNull();
  const match = fill!.style.transform.match(/scaleX\(([\d.]+)\)/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe("TrashGroupItem", () => {
  describe("rendering", () => {
    it("shows active tab title with +N more for multi-tab groups", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("First tab +1 more");
    });

    it("shows just the active tab title for single-tab groups", () => {
      const single = [
        {
          terminal: makeTerminal({ id: "t1", title: "First tab" }),
          trashedInfo: {
            id: "t1",
            expiresAt: Date.now() + 20000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
      ];
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={{ ...groupMetadata, panelIds: ["t1"] }}
          terminals={single}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("First tab");
      expect(container.textContent).not.toContain("+0 more");
      expect(container.textContent).not.toContain("Tab group");
    });

    it("uses lastObservedTitle when present and non-useless", () => {
      const withObserved = [
        {
          terminal: makeTerminal({
            id: "t1",
            title: "claude",
            lastObservedTitle: "Fixing auth bug",
          }),
          trashedInfo: {
            id: "t1",
            expiresAt: Date.now() + 20000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
        {
          terminal: makeTerminal({ id: "t2", title: "Second tab" }),
          trashedInfo: {
            id: "t2",
            expiresAt: Date.now() + 30000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
      ];
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={withObserved}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Fixing auth bug +1 more");
    });

    it("ignores useless lastObservedTitle and falls through to title", () => {
      const uselessObserved = [
        {
          terminal: makeTerminal({
            id: "t1",
            title: "Working on something",
            lastObservedTitle: "claude",
            launchAgentId: "claude",
          }),
          trashedInfo: {
            id: "t1",
            expiresAt: Date.now() + 20000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
        {
          terminal: makeTerminal({ id: "t2", title: "Second tab" }),
          trashedInfo: {
            id: "t2",
            expiresAt: Date.now() + 30000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
      ];
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={uselessObserved}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Working on something +1 more");
    });

    it("falls back to agent config name when launchAgentId set with no usable title", () => {
      const agentOnly = [
        {
          terminal: makeTerminal({
            id: "t1",
            title: "claude",
            launchAgentId: "claude",
          }),
          trashedInfo: {
            id: "t1",
            expiresAt: Date.now() + 20000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
        {
          terminal: makeTerminal({ id: "t2", title: "Second tab" }),
          trashedInfo: {
            id: "t2",
            expiresAt: Date.now() + 30000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
      ];
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={agentOnly}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Claude +1 more");
    });

    it("falls back to count-only label when no usable title can be resolved", () => {
      const useless = [
        {
          terminal: makeTerminal({ id: "t1", title: "claude" }),
          trashedInfo: {
            id: "t1",
            expiresAt: Date.now() + 20000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
        {
          terminal: makeTerminal({ id: "t2", title: "bash" }),
          trashedInfo: {
            id: "t2",
            expiresAt: Date.now() + 30000,
            originalLocation: "grid",
          } as TrashedTerminal,
        },
      ];
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={useless}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Tab group (2 tabs)");
    });

    it("uses the active tab when activeTabId points to non-first panel", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={{ ...groupMetadata, activeTabId: "t2" }}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Second tab +1 more");
    });

    it("falls back to count-only label when activeTabId is stale", () => {
      // If the originally active tab was individually removed, activeTabId no
      // longer matches any terminal — the headline must not silently promote
      // terminals[0] as if it were active, since the (active) marker won't
      // render in the expanded list either.
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={{ ...groupMetadata, activeTabId: "t-removed" }}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Tab group (2 tabs)");
      expect(container.textContent).not.toContain("First tab +1 more");
      expect(container.textContent).not.toContain("Second tab +1 more");
    });

    it("shows active tab marker on the correct tab", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={{ ...groupMetadata, activeTabId: "t2" }}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      // Expand to see child tabs
      const expandBtn = container.querySelector("button");
      act(() => expandBtn?.click());
      // The marker should be in the same row as Second tab, not First tab
      const rows = container.querySelectorAll('[role="region"] > div');
      const matchingRow = Array.from(rows).find((row) => row.textContent?.includes("Second tab"));
      expect(matchingRow?.textContent).toContain("(active)");
      const otherRow = Array.from(rows).find((row) => row.textContent?.includes("First tab"));
      expect(otherRow?.textContent).not.toContain("(active)");
    });

    it("shows worktree name when provided", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          worktreeName="feature-auth"
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("feature-auth");
    });

    it("shows deleted tree marker for orphaned groups", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={{ ...groupMetadata, worktreeId: "wt-ghost" }}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Worktree deleted");
    });
  });

  describe("expand/collapse", () => {
    it("starts collapsed", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      // "Second tab" only appears in the expanded child list — the headline
      // surfaces the active tab ("First tab"), not the others.
      expect(container.textContent).not.toContain("Second tab");
    });

    it("expands to show child terminals on click", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      const expandBtn = container.querySelector("button");
      act(() => expandBtn?.click());
      expect(container.textContent).toContain("First tab");
      expect(container.textContent).toContain("Second tab");
    });
  });

  describe("countdown timer", () => {
    let visibilityListeners: Array<() => void>;
    let visibilityState: DocumentVisibilityState;

    beforeEach(() => {
      vi.useFakeTimers();
      visibilityListeners = [];
      visibilityState = "visible";

      Object.defineProperty(document, "hidden", {
        get: () => visibilityState === "hidden",
        configurable: true,
      });
      Object.defineProperty(document, "visibilityState", {
        get: () => visibilityState,
        configurable: true,
      });

      const origAdd = document.addEventListener.bind(document);
      const origRemove = document.removeEventListener.bind(document);
      vi.spyOn(document, "addEventListener").mockImplementation((type, handler, options) => {
        if (type === "visibilitychange") {
          visibilityListeners.push(handler as () => void);
        }
        return origAdd(type, handler, options);
      });
      vi.spyOn(document, "removeEventListener").mockImplementation((type, handler, options) => {
        if (type === "visibilitychange") {
          visibilityListeners = visibilityListeners.filter((l) => l !== handler);
        }
        return origRemove(type, handler, options);
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function fireVisibilityChange(state: DocumentVisibilityState) {
      visibilityState = state;
      visibilityListeners.forEach((l) => l());
    }

    it("renders seconds remaining based on earliestExpiry", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 15000}
        />
      );
      expect(countdownSeconds(container)).toBeGreaterThan(0);
    });

    it("decrements displayed seconds when time advances while visible", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      const initialSeconds = countdownSeconds(container);

      act(() => vi.advanceTimersByTime(2000));
      const laterSeconds = countdownSeconds(container);

      expect(laterSeconds).toBeLessThan(initialSeconds);
    });

    it("does not decrement while document is hidden", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      act(() => vi.advanceTimersByTime(1000));
      const beforeHide = countdownSeconds(container);

      act(() => fireVisibilityChange("hidden"));
      act(() => vi.advanceTimersByTime(10000));
      const afterHide = countdownSeconds(container);

      expect(afterHide).toBe(beforeHide);
    });

    it("catches up to wall-clock time on visibility restore", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      act(() => fireVisibilityChange("hidden"));
      act(() => vi.advanceTimersByTime(10000));
      act(() => fireVisibilityChange("visible"));

      const afterRestore = countdownSeconds(container);
      const seconds = afterRestore;
      expect(seconds).toBeLessThanOrEqual(10);
    });

    it("shows 0s for already-expired earliestExpiry", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() - 5000}
        />
      );
      expect(countdownSeconds(container)).toBe(0);
    });
  });

  describe("the deadline is always on screen", () => {
    function renderAt(remainingMs: number) {
      return render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + remainingMs}
        />
      );
    }

    // The rule, not the styling that implements it: a group seconds from
    // destruction never makes the user hover to find that out. Sampled right
    // across the window so a threshold cannot creep back in.
    it.each([20000, 12000, 6000, 3000, 1000])(
      "reports the deadline without hover or focus at %ims left",
      (remainingMs) => {
        const { container } = renderAt(remainingMs);
        const el = container.querySelector<HTMLElement>("[data-trash-countdown]")!;
        expect(el).not.toBeNull();
        expect(el.className).not.toContain("opacity-0");
        expect(el.className).not.toContain("group-hover:");
        expect(countdownSeconds(container)).toBe(Math.ceil(remainingMs / 1000));
      }
    );

    it("exposes the deadline to assistive tech without announcing it once a second", () => {
      const { container } = renderAt(20000);
      const el = container.querySelector<HTMLElement>("[data-trash-countdown]")!;
      // role="timer" is implicitly aria-live="off": readable on demand, never
      // interrupting. An explicit aria-live here would clobber speech at 1Hz.
      expect(el.getAttribute("role")).toBe("timer");
      expect(el.hasAttribute("aria-live")).toBe(false);
      expect(el.getAttribute("aria-label")).toMatch(/second/i);
      expect(el.getAttribute("aria-hidden")).not.toBe("true");
    });

    it("draws a meter whose length falls as the window runs out", () => {
      const early = renderAt(20000);
      const late = renderAt(4000);
      const earlyFraction = meterFraction(early.container);
      const lateFraction = meterFraction(late.container);
      expect(earlyFraction).toBeGreaterThan(lateFraction);
      expect(lateFraction).toBeGreaterThan(0);
    });

    it("hides the meter from assistive tech, since the timer already carries the value", () => {
      const { container } = renderAt(20000);
      expect(container.querySelector("[data-trash-meter]")!.getAttribute("aria-hidden")).toBe(
        "true"
      );
    });

    it("separates a nearly-expired group from a fresh one by more than colour", () => {
      const fresh = renderAt(20000);
      const nearly = renderAt(2000);
      // Length and number both differ, so the distinction survives a viewer who
      // cannot tell the warning tone from the neutral one (SC 1.4.1).
      const nearlyFraction = meterFraction(nearly.container);
      const freshFraction = meterFraction(fresh.container);
      expect(nearlyFraction).toBeLessThan(freshFraction);
      const nearlySeconds = countdownSeconds(nearly.container);
      const freshSeconds = countdownSeconds(fresh.container);
      expect(nearlySeconds).toBeLessThan(freshSeconds);
    });

    it("marks the final approach so the warning treatment is testable, not incidental", () => {
      expect(
        renderAt(4000)
          .container.querySelector("[data-trash-countdown]")!
          .getAttribute("data-critical")
      ).toBe("true");
      expect(
        renderAt(9000)
          .container.querySelector("[data-trash-countdown]")!
          .getAttribute("data-critical")
      ).toBeNull();
    });
  });

  describe("expanded members keep their controls reachable by keyboard", () => {
    it("reveals a child row's actions on focus as well as hover", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Expand group" }));
      const actions = container.querySelector<HTMLElement>("[class*='group-hover/panel']")!;
      expect(actions).not.toBeNull();
      // A control that is focusable but invisible strands the keyboard user on
      // a button they cannot see — the row one level up already pairs these.
      expect(actions.className).toContain("group-focus-within/panel:opacity-100");
    });
  });
});
