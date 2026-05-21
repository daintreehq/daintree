// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { TrashGroupItem } from "../TrashGroupItem";
import type { TerminalInstance } from "@/store";
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

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    kind: "terminal",
    title: "claude",
    location: "trash",
    ...overrides,
  } as TerminalInstance;
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
      expect(container.textContent).toContain("(feature-auth)");
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
      expect(container.textContent).toContain("(deleted tree)");
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
      expect(container.textContent).toMatch(/\d+s remaining/);
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
      const initialMatch = container.textContent?.match(/(\d+)s remaining/);
      expect(initialMatch).toBeTruthy();
      const initialSeconds = parseInt(initialMatch?.[1] ?? "0", 10);

      act(() => vi.advanceTimersByTime(2000));
      const laterMatch = container.textContent?.match(/(\d+)s remaining/);
      expect(laterMatch).toBeTruthy();
      const laterSeconds = parseInt(laterMatch?.[1] ?? "0", 10);

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
      const beforeHide = container.textContent?.match(/(\d+)s remaining/)?.[1];

      act(() => fireVisibilityChange("hidden"));
      act(() => vi.advanceTimersByTime(10000));
      const afterHide = container.textContent?.match(/(\d+)s remaining/)?.[1];

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

      const afterRestore = container.textContent?.match(/(\d+)s remaining/);
      expect(afterRestore).toBeTruthy();
      const seconds = parseInt(afterRestore?.[1] ?? "0", 10);
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
      expect(container.textContent).toContain("0s remaining");
    });
  });

  describe("countdown accessibility and visibility", () => {
    function findCountdownEl(container: HTMLElement): HTMLElement {
      const matches = Array.from(container.querySelectorAll<HTMLElement>("[aria-hidden]")).filter(
        (el) => el.textContent?.includes("s remaining")
      );
      expect(matches.length).toBe(1);
      return matches[0]!;
    }

    it("removes aria-live and marks the countdown aria-hidden", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      const el = findCountdownEl(container);
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.hasAttribute("aria-live")).toBe(false);
    });

    it("uses tabular-nums to keep digits aligned", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      const el = findCountdownEl(container);
      expect(el.className).toContain("tabular-nums");
    });

    it("hides the countdown by default outside the final approach window", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      const el = findCountdownEl(container);
      expect(el.className).toContain("opacity-0");
      expect(el.className).toContain("group-hover:opacity-100");
      expect(el.className).toContain("group-focus-within:opacity-100");
      expect(el.className).not.toContain("motion-reduce:opacity-100");
      expect(el.className).not.toContain("text-status-warning");
    });

    it("surfaces the countdown unconditionally at the 5s threshold", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 5000}
        />
      );
      const el = findCountdownEl(container);
      expect(el.className).toContain("opacity-100");
      expect(el.className).toContain("text-status-warning");
      expect(el.className).not.toContain("opacity-0");
    });

    it("keeps the warning treatment below the threshold", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 4000}
        />
      );
      const el = findCountdownEl(container);
      expect(el.className).toContain("opacity-100");
      expect(el.className).toContain("text-status-warning");
    });

    it("stays quiet just above the threshold", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 6000}
        />
      );
      const el = findCountdownEl(container);
      expect(el.className).toContain("opacity-0");
      expect(el.className).not.toContain("text-status-warning");
    });
  });
});
