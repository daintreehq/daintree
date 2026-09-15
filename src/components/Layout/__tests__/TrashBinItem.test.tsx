// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TrashBinItem } from "../TrashBinItem";
import type { PanelInstance } from "@shared/types/panel";
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

function makeAgentTerminal(overrides: Partial<PanelInstance> = {}): PanelInstance {
  return {
    id: "t1",
    kind: "terminal",
    launchAgentId: "claude",
    title: "claude",
    location: "trash",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PanelInstance;
}

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

const onRequestRemove = vi.fn();

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
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
          worktreeName="feature-auth"
        />
      );
      const text = container.textContent ?? "";
      // The worktree is named once, on the metadata line — never folded into
      // the title as well, which is what the agent-name fallback used to do.
      expect(text.split("feature-auth").length - 1).toBe(1);
      expect(text).toContain("Claude");
      const title = container.querySelector<HTMLElement>("[data-trash-row] > div > div")!;
      expect(title.textContent).toBe("Claude");
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
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
          worktreeName="feature-auth"
        />
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
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
        />
      );
      expect(container.textContent).toContain("Claude");
    });

    it("passes through a meaningful title on non-agent terminals", () => {
      const terminal = {
        id: "t2",
        kind: "terminal" as const,
        title: "my dev shell",
        location: "trash" as const,
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      } as PanelInstance;
      const trashedInfo: TrashedTerminal = {
        id: "t2",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
        />
      );
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
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
        />
      );
      expect(countdownSeconds(container)).toBeGreaterThan(0);
    });

    it("decrements displayed seconds when time advances while visible", () => {
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
        />
      );
      const initialSeconds = countdownSeconds(container);

      act(() => vi.advanceTimersByTime(2000));
      const laterSeconds = countdownSeconds(container);

      expect(laterSeconds).toBeLessThan(initialSeconds);
    });

    it("does not decrement while document is hidden", () => {
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
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
      const terminal = makeAgentTerminal();
      const trashedInfo: TrashedTerminal = {
        id: "t1",
        expiresAt: Date.now() + 20000,
        originalLocation: "grid",
      };
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
        />
      );
      act(() => fireVisibilityChange("hidden"));
      act(() => vi.advanceTimersByTime(10000));
      act(() => fireVisibilityChange("visible"));

      const afterRestore = countdownSeconds(container);
      const seconds = afterRestore;
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
      const { container } = render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={terminal}
          trashedInfo={trashedInfo}
        />
      );
      expect(countdownSeconds(container)).toBe(0);
    });
  });

  describe("the deadline is always on screen", () => {
    function renderAt(remainingMs: number) {
      return render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={makeAgentTerminal()}
          trashedInfo={{ id: "t1", expiresAt: Date.now() + remainingMs, originalLocation: "grid" }}
        />
      );
    }

    // The rule, not the styling that implements it: a row whose content is
    // seconds from destruction never makes the user hover to find that out.
    // Sampled right across the window so a threshold cannot creep back in.
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

    it("separates a nearly-expired row from a fresh one by more than colour", () => {
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

  describe("permanent removal is confirmed, not immediate", () => {
    it("raises a removal request instead of destroying the pane on the spot", () => {
      onRequestRemove.mockClear();
      render(
        <TrashBinItem
          onRequestRemove={onRequestRemove}
          terminal={makeAgentTerminal()}
          trashedInfo={{ id: "t1", expiresAt: Date.now() + 20000, originalLocation: "grid" }}
        />
      );
      // Restore undoes *closing* a pane; nothing undoes destroying one, which
      // is what puts this button in the tier that owes a confirmation.
      fireEvent.click(screen.getByRole("button", { name: /permanently/i }));
      expect(onRequestRemove).toHaveBeenCalledTimes(1);
      expect(onRequestRemove.mock.calls[0]![0]).toMatchObject({ ids: ["t1"] });
    });
  });
});
