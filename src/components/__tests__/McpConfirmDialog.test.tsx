// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfirmDialog } from "../McpConfirmDialog";
import { __resetMcpConfirmStoreForTesting, requestMcpConfirmation } from "@/store/mcpConfirmStore";
import type { ActionDanger } from "@shared/types/actions";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function enqueue(
  overrides: { requestId?: string; actionTitle?: string; danger?: ActionDanger } = {}
) {
  return requestMcpConfirmation({
    requestId: overrides.requestId ?? "req-1",
    actionId: "worktree.delete",
    actionTitle: overrides.actionTitle ?? "Delete worktree",
    actionDescription: "Permanently delete a worktree.",
    argsSummary: '{"worktreeId":"wt-1"}',
    danger: overrides.danger ?? "confirm",
  });
}

describe("McpConfirmDialog", () => {
  beforeEach(() => {
    __resetMcpConfirmStoreForTesting();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
    cleanup();
    vi.restoreAllMocks();
  });

  it("labels the confirm button with the action title, not a generic verb", () => {
    void enqueue({ actionTitle: "Delete worktree" });
    render(<McpConfirmDialog />);

    expect(screen.getByRole("button", { name: "Delete worktree" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^run action$/i })).toBeNull();
  });

  it("renders destructive styling only for danger:confirm dispatches", () => {
    void enqueue({ actionTitle: "Delete worktree", danger: "confirm" });
    const { unmount } = render(<McpConfirmDialog />);

    expect(screen.getByRole("button", { name: "Delete worktree" }).className).toContain(
      "bg-destructive"
    );

    unmount();
    __resetMcpConfirmStoreForTesting();

    void enqueue({ actionTitle: "List worktrees", danger: "safe" });
    render(<McpConfirmDialog />);

    expect(screen.getByRole("button", { name: "List worktrees" }).className).not.toContain(
      "bg-destructive"
    );
  });

  it("resolves exactly once on a rapid double-confirm, never approving the queued item", async () => {
    vi.useFakeTimers();
    try {
      const pA = enqueue({ requestId: "A", actionTitle: "Delete worktree" });
      const pB = enqueue({ requestId: "B", actionTitle: "Push branch" });

      render(<McpConfirmDialog />);

      // danger:"confirm" arms the read-time cooldown, which disables the
      // button on mount. Clear it so the double-click can land.
      act(() => {
        vi.advanceTimersByTime(1200);
      });

      const confirmBtn = screen.getByRole("button", { name: "Delete worktree" });

      // Two native clicks dispatched within a single batched update — both
      // handlers run against the same render snapshot (item A visible) before
      // React advances the queue, mirroring a real double-click.
      act(() => {
        confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await expect(pA).resolves.toBe("approved");

      const sentinel = Symbol("pending");
      const race = Promise.race([
        pB,
        new Promise((resolve) => setTimeout(() => resolve(sentinel), 20)),
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(await race).toBe(sentinel);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("disables the confirm button on mount for danger:confirm, re-enabling after the cooldown", () => {
    vi.useFakeTimers();
    try {
      void enqueue({ actionTitle: "Delete worktree", danger: "confirm" });
      render(<McpConfirmDialog />);

      const confirmBtn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(confirmBtn.disabled).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("does not gate non-destructive dispatches with a cooldown", () => {
    vi.useFakeTimers();
    try {
      void enqueue({ actionTitle: "List worktrees", danger: "safe" });
      render(<McpConfirmDialog />);

      const confirmBtn = screen.getByRole("button", {
        name: "List worktrees",
      }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("restarts the cooldown when a fresh destructive item is promoted", async () => {
    vi.useFakeTimers();
    try {
      const pA = enqueue({ requestId: "A", actionTitle: "Delete worktree", danger: "confirm" });
      enqueue({ requestId: "B", actionTitle: "Reset branch", danger: "confirm" });

      render(<McpConfirmDialog />);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      const firstBtn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(firstBtn.disabled).toBe(false);

      act(() => {
        firstBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(pA).resolves.toBe("approved");

      // Item B is now promoted into the same mounted dialog — its cooldown
      // must arm afresh so a click meant for A can't approve B.
      const secondBtn = screen.getByRole("button", {
        name: "Reset branch",
      }) as HTMLButtonElement;
      expect(secondBtn.disabled).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(secondBtn.disabled).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("arms the cooldown for the first destructive item even when mounted empty", () => {
    vi.useFakeTimers();
    try {
      render(<McpConfirmDialog />); // current === null, dialog mounted closed

      act(() => {
        void enqueue({ actionTitle: "Delete worktree", danger: "confirm" });
      });

      // The false→true transition must arm synchronously (useLayoutEffect), so
      // the button is already disabled without advancing any timers.
      const btn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("ignores a click on a freshly-promoted item that lands before its cooldown clears", async () => {
    vi.useFakeTimers();
    try {
      const pA = enqueue({ requestId: "A", actionTitle: "Delete worktree", danger: "confirm" });
      const pB = enqueue({ requestId: "B", actionTitle: "Reset branch", danger: "confirm" });

      render(<McpConfirmDialog />);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      const aBtn = screen.getByRole("button", { name: "Delete worktree" });
      act(() => {
        aBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(pA).resolves.toBe("approved");

      // B is now visible; a click landing immediately (before its cooldown
      // elapses) must not approve it.
      const bBtn = screen.getByRole("button", { name: "Reset branch" });
      act(() => {
        bBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      const sentinel = Symbol("pending");
      const race = Promise.race([
        pB,
        new Promise((resolve) => setTimeout(() => resolve(sentinel), 20)),
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(await race).toBe(sentinel);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("keeps the auto-timeout window above the cooldown for a long-queued destructive item", async () => {
    vi.useFakeTimers();
    try {
      const p = enqueue({ actionTitle: "Delete worktree", danger: "confirm" });

      // Simulate ~27.5s spent queued behind earlier modals before promotion,
      // so only ~500ms of the 28s budget remains at render time.
      act(() => {
        vi.advanceTimersByTime(27_500);
      });

      render(<McpConfirmDialog />);
      const btn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      // The 1200ms cooldown must clear before the auto-timeout fires — the old
      // Math.max(500, …) floor would have timed the item out first, making it
      // unapproveable.
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(btn.disabled).toBe(false);

      act(() => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(p).resolves.toBe("approved");
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });
});
