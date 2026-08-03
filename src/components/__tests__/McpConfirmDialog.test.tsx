// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfirmDialog } from "../McpConfirmDialog";
import {
  __resetMcpConfirmStoreForTesting,
  requestMcpConfirmation,
  useMcpConfirmStore,
} from "@/store/mcpConfirmStore";
import type { ActionDanger } from "@shared/types/actions";
import type { McpBearerIdentity } from "@shared/types/ipc/mcpServer";

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
  overrides: {
    requestId?: string;
    actionTitle?: string;
    danger?: ActionDanger;
    callerInfo?: McpBearerIdentity;
    dangerRationale?: string;
    preview?: string[];
    previewTitle?: string;
    previewPending?: boolean;
  } = {}
) {
  return requestMcpConfirmation({
    requestId: overrides.requestId ?? "req-1",
    actionId: "worktree.delete",
    actionTitle: overrides.actionTitle ?? "Delete worktree",
    actionDescription: "Permanently delete a worktree.",
    argsSummary: '{"worktreeId":"wt-1"}',
    danger: overrides.danger ?? "confirm",
    callerInfo: overrides.callerInfo,
    ...(overrides.dangerRationale ? { dangerRationale: overrides.dangerRationale } : {}),
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.previewTitle ? { previewTitle: overrides.previewTitle } : {}),
    ...(overrides.previewPending ? { previewPending: overrides.previewPending } : {}),
  });
}

const PENDING_PROBE_MS = 20;

// Assert a confirmation promise has NOT settled: race it against a short
// fake-timer probe and require the probe to win. Used to prove a queued item
// was never approved by a click meant for a different modal.
async function expectStillPending(promise: Promise<unknown>) {
  const sentinel = Symbol("pending");
  const race = Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(sentinel), PENDING_PROBE_MS)),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PENDING_PROBE_MS);
  });
  expect(await race).toBe(sentinel);
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

  // #11538: a git.push preview is a commit list, not working-tree changes, so
  // the heading travels with the lines instead of being hardcoded.
  it("renders the preview under its own heading when one is supplied", () => {
    void enqueue({
      preview: ["Branch: feature/x", "  abcdef1 Fix the thing — Ada"],
      previewTitle: "Branch and local commits",
    });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Branch and local commits")).toBeTruthy();
    expect(screen.queryByText("Working tree changes")).toBeNull();
    expect(screen.getByText(/Fix the thing/)).toBeTruthy();
  });

  it("keeps the original working-tree heading when no preview title is supplied", () => {
    void enqueue({ preview: ["No uncommitted changes."] });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Working tree changes")).toBeTruthy();
  });

  // Must advance PAST the destructive cooldown first: that independently
  // disables the button, so asserting immediately would pass even with the
  // previewPending gate removed entirely.
  it("blocks approval past the cooldown while a preview is still loading", async () => {
    vi.useFakeTimers();
    try {
      void enqueue({ requestId: "req-pending", previewPending: true });
      render(<McpConfirmDialog />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1400);
      });

      const confirm = screen.getByRole("button", { name: "Delete worktree" });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText(/Checking current changes/)).toBeTruthy();

      // Only the preview landing unblocks it.
      act(() => {
        useMcpConfirmStore.getState().setPreview("req-pending", ["No uncommitted changes."]);
      });
      expect(screen.getByRole("button", { name: "Delete worktree" }).hasAttribute("disabled")).toBe(
        false
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // setPreview patches the item in place; if it dropped previewTitle the loaded
  // commit list would silently revert to the working-tree heading.
  it("keeps the preview title across the async setPreview patch", () => {
    void enqueue({
      requestId: "req-title",
      previewPending: true,
      previewTitle: "Branch and local commits",
    });
    render(<McpConfirmDialog />);

    act(() => {
      useMcpConfirmStore
        .getState()
        .setPreview("req-title", ["Branch: main", "  abcdef1 Fix — Ada"]);
    });

    expect(screen.getByText("Branch and local commits")).toBeTruthy();
    expect(screen.queryByText("Working tree changes")).toBeNull();
  });

  it("shows the requesting-bearer identity for external dispatches (#9157)", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      callerInfo: { token4LastChars: "1234", userAgent: "Claude Code" },
    });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByText(/…1234 · Claude Code/)).toBeTruthy();
  });

  it("omits the requesting-bearer row when callerInfo is absent (pinned help-session)", () => {
    void enqueue({ actionTitle: "Delete worktree" });
    render(<McpConfirmDialog />);

    expect(screen.queryByText("Requested by")).toBeNull();
  });

  it("surfaces the action's dangerRationale so the human sees why it's gated (#11342)", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      dangerRationale: "Permanently removes the worktree directory and any uncommitted changes.",
    });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Why this is gated")).toBeTruthy();
    expect(
      screen.getByText(/Permanently removes the worktree directory and any uncommitted changes\./)
    ).toBeTruthy();
  });

  it("omits the rationale row when the action carries no dangerRationale", () => {
    void enqueue({ actionTitle: "Delete worktree" });
    render(<McpConfirmDialog />);

    expect(screen.queryByText("Why this is gated")).toBeNull();
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

      await expectStillPending(pB);
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
      void enqueue({ requestId: "B", actionTitle: "Reset branch", danger: "confirm" });

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

      await expectStillPending(pB);
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
