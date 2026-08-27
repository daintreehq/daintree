// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginConfirmDialog } from "../Plugin/PluginConfirmDialog";
import {
  __resetPluginConfirmStoreForTesting,
  requestPluginConfirmation,
} from "@/store/pluginConfirmStore";
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
  overrides: {
    requestId?: string;
    actionTitle?: string;
    effectiveDanger?: ActionDanger;
    argsSummary?: string;
    pluginId?: string;
  } = {}
) {
  return requestPluginConfirmation({
    requestId: overrides.requestId ?? "req-1",
    pluginId: overrides.pluginId ?? "test-plugin",
    actionId: "worktree.delete",
    actionTitle: overrides.actionTitle ?? "Delete worktree",
    actionDescription: "Permanently delete a worktree.",
    effectiveDanger: overrides.effectiveDanger ?? "confirm",
    argsSummary: overrides.argsSummary ?? '{"worktreeId":"wt-1"}',
  });
}

const PENDING_PROBE_MS = 20;

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

describe("PluginConfirmDialog", () => {
  beforeEach(() => {
    __resetPluginConfirmStoreForTesting();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    __resetPluginConfirmStoreForTesting();
    cleanup();
    vi.restoreAllMocks();
  });

  it("labels the confirm button with the action title, not a generic verb", () => {
    void enqueue({ actionTitle: "Delete worktree" });
    render(<PluginConfirmDialog />);

    expect(screen.getByRole("button", { name: "Delete worktree" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^run action$/i })).toBeNull();
  });

  it("renders destructive styling for effectiveDanger:confirm dispatches", () => {
    void enqueue({ actionTitle: "Delete worktree", effectiveDanger: "confirm" });
    const { unmount } = render(<PluginConfirmDialog />);

    expect(screen.getByRole("button", { name: "Delete worktree" }).className).toContain(
      "bg-destructive"
    );

    unmount();
    __resetPluginConfirmStoreForTesting();

    void enqueue({ actionTitle: "List worktrees", effectiveDanger: "safe" });
    render(<PluginConfirmDialog />);

    expect(screen.getByRole("button", { name: "List worktrees" }).className).not.toContain(
      "bg-destructive"
    );
  });

  it("resolves exactly once on a rapid double-confirm, never approving the queued item", async () => {
    vi.useFakeTimers();
    try {
      const pA = enqueue({ requestId: "A", actionTitle: "Delete worktree" });
      const pB = enqueue({ requestId: "B", actionTitle: "Push branch" });

      render(<PluginConfirmDialog />);

      act(() => {
        vi.advanceTimersByTime(1200);
      });

      const confirmBtn = screen.getByRole("button", { name: "Delete worktree" });

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

  it("disables the confirm button on mount for effectiveDanger:confirm, re-enabling after the cooldown", () => {
    vi.useFakeTimers();
    try {
      void enqueue({ actionTitle: "Delete worktree", effectiveDanger: "confirm" });
      render(<PluginConfirmDialog />);

      const confirmBtn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(confirmBtn.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("does not gate non-destructive dispatches with a cooldown", () => {
    vi.useFakeTimers();
    try {
      void enqueue({ actionTitle: "List worktrees", effectiveDanger: "safe" });
      render(<PluginConfirmDialog />);

      const confirmBtn = screen.getByRole("button", {
        name: "List worktrees",
      }) as HTMLButtonElement;
      expect(confirmBtn.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("restarts the cooldown when a fresh destructive item is promoted", async () => {
    vi.useFakeTimers();
    try {
      const pA = enqueue({
        requestId: "A",
        actionTitle: "Delete worktree",
        effectiveDanger: "confirm",
      });
      void enqueue({ requestId: "B", actionTitle: "Reset branch", effectiveDanger: "confirm" });

      render(<PluginConfirmDialog />);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      const firstBtn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(firstBtn.hasAttribute("aria-disabled")).toBe(false);

      act(() => {
        firstBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(pA).resolves.toBe("approved");

      const secondBtn = screen.getByRole("button", {
        name: "Reset branch",
      }) as HTMLButtonElement;
      expect(secondBtn.getAttribute("aria-disabled")).toBe("true");

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(secondBtn.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("arms the cooldown for the first destructive item even when mounted empty", () => {
    vi.useFakeTimers();
    try {
      render(<PluginConfirmDialog />);

      act(() => {
        void enqueue({ actionTitle: "Delete worktree", effectiveDanger: "confirm" });
      });

      const btn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("true");
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("ignores a click on a freshly-promoted item that lands before its cooldown clears", async () => {
    vi.useFakeTimers();
    try {
      const pA = enqueue({
        requestId: "A",
        actionTitle: "Delete worktree",
        effectiveDanger: "confirm",
      });
      const pB = enqueue({
        requestId: "B",
        actionTitle: "Reset branch",
        effectiveDanger: "confirm",
      });

      render(<PluginConfirmDialog />);

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      const aBtn = screen.getByRole("button", { name: "Delete worktree" });
      act(() => {
        aBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(pA).resolves.toBe("approved");

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

  it("shows the plugin provenance description when there is no action description", () => {
    void enqueue({ pluginId: "my-plugin" });
    const { unmount } = render(<PluginConfirmDialog />);

    // When actionDescription is set, it takes precedence over the fallback.
    expect(screen.getByText("Permanently delete a worktree.")).toBeTruthy();

    unmount();
    __resetPluginConfirmStoreForTesting();

    // With an empty actionDescription, the provenance fallback renders.
    void requestPluginConfirmation({
      requestId: "req-2",
      pluginId: "my-plugin",
      actionId: "worktree.delete",
      actionTitle: "Delete worktree",
      actionDescription: "",
      effectiveDanger: "confirm",
      argsSummary: "{}",
    });
    render(<PluginConfirmDialog />);

    expect(screen.getByText("Action contributed by the 'my-plugin' plugin.")).toBeTruthy();
  });

  it("renders the args preview block", () => {
    void enqueue({ argsSummary: '{"key":"value"}' });
    render(<PluginConfirmDialog />);

    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText('{"key":"value"}')).toBeTruthy();
  });

  it("omits the Arguments section entirely for an action with no arguments", () => {
    // Previously this rendered the literal word "null": summarizeMcpArgs
    // serialized `undefined` to the string "null", which is truthy, so the
    // `|| "(none)"` fallback never fired (#11299). Now the summary is empty
    // and the whole block is dropped — the description above already says
    // what will run.
    void enqueue({ argsSummary: "" });
    render(<PluginConfirmDialog />);

    expect(screen.queryByText("Arguments")).toBeNull();
    expect(screen.queryByText("(none)")).toBeNull();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("still shows the section for an argument that is genuinely null", () => {
    // "takes no arguments" and "one argument whose value is null" are
    // different facts; suppressing both would hide a real argument from the
    // person being asked to approve the call.
    void enqueue({ argsSummary: "null" });
    render(<PluginConfirmDialog />);

    expect(screen.getByText("Arguments")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
  });

  it("rejects when cancel is clicked", async () => {
    const p = enqueue();
    render(<PluginConfirmDialog />);

    act(() => {
      screen
        .getByRole("button", { name: "Cancel" })
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await expect(p).resolves.toBe("rejected");
  });

  it("approves when confirm is clicked after cooldown", async () => {
    vi.useFakeTimers();
    try {
      const p = enqueue();
      render(<PluginConfirmDialog />);

      act(() => {
        vi.advanceTimersByTime(1200);
      });

      act(() => {
        screen
          .getByRole("button", { name: "Delete worktree" })
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      await expect(p).resolves.toBe("approved");
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });
});
