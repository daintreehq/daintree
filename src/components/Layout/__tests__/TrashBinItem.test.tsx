// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { TrashBinItem } from "../TrashBinItem";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal } from "@/store/slices";

vi.mock("@/store", () => ({
  usePanelStore: (selector: (s: unknown) => unknown) =>
    selector({ restoreTerminal: vi.fn(), removePanel: vi.fn() }),
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

vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: (agentId: string) =>
    agentId === "claude" ? { name: "Claude" } : undefined,
}));

function makeAgentTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: "t1",
    kind: "terminal",
    launchAgentId: "claude",
    title: "claude",
    location: "trash",
    ...overrides,
  } as TerminalInstance;
}

describe("TrashBinItem", () => {
  describe("label rendering", () => {
    it("does not duplicate worktree name when the agent title falls back to agent name", () => {
      const terminal = makeAgentTerminal({ title: "claude", lastObservedTitle: undefined });
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(
        <TrashBinItem terminal={terminal} trashedInfo={trashedInfo} worktreeName="feature-auth" />
      );
      const text = container.textContent ?? "";
      const occurrences = text.split("feature-auth").length - 1;
      expect(occurrences).toBe(1);
      expect(text).not.toContain("Claude · feature-auth");
      expect(text).toContain("Claude");
      expect(text).toContain("(feature-auth)");
    });

    it("prefers lastObservedTitle over plain title for agent terminals", () => {
      const terminal = makeAgentTerminal({
        title: "claude",
        lastObservedTitle: "Fixing auth bug",
      });
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(
        <TrashBinItem terminal={terminal} trashedInfo={trashedInfo} worktreeName="feature-auth" />
      );
      expect(container.textContent).toContain("Fixing auth bug");
    });

    it("falls back to agent name alone when both titles are useless", () => {
      const terminal = makeAgentTerminal({ title: "claude", lastObservedTitle: "claude" });
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
      expect(container.textContent).toContain("Claude");
    });

    it("passes through a meaningful title on non-agent terminals", () => {
      const terminal = {
        id: "t2",
        kind: "terminal" as const,
        title: "my dev shell",
        location: "trash" as const,
      } as TerminalInstance;
      const trashedInfo: TrashedTerminal = {
        id: "t2",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
      expect(container.textContent).toContain("my dev shell");
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

    it("renders seconds remaining for a future expiry", () => {
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
      expect(container.textContent).toMatch(/\d+s remaining/);
    });

    it("decrements displayed seconds when time advances while visible", () => {
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
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
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
      act(() => vi.advanceTimersByTime(1000));
      const beforeHide = container.textContent?.match(/(\d+)s remaining/)?.[1];

      act(() => fireVisibilityChange("hidden"));
      act(() => vi.advanceTimersByTime(10000));
      const afterHide = container.textContent?.match(/(\d+)s remaining/)?.[1];

      expect(afterHide).toBe(beforeHide);
    });

    it("catches up to wall-clock time on visibility restore", () => {
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
      act(() => fireVisibilityChange("hidden"));
      act(() => vi.advanceTimersByTime(10000));
      act(() => fireVisibilityChange("visible"));

      const afterRestore = container.textContent?.match(/(\d+)s remaining/);
      expect(afterRestore).toBeTruthy();
      const seconds = parseInt(afterRestore?.[1] ?? "0", 10);
      // 20s initial - 1s tick before hide - 10s hidden ≈ 9s remaining
      expect(seconds).toBeLessThanOrEqual(10);
    });

    it("shows 0s for already-expired items", () => {
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() - 5000,
        originalLocation: "grid",
      };
      const { container } = render(<TrashBinItem terminal={terminal} trashedInfo={trashedInfo} />);
      expect(container.textContent).toContain("0s remaining");
    });
  });
});
