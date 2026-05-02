// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { TrashGroupItem } from "../TrashGroupItem";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";

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
    it("shows group name with tab count", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      expect(container.textContent).toContain("Tab Group (2 tabs)");
    });

    it("shows singular tab label for one terminal", () => {
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
      expect(container.textContent).toContain("Tab Group (1 tab)");
    });

    it("shows active tab marker", () => {
      const { container } = render(
        <TrashGroupItem
          groupRestoreId="grp1"
          groupMetadata={groupMetadata}
          terminals={terminals}
          earliestExpiry={Date.now() + 20000}
        />
      );
      // Expand to see child tabs
      const expandBtn = container.querySelector("button");
      act(() => expandBtn?.click());
      expect(container.textContent).toContain("(active)");
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
      expect(container.textContent).not.toContain("First tab");
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
});
