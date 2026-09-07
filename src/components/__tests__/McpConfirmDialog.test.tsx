// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    sessionOrigin?: "help" | "assistant-pane" | "external";
    argsSummary?: string;
    subject?: string;
    typedNameTarget?: string;
    selectableTargets?: {
      id: string;
      name: string;
      worktree?: string;
      kindLabel: string;
      agentRunning: boolean;
    }[];
  } = {}
) {
  return requestMcpConfirmation({
    requestId: overrides.requestId ?? "req-1",
    actionId: "worktree.delete",
    actionTitle: overrides.actionTitle ?? "Delete worktree",
    actionDescription: "Permanently delete a worktree.",
    argsSummary: overrides.argsSummary ?? '{"worktreeId":"wt-1"}',
    danger: overrides.danger ?? "confirm",
    callerInfo: overrides.callerInfo,
    ...(overrides.sessionOrigin ? { sessionOrigin: overrides.sessionOrigin } : {}),
    ...(overrides.subject ? { subject: overrides.subject } : {}),
    ...(overrides.dangerRationale ? { dangerRationale: overrides.dangerRationale } : {}),
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.previewTitle ? { previewTitle: overrides.previewTitle } : {}),
    ...(overrides.previewPending ? { previewPending: overrides.previewPending } : {}),
    ...(overrides.typedNameTarget ? { typedNameTarget: overrides.typedNameTarget } : {}),
    ...(overrides.selectableTargets
      ? {
          selectableTargets: overrides.selectableTargets,
          selectionConfirmLabel: { verb: "Kill", one: "terminal", many: "terminals" },
        }
      : {}),
  });
}

const BATCH_TARGETS = [
  {
    id: "t1",
    name: "claude · api",
    worktree: "feature/x",
    kindLabel: "Claude",
    agentRunning: true,
  },
  { id: "t2", name: "zsh", worktree: "feature/x", kindLabel: "Terminal", agentRunning: false },
  { id: "t3", name: "vitest", kindLabel: "Terminal", agentRunning: false },
];

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

  describe("selectable target checklist (#12123)", () => {
    it("starts with every target checked and names the count on the confirm button", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ actionTitle: "Kill terminals", selectableTargets: BATCH_TARGETS });
        render(<McpConfirmDialog />);
        act(() => {
          vi.advanceTimersByTime(1200);
        });

        const boxes = screen.getAllByRole("checkbox");
        expect(boxes).toHaveLength(3);
        for (const box of boxes) expect(box.getAttribute("aria-checked")).toBe("true");
        expect(screen.getByText("3 of 3 selected")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Kill 3 terminals" })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("tells two identically-titled targets apart by id", () => {
      void enqueue({
        actionTitle: "Kill terminals",
        selectableTargets: [
          {
            id: "panel-aaa111",
            name: "zsh",
            worktree: "feature/x",
            kindLabel: "Terminal",
            agentRunning: false,
          },
          {
            id: "panel-bbb222",
            name: "zsh",
            worktree: "feature/x",
            kindLabel: "Terminal",
            agentRunning: false,
          },
        ],
      });
      render(<McpConfirmDialog />);

      // Same title, same worktree, same kind — without the id the two rows are
      // one checkbox as far as anyone reading them is concerned.
      expect(screen.getByRole("checkbox", { name: /aaa111/ })).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: /bbb222/ })).toBeTruthy();
    });

    it("lengthens the shown id when two targets share a tail", () => {
      void enqueue({
        actionTitle: "Kill terminals",
        selectableTargets: [
          { id: "alpha-cafe01", name: "zsh", kindLabel: "Terminal", agentRunning: false },
          { id: "bravo-cafe01", name: "zsh", kindLabel: "Terminal", agentRunning: false },
        ],
      });
      render(<McpConfirmDialog />);

      // A fixed six-character tail would render both rows as "…cafe01" — the
      // same failure as showing no id, wearing the appearance of a fix.
      const names = screen
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("aria-labelledby"))
        .map((id) => (id === null ? "" : (document.getElementById(id)?.textContent ?? "")));
      expect(names).toHaveLength(2);
      expect(names[0]).not.toBe(names[1]);
    });

    it("names each target by its own row so the boxes are told apart", () => {
      void enqueue({ actionTitle: "Kill terminals", selectableTargets: BATCH_TARGETS });
      render(<McpConfirmDialog />);

      // The row text is the checkbox's accessible name — worktree, kind and the
      // running-agent badge included.
      expect(
        screen.getByRole("checkbox", { name: /claude · api/ }).getAttribute("aria-label")
      ).toBe(null);
      expect(screen.getByRole("checkbox", { name: /Agent running/ })).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: /feature\/x · Terminal/ })).toBeTruthy();
    });

    it("approves only the rows left checked, in display order", async () => {
      vi.useFakeTimers();
      try {
        const pending = enqueue({
          actionTitle: "Kill terminals",
          selectableTargets: BATCH_TARGETS,
        });
        render(<McpConfirmDialog />);
        act(() => {
          vi.advanceTimersByTime(1200);
        });

        act(() => {
          fireEvent.click(screen.getByRole("checkbox", { name: /zsh/ }));
        });
        expect(screen.getByRole("button", { name: "Kill 2 terminals" })).toBeTruthy();

        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Kill 2 terminals" }));
        });

        await expect(pending).resolves.toEqual({
          decision: "approved",
          selectedTargetIds: ["t1", "t3"],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("singularises the button when one target is left", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ actionTitle: "Kill terminals", selectableTargets: BATCH_TARGETS });
        render(<McpConfirmDialog />);
        act(() => {
          vi.advanceTimersByTime(1200);
        });

        act(() => {
          fireEvent.click(screen.getByRole("checkbox", { name: /zsh/ }));
          fireEvent.click(screen.getByRole("checkbox", { name: /vitest/ }));
        });

        expect(screen.getByRole("button", { name: "Kill 1 terminal" })).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses to approve an empty selection and says why", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ actionTitle: "Kill terminals", selectableTargets: BATCH_TARGETS });
        render(<McpConfirmDialog />);
        act(() => {
          vi.advanceTimersByTime(1200);
        });

        act(() => {
          for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
        });

        const confirmBtn = screen.getByRole("button", { name: "Kill 0 terminals" });
        expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText(/Nothing selected/)).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("is a dialog, not an alertdialog, because the list is interactive", () => {
      void enqueue({ actionTitle: "Kill terminals", selectableTargets: BATCH_TARGETS });
      render(<McpConfirmDialog />);

      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("does not carry one batch's unchecked rows into the next promoted request", async () => {
      vi.useFakeTimers();
      try {
        const first = enqueue({
          requestId: "a",
          actionTitle: "Kill terminals",
          selectableTargets: BATCH_TARGETS,
        });
        const second = enqueue({
          requestId: "b",
          actionTitle: "Kill terminals",
          selectableTargets: BATCH_TARGETS,
        });
        render(<McpConfirmDialog />);
        act(() => {
          vi.advanceTimersByTime(1200);
        });

        act(() => {
          fireEvent.click(screen.getByRole("checkbox", { name: /zsh/ }));
        });
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Kill 2 terminals" }));
        });
        await expect(first).resolves.toEqual({
          decision: "approved",
          selectedTargetIds: ["t1", "t3"],
        });

        // The second request is now current. Its rows must all be checked again.
        act(() => {
          vi.advanceTimersByTime(1200);
        });
        expect(screen.getByRole("button", { name: "Kill 3 terminals" })).toBeTruthy();
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Kill 3 terminals" }));
        });
        await expect(second).resolves.toEqual({
          decision: "approved",
          selectedTargetIds: ["t1", "t2", "t3"],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports no selection when the request is cancelled", async () => {
      const pending = enqueue({
        actionTitle: "Kill terminals",
        selectableTargets: BATCH_TARGETS,
      });
      render(<McpConfirmDialog />);

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });

      await expect(pending).resolves.toEqual({ decision: "rejected" });
    });
  });

  /**
   * The D3 typed-name gate for an agent-dispatched force delete (#12115).
   *
   * The store field is set by the bridge from the renderer's own worktree
   * record; the dialog's only job is to hand it to `ConfirmDialog` on the
   * destructive arm, where the union admits it.
   */
  it("holds a force delete behind the typed-name gate until the name matches", async () => {
    vi.useFakeTimers();
    try {
      void enqueue({ actionTitle: "Delete worktree", typedNameTarget: "feature/x" });
      render(<McpConfirmDialog />);

      // Past the cooldown, which independently disables the button — without
      // this the assertion would pass with the gate removed entirely.
      act(() => {
        vi.advanceTimersByTime(1200);
      });

      const confirmBtn = screen.getByRole("button", {
        name: "Delete worktree",
      }) as HTMLButtonElement;
      const input = screen.getByLabelText("Type feature/x to confirm") as HTMLInputElement;
      expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");

      act(() => {
        fireEvent.change(input, { target: { value: "feature/" } });
      });
      expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");

      act(() => {
        fireEvent.change(input, { target: { value: "feature/x" } });
      });
      expect(confirmBtn.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("renders no typed-name gate for a dispatch the bridge did not gate", () => {
    vi.useFakeTimers();
    try {
      // An absent target must approve on zero keystrokes — and an EMPTY one
      // must too, rather than rendering an input nobody can satisfy (#7493 is
      // the inverse: an empty target silently disabling the gate that was
      // supposed to be there, which is why the bridge refuses to emit one).
      void enqueue({ actionTitle: "Delete worktree" });
      render(<McpConfirmDialog />);
      act(() => {
        vi.advanceTimersByTime(1200);
      });

      expect(screen.queryByLabelText(/to confirm$/)).toBeNull();
      const confirmBtn = screen.getByRole("button", { name: "Delete worktree" });
      expect(confirmBtn.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("never attaches the gate to a non-destructive dispatch", () => {
    // `ConfirmDialog` coerces `typedNameTarget` away off the destructive
    // variant, and the dialog only passes it on that arm — belt and braces,
    // because a safe read-only dispatch demanding a typed name is nonsense.
    void enqueue({ actionTitle: "List worktrees", danger: "safe", typedNameTarget: "feature/x" });
    render(<McpConfirmDialog />);

    expect(screen.queryByLabelText(/to confirm$/)).toBeNull();
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
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("status", { name: /checking what this affects/i })).toBeTruthy();

      // Only the preview landing unblocks it.
      act(() => {
        useMcpConfirmStore.getState().setPreview("req-pending", ["No uncommitted changes."]);
      });
      expect(
        screen.getByRole("button", { name: "Delete worktree" }).hasAttribute("aria-disabled")
      ).toBe(false);
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
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("…1234")).toBeTruthy();
  });

  // The client-supplied name leads and the token trails: the user agent is what
  // a human recognises, the token suffix is the corroborating detail.
  it("orders the caller's own name before the token suffix", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      callerInfo: { token4LastChars: "1234", userAgent: "Claude Code" },
    });
    render(<McpConfirmDialog />);

    // AppDialog portals to document.body, so render()'s container is empty.
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Claude Code")).toBeGreaterThan(-1);
    expect(text.indexOf("Claude Code")).toBeLessThan(text.indexOf("…1234"));
  });

  // The row is never dropped: its absence used to shift everything below it
  // whenever a queued item promoted across origins, and left the most trusted
  // caller looking like a missing section.
  it("names the assistant instead of dropping the row when callerInfo is absent", () => {
    void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByText("Daintree Assistant")).toBeTruthy();
  });

  // The security-relevant leg. `callerInfo` is also absent for a session whose
  // token hash was never registered, which dispatches with an "external"
  // origin — that caller must never inherit the assistant's standing.
  it.each([
    ["external", "external"],
    ["missing", undefined],
  ] as const)(
    "does not claim an unidentified caller (%s origin) is the assistant",
    (_label, sessionOrigin) => {
      void enqueue({
        actionTitle: "Delete worktree",
        ...(sessionOrigin ? { sessionOrigin } : {}),
      });
      render(<McpConfirmDialog />);

      expect(screen.getByText("Requested by")).toBeTruthy();
      expect(screen.queryByText("Daintree Assistant")).toBeNull();
      expect(screen.getByText("Unidentified client")).toBeTruthy();
    }
  );

  it("surfaces the action's dangerRationale so the human sees why it's gated (#11342)", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      dangerRationale: "Permanently removes the worktree directory and any uncommitted changes.",
    });
    render(<McpConfirmDialog />);

    expect(
      screen.getByText(/Permanently removes the worktree directory and any uncommitted changes\./)
    ).toBeTruthy();
  });

  it("omits the rationale block entirely when the action carries no dangerRationale", () => {
    void enqueue({ actionTitle: "Delete worktree" });
    render(<McpConfirmDialog />);

    expect(screen.queryByText("Why this is gated")).toBeNull();
    expect(screen.queryByText("What this does")).toBeNull();
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

      await expect(pA).resolves.toEqual({ decision: "approved" });

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
      void enqueue({ actionTitle: "List worktrees", danger: "safe" });
      render(<McpConfirmDialog />);

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
      const pA = enqueue({ requestId: "A", actionTitle: "Delete worktree", danger: "confirm" });
      void enqueue({ requestId: "B", actionTitle: "Reset branch", danger: "confirm" });

      render(<McpConfirmDialog />);

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
      await expect(pA).resolves.toEqual({ decision: "approved" });

      // Item B is now promoted into the same mounted dialog — its cooldown
      // must arm afresh so a click meant for A can't approve B.
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
      render(<McpConfirmDialog />); // current === null, dialog mounted closed

      act(() => {
        void enqueue({ actionTitle: "Delete worktree", danger: "confirm" });
      });

      // The false→true transition must arm synchronously (useLayoutEffect), so
      // the button is already disabled without advancing any timers.
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
      await expect(pA).resolves.toEqual({ decision: "approved" });

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

  // #11981 — the decisive evidence and the incidental payload must not be
  // interchangeable. The rule is that the preview is shown and the arguments
  // are not, until asked for; not which classes either one carries.
  it("shows the preview outright but keeps the arguments behind a disclosure", () => {
    void enqueue({ preview: ["3 files with uncommitted changes:", "  M  src/App.tsx"] });
    render(<McpConfirmDialog />);

    expect(screen.getByText(/src\/App\.tsx/)).toBeTruthy();

    const disclosure = screen.getByRole("button", { name: /arguments/i });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/wt-1/)).toBeNull();

    act(() => {
      disclosure.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/wt-1/)).toBeTruthy();
  });

  // #11981 — an empty array means the fetch ran and produced nothing, which is
  // NOT the same as an action that never had a preview target. Dropping the
  // section for both made a D2 approval with no content evidence look identical
  // to one that needed none.
  it("keeps the preview section present and explicit when the fetch returns nothing", () => {
    void enqueue({ requestId: "req-empty", previewPending: true });
    render(<McpConfirmDialog />);

    act(() => {
      useMcpConfirmStore.getState().setPreview("req-empty", []);
    });

    expect(screen.getByText("Working tree changes")).toBeTruthy();
    expect(screen.getByText(/Couldn't check what this affects/)).toBeTruthy();
  });

  it("renders no preview section at all when the action never had a preview target", () => {
    void enqueue({ actionTitle: "Reload window" });
    render(<McpConfirmDialog />);

    expect(screen.queryByText("Working tree changes")).toBeNull();
    expect(screen.queryByText(/Couldn't check what this affects/)).toBeNull();
  });

  // #11981 — APG reserves alertdialog for a brief, important message. A body
  // carrying a scrollable file list is a dialog. Every sibling confirm that
  // shows a preview already passes hasPreview.
  it("is a dialog rather than an alertdialog once it carries preview or argument content", () => {
    void enqueue({ preview: ["No uncommitted changes."] });
    const { unmount } = render(<McpConfirmDialog />);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();

    unmount();
    __resetMcpConfirmStoreForTesting();

    // Nothing scrollable in the body — the brief-message case alertdialog is for.
    void enqueue({ actionTitle: "Reload window", argsSummary: "" });
    render(<McpConfirmDialog />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  // #11981 — the caution marker is a rendering instruction, not content. It
  // used to reach the user as a bare glyph inside a monospace block, at the
  // same weight as a filename.
  it("renders a caution preview line as a warning rather than emitting its marker as text", () => {
    void enqueue({
      preview: ["\u26A0 Could not verify current changes — proceed with caution."],
    });
    render(<McpConfirmDialog />);

    expect(screen.getByText(/Could not verify current changes/)).toBeTruthy();
    // document.body, not render()'s container: AppDialog portals, so asserting
    // on the container would pass whether or not the glyph was emitted.
    expect(document.body.textContent).not.toContain("\u26A0");
  });

  // #11981 — resolving this dialog immediately promotes the next request into
  // the same modal at the same coordinates. The user has to be able to see that
  // is about to happen.
  it("names how many requests are waiting, and says nothing when none are", () => {
    void enqueue({ requestId: "A" });
    const { unmount } = render(<McpConfirmDialog />);
    expect(screen.queryByText(/waiting/)).toBeNull();

    unmount();
    __resetMcpConfirmStoreForTesting();

    void enqueue({ requestId: "A" });
    void enqueue({ requestId: "B" });
    void enqueue({ requestId: "C" });
    render(<McpConfirmDialog />);

    expect(screen.getByText(/2 more requests waiting/)).toBeTruthy();
  });

  // #11981 — a ticking countdown on a security decision pushes the reader into
  // impulsive rather than deliberative processing, so the 28s expiry stays
  // silent. Guard against a well-meaning countdown being added later.
  it("does not display a running countdown of the approval deadline", async () => {
    vi.useFakeTimers();
    try {
      void enqueue({ requestId: "req-timer" });
      render(<McpConfirmDialog />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      // document.body, not render()'s container: AppDialog portals, so a
      // container assertion here would hold no matter what was rendered.
      const text = document.body.textContent ?? "";
      expect(text).toContain("Delete worktree");
      // No "Ns"/"N seconds"/"N:NN" remaining-time readout anywhere on the surface.
      expect(text).not.toMatch(/\d+\s*(s\b|sec|second)/i);
      expect(text).not.toMatch(/\d+:\d{2}/);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  // #11981 — the cooldown floor must not push the modal past main's own 30s
  // deadline. An item promoted at ~29s used to stay open to 30.5s and re-enable
  // its confirm button at 30.2s, after main had already failed the dispatch and
  // told the agent it timed out — so a click ran the destructive action anyway.
  it("never leaves approval possible after main's dispatch deadline has passed", async () => {
    vi.useFakeTimers();
    try {
      const p = enqueue({ actionTitle: "Delete worktree", danger: "confirm" });

      // ~29s spent queued behind earlier modals before promotion.
      act(() => {
        vi.advanceTimersByTime(29_000);
      });
      render(<McpConfirmDialog />);

      // Run out the remaining budget to main's deadline and no further.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      await expect(p).resolves.toEqual({ decision: "timeout" });
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  // #11981 — "Run 'Delete worktree'?" names the registry action but not which
  // worktree, and under multi-agent interruption the target is what the
  // approver most needs and can least infer.
  it("names the affected entity in the title when one resolved", () => {
    void enqueue({ actionTitle: "Delete worktree", subject: "feature/agent-fanout" });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Delete worktree 'feature/agent-fanout'?")).toBeTruthy();
  });

  // A title that changes after open is worse than a stable generic one: the
  // dialog's accessible name is not re-announced. Actions whose subject only
  // exists on the async preview keep the generic form.
  it("keeps the stable generic title when no subject resolved", () => {
    void enqueue({ actionTitle: "Push branch" });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Run 'Push branch'?")).toBeTruthy();
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
      expect(btn.getAttribute("aria-disabled")).toBe("true");

      // The 1200ms cooldown must clear before the auto-timeout fires — the old
      // Math.max(500, …) floor would have timed the item out first, making it
      // unapproveable.
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(btn.hasAttribute("aria-disabled")).toBe(false);

      act(() => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await expect(p).resolves.toEqual({ decision: "approved" });
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });
});
