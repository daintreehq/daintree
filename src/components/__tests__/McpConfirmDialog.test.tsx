// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConfirmDialog } from "../McpConfirmDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  __resetMcpConfirmStoreForTesting,
  requestMcpConfirmation,
  useMcpConfirmStore,
  type McpConfirmDeadline,
} from "@/store/mcpConfirmStore";
import {
  MCP_CONFIRM_DECISION_MS,
  MCP_CONFIRM_HOLD_GRACE_MS,
  MCP_CONFIRM_QUEUE_HOLD_MS,
  MCP_DISPATCH_TIMEOUT_MS,
} from "@shared/config/mcpConfirmWindow";
import type { ActionDanger } from "@shared/types/actions";
import type { McpBearerIdentity } from "@shared/types/ipc/mcpServer";
import type { McpConfirmRequester } from "@/store/mcpConfirmStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { WORKTREE_DELETE_BLOCK_COPY } from "@shared/utils/worktreeDeletePreview";
import { registerEscape } from "@/lib/escapeStack";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));

const agentSettingsState = vi.hoisted(() => ({
  globalSkipPermissions: false,
  agents: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {
        globalSkipPermissions: agentSettingsState.globalSkipPermissions,
        agents: agentSettingsState.agents,
      },
    }),
}));

const helpPanelState = vi.hoisted(() => ({
  preferredAgentId: null as string | null,
  activeSlotAgentId: null as string | null,
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: (selector: (state: unknown) => unknown) => selector(helpPanelState),
  selectActiveSlot: (state: typeof helpPanelState) => ({ agentId: state.activeSlotAgentId }),
}));

const loggerMocks = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@/utils/logger", () => loggerMocks);

const pluginClientMock = vi.hoisted(() => ({
  getWorktreeDeleteNoteSources: vi.fn(async () => [] as unknown[]),
  getWorktreeDeleteNotes: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/clients/pluginClient", () => ({ pluginClient: pluginClientMock }));

// Set `defer` to hold a close open until `finish()`, as a real exit animation
// does; otherwise a close finishes at once.
const presence = vi.hoisted(() => ({ defer: false, finish: null as (() => void) | null }));
vi.mock("@/hooks/useAnimatedPresence", async () => {
  const { useEffect, useRef, useState } = await import("react");
  return {
    // A close still reports that it finished, which is when a dialog hands
    // focus back and runs its close-complete step.
    useAnimatedPresence: ({
      isOpen,
      onAnimateOut,
    }: {
      isOpen: boolean;
      onAnimateOut?: () => void;
    }) => {
      const wasOpen = useRef(isOpen);
      // Rendered from opening until a deferred close finishes, as the real
      // hook keeps it, so an exit never unmounts the dialog early.
      const [rendered, setRendered] = useState(isOpen);
      if (isOpen && !rendered) setRendered(true);
      useEffect(() => {
        if (isOpen) {
          // Reopened mid-exit: the close that was under way never finishes.
          presence.finish = null;
        } else if (wasOpen.current) {
          if (presence.defer) {
            presence.finish = () => {
              presence.finish = null;
              setRendered(false);
              onAnimateOut?.();
            };
          } else {
            setRendered(false);
            onAnimateOut?.();
          }
        }
        wasOpen.current = isOpen;
      }, [isOpen, onAnimateOut]);
      return { isVisible: isOpen, shouldRender: isOpen || (presence.defer && rendered) };
    },
  };
});

const requesterMocks = vi.hoisted(() => ({
  live: { present: true } as { present: boolean; otherWorktreeName?: string },
  show: vi.fn(async (_identity: unknown) => true),
}));
vi.mock("@/lib/mcpConfirmRequester", () => ({
  useMcpRequesterLiveState: () => requesterMocks.live,
  showMcpRequester: requesterMocks.show,
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
    sessionOrigin?: "help" | "external";
    argsSummary?: string;
    subject?: string;
    typedNameTarget?: string;
    offerSessionApproval?: boolean;
    approvalReason?: "above-tier";
    worktreeDeleteNotesTargetId?: string;
    requester?: McpConfirmRequester;
    selectableTargets?: {
      id: string;
      name: string;
      worktree?: string;
      kindLabel: string;
      agentRunning: boolean;
    }[];
  } = {},
  deadline?: McpConfirmDeadline
) {
  return requestMcpConfirmation(
    {
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
      ...(overrides.offerSessionApproval ? { offerSessionApproval: true } : {}),
      ...(overrides.approvalReason ? { approvalReason: overrides.approvalReason } : {}),
      ...(overrides.requester ? { requester: overrides.requester } : {}),
      ...(overrides.worktreeDeleteNotesTargetId
        ? { worktreeDeleteNotesTargetId: overrides.worktreeDeleteNotesTargetId }
        : {}),
      ...(overrides.selectableTargets
        ? {
            selectableTargets: overrides.selectableTargets,
            selectionConfirmLabel: { verb: "Kill", one: "terminal", many: "terminals" },
          }
        : {}),
    },
    deadline
  );
}

/**
 * Main's side of a dispatch's deadline, as `holdDispatch` keeps it (#14989):
 * the plain deadline from the send, held while it waits, and a fresh decision
 * window once it is on screen. `refuse` makes main answer as if the call had
 * already gone.
 */
function mainDeadline(options: { refuse?: boolean } = {}): McpConfirmDeadline & {
  phases: string[];
} {
  let deadlineAt = Date.now() + MCP_DISPATCH_TIMEOUT_MS;
  const phases: string[] = [];
  return {
    deadlineAt,
    phases,
    hold: async (phase) => {
      phases.push(phase);
      const now = Date.now();
      if (options.refuse || now >= deadlineAt) return null;
      deadlineAt =
        phase === "queued"
          ? Math.max(deadlineAt, now + MCP_CONFIRM_QUEUE_HOLD_MS)
          : now + MCP_CONFIRM_DECISION_MS + MCP_CONFIRM_HOLD_GRACE_MS;
      return deadlineAt - now;
    },
  };
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

const helpAssistantApi: {
  getSettings: ReturnType<typeof vi.fn>;
  setSettings: ReturnType<typeof vi.fn>;
} = { getSettings: vi.fn(), setSettings: vi.fn() };

describe("McpConfirmDialog", () => {
  beforeEach(() => {
    __resetMcpConfirmStoreForTesting();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      })
    );
    agentSettingsState.globalSkipPermissions = false;
    agentSettingsState.agents = {};
    helpPanelState.preferredAgentId = null;
    helpPanelState.activeSlotAgentId = null;
    loggerMocks.logError.mockReset();
    requesterMocks.live = { present: true };
    presence.defer = false;
    presence.finish = null;
    requesterMocks.show.mockReset();
    requesterMocks.show.mockResolvedValue(true);
    helpAssistantApi.getSettings = vi.fn().mockResolvedValue({ daintreeConfirmations: "inherit" });
    helpAssistantApi.setSettings = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("electron", { helpAssistant: helpAssistantApi });
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
    cleanup();
    vi.restoreAllMocks();
  });

  describe("a confirmation nobody had on screen (#13392)", () => {
    let visibility: DocumentVisibilityState;
    beforeEach(() => {
      visibility = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
    });
    afterEach(() => {
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    it("times out as unseen when its window was never on screen", async () => {
      vi.useFakeTimers();
      try {
        const deadline = mainDeadline();
        const pending = enqueue({}, deadline);
        render(<McpConfirmDialog />);
        // Held while the view stays hidden, and never granted a decision window.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_QUEUE_HOLD_MS - 5_000);
        });
        await expectStillPending(pending);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(await pending).toEqual({ decision: "timeout", unseen: true });
        expect(deadline.phases).toEqual(["queued"]);
        expect(useMcpConfirmStore.getState().current).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("remembers it was seen when a preview lands after the view went hidden", async () => {
      vi.useFakeTimers();
      try {
        visibility = "visible";
        const pending = enqueue({ requestId: "req-preview", previewPending: true }, mainDeadline());
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        visibility = "hidden";
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
          useMcpConfirmStore.getState().setPreview("req-preview", { lines: ["worktree wt-1"] });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });
        expect(await pending).toEqual({ decision: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("is an ordinary timeout once its window came on screen while it asked", async () => {
      vi.useFakeTimers();
      try {
        const pending = enqueue({}, mainDeadline());
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        visibility = "visible";
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        // The minute it spent hidden did not come out of its window.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS - 1_000);
        });
        await expectStillPending(pending);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(await pending).toEqual({ decision: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("decision window (#14989)", () => {
    it("does not charge a queued request for the time it waited behind another", async () => {
      vi.useFakeTimers();
      try {
        const firstDeadline = mainDeadline();
        const secondDeadline = mainDeadline();
        const first = enqueue(
          { requestId: "req-first", actionTitle: "Delete worktree" },
          firstDeadline
        );
        const second = enqueue(
          { requestId: "req-second", actionTitle: "Push branch" },
          secondDeadline
        );
        render(<McpConfirmDialog />);
        // Long past the plain deadline both dispatches started with.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(90_000);
        });
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        });
        expect(await first).toEqual({ decision: "rejected" });
        expect(screen.getByText("Run 'Push branch'?")).toBeTruthy();

        // A whole window from the moment it was shown, less nothing for the wait.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS - 1_000);
        });
        await expectStillPending(second);
        expect(secondDeadline.phases).toEqual(["queued", "shown"]);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(await second).toEqual({ decision: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not renew the window when a preview lands late", async () => {
      vi.useFakeTimers();
      try {
        const pending = enqueue(
          { requestId: "req-late-preview", previewPending: true },
          mainDeadline()
        );
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS - 5_000);
        });
        act(() => {
          useMcpConfirmStore.getState().setPreview("req-late-preview", { lines: ["M src/app.ts"] });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(await pending).toEqual({ decision: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps an expired request with nothing behind it up, inert, until it is closed", async () => {
      vi.useFakeTimers();
      try {
        const expiring = enqueue(
          {
            requestId: "req-expiring",
            actionTitle: "Delete worktree",
            typedNameTarget: "feature/x",
          },
          mainDeadline()
        );
        render(<McpConfirmDialog />);
        // Already mounted, and empty, so the expiry is a change it announces.
        const status = screen.getByRole("status");
        expect(status.textContent).toBe("");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });
        expect(screen.getByRole("status")).toBe(status);
        expect(status.textContent).toContain("nothing ran");

        // The caller hears at once; the person still sees what they were answering.
        expect(await expiring).toEqual({ decision: "timeout" });
        expect(screen.getByText("Run 'Delete worktree'?")).toBeTruthy();
        expect(document.body.textContent).toContain("Timed out before an answer, so nothing ran");
        const confirm = screen.getByRole("button", { name: "Delete worktree" });
        expect(confirm.getAttribute("aria-disabled")).toBe("true");
        act(() => {
          fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature/x" } });
          fireEvent.click(confirm);
        });
        // Typing the name and clicking answers nothing: it already timed out.
        expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-expiring");

        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Close" }));
        });
        expect(useMcpConfirmStore.getState().current).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("brings up the next request as soon as the one on screen expires, and says the earlier one expired (#15700)", async () => {
      vi.useFakeTimers();
      try {
        const expiring = enqueue(
          { requestId: "req-expiring", actionTitle: "Delete worktree", subject: "feature/x" },
          mainDeadline()
        );
        const nextDeadline = mainDeadline();
        const next = enqueue(
          { requestId: "req-next", actionTitle: "Push branch", danger: "safe" },
          nextDeadline
        );
        render(<McpConfirmDialog />);
        const status = screen.getByRole("status");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });

        expect(await expiring).toEqual({ decision: "timeout" });
        // Nobody closed anything: the next request is up, and it is the one asking.
        expect(screen.getByText("Run 'Push branch'?")).toBeTruthy();
        expect(screen.queryByText("Delete worktree 'feature/x'?")).toBeNull();
        expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
        const notice =
          "The previous request, Delete worktree 'feature/x', timed out before an answer, so nothing ran";
        expect(screen.getByText(notice)).toBeTruthy();
        // Said once through the announcer; the status line is for this request's own expiry.
        expect(useAnnouncerStore.getState().polite?.msg).toBe(
          `${notice}. Now asking: Run 'Push branch'?`
        );
        expect(screen.getByRole("status")).toBe(status);
        expect(status.textContent).toBe("");
        expect(nextDeadline.phases).toEqual(["queued", "shown"]);

        // Brought up under a pointer that may have been aimed at the request
        // that expired, so even a safe request starts with its button held,
        // and focus lands on Cancel rather than the arguments ahead of it.
        const confirm = screen.getByRole("button", { name: "Push branch" });
        expect(confirm.getAttribute("aria-disabled")).toBe("true");
        act(() => {
          fireEvent.click(confirm);
        });
        await expectStillPending(next);
        expect(confirm.getAttribute("aria-disabled")).toBe("true");
        expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_200 - PENDING_PROBE_MS);
        });
        expect(confirm.hasAttribute("aria-disabled")).toBe(false);

        // A whole window of its own, from the moment it came up.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS - 1_200 - 1_000);
        });
        await expectStillPending(next);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(await next).toEqual({ decision: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("brings up a request that arrives while an expired one is up, and says the earlier one expired (#15700)", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ requestId: "req-expiring", actionTitle: "Delete worktree" }, mainDeadline());
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });
        expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

        let arriving!: ReturnType<typeof enqueue>;
        await act(async () => {
          arriving = enqueue(
            { requestId: "req-arriving", actionTitle: "Push branch", danger: "safe" },
            mainDeadline()
          );
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(screen.getByText("Run 'Push branch'?")).toBeTruthy();
        expect(
          screen.getByText(
            "The previous request, 'Delete worktree', timed out before an answer, so nothing ran"
          )
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
        await expectStillPending(arriving);
      } finally {
        vi.useRealTimers();
      }
    });

    it("announces each request brought up by an expiry, even when the words repeat (#15700)", () => {
      void enqueue({ requestId: "req-a", actionTitle: "Push", danger: "safe" });
      void enqueue({ requestId: "req-b", actionTitle: "Push", danger: "safe" });
      void enqueue({ requestId: "req-c", actionTitle: "Push", danger: "safe" });
      render(<McpConfirmDialog />);

      act(() => {
        useMcpConfirmStore.getState().expire("req-a");
      });
      const first = useAnnouncerStore.getState().polite;
      act(() => {
        useMcpConfirmStore.getState().expire("req-b");
      });
      const second = useAnnouncerStore.getState().polite;

      expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-c");
      expect(first?.msg).toContain("The previous request, 'Push', timed out");
      expect(second?.msg).toBe(first?.msg);
      expect(second?.id).toBeGreaterThan(first?.id ?? Infinity);
    });

    it("never approves the next request with a press that began on the one that expired (#15700)", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ requestId: "req-expiring", actionTitle: "Push", danger: "safe" });
        const next = enqueue({ requestId: "req-next", actionTitle: "Push", danger: "safe" });
        render(<McpConfirmDialog />);
        const confirm = screen.getByRole("button", { name: "Push" });

        // Pressed while the first was up, held through the swap and the cooldown.
        fireEvent.pointerDown(confirm);
        act(() => {
          useMcpConfirmStore.getState().expire("req-expiring");
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_300);
        });
        expect(screen.getByRole("button", { name: "Push" })).toBe(confirm);
        expect(confirm.hasAttribute("aria-disabled")).toBe(false);
        act(() => {
          fireEvent.click(confirm);
        });
        await expectStillPending(next);

        // A press that begins on the request now up answers it.
        fireEvent.pointerDown(confirm);
        act(() => {
          fireEvent.click(confirm);
        });
        expect(await next).toEqual({ decision: "approved" });
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it("lets a click with no press of its own approve after a finished press on an earlier request (#15700)", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ requestId: "req-expiring", actionTitle: "Push", danger: "safe" });
        const next = enqueue({ requestId: "req-next", actionTitle: "Push", danger: "safe" });
        render(<McpConfirmDialog />);
        const description = screen.getByText("Permanently delete a worktree.");
        fireEvent.pointerDown(description);
        fireEvent.click(description);

        act(() => {
          useMcpConfirmStore.getState().expire("req-expiring");
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_300);
        });
        // An assistive "press": a click with no pointer behind it.
        act(() => {
          screen.getByRole("button", { name: "Push" }).click();
        });

        expect(await next).toEqual({ decision: "approved" });
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it("never answers the request brought up in place of one that expired with a click meant for it (#15700)", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ requestId: "req-expiring", actionTitle: "Push", danger: "safe" });
        const next = enqueue({ requestId: "req-next", actionTitle: "Push", danger: "safe" });
        render(<McpConfirmDialog />);
        const aimed = screen.getByRole("button", { name: "Push" });
        expect(aimed.hasAttribute("aria-disabled")).toBe(false);

        // The expiry and the click land back to back, before any re-render.
        act(() => {
          useMcpConfirmStore.getState().expire("req-expiring");
          aimed.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-next");
        await expectStillPending(next);
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it("ends a request main no longer holds as soon as it says so", async () => {
      vi.useFakeTimers();
      try {
        const pending = enqueue({}, mainDeadline({ refuse: true }));
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(await pending).toEqual({ decision: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });
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
      expect(screen.getByRole("checkbox", { name: /feature\/x Terminal t2$/ })).toBeTruthy();
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

  it("asks the plugins about the worktree without holding the approval for them (#13805)", async () => {
    vi.useFakeTimers();
    pluginClientMock.getWorktreeDeleteNoteSources.mockResolvedValueOnce([
      { pluginId: "acme.sync", pluginName: "Acme Sync" },
    ]);
    try {
      void enqueue({ actionTitle: "Delete worktree", worktreeDeleteNotesTargetId: "wt-1" });
      render(<McpConfirmDialog />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });

      expect(pluginClientMock.getWorktreeDeleteNotes).toHaveBeenCalledWith("wt-1", "acme.sync");
      expect(screen.getByTestId("worktree-delete-note-pending").textContent).toBe(
        "Checking with Acme Sync…"
      );
      const confirmBtn = screen.getByRole("button", { name: "Delete worktree" });
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

  // #16436: the host throws on these before it reads `force`, so the dialog
  // must not offer an approval, or a typed name, that could only end in a toast.
  describe("a delete the host refuses outright (#16436)", () => {
    const HELD_LINES = [
      "No uncommitted changes in the worktree itself.",
      "⚠ 1 commit inside submodules is on no remote this clone knows about — the worktree cannot be deleted until it is pushed:",
      "  a1b2c3d Vendored fix",
    ];

    it("offers only Cancel, says why, and puts up no typed-name gate", async () => {
      vi.useFakeTimers();
      try {
        // Enqueued carrying a gate as well, so only the dialog stands between
        // the refusal and a typed-name input; `setPreview` never pairs them.
        const pending = requestMcpConfirmation({
          requestId: "req-held",
          actionId: "worktree.delete",
          actionTitle: "Delete worktree",
          actionDescription: "Permanently delete a worktree.",
          argsSummary: '{"worktreeId":"wt-1","force":true}',
          danger: "confirm",
          preview: HELD_LINES,
          typedNameTarget: "feature/x",
          worktreeDeleteBlock: "at-risk-commits",
        });
        render(<McpConfirmDialog />);
        // Past the cooldown, which would otherwise disable the button on its own.
        act(() => {
          vi.advanceTimersByTime(1200);
        });

        expect(screen.queryByLabelText(/to confirm$/)).toBeNull();
        const copy = WORKTREE_DELETE_BLOCK_COPY["at-risk-commits"];
        expect(screen.getByText(copy.title)).toBeTruthy();
        expect(screen.getByText(copy.hint)).toBeTruthy();
        const confirmBtn = screen.getByRole("button", { name: "Delete worktree" });
        expect(confirmBtn.getAttribute("aria-disabled")).toBe("true");
        // No Retry without a fetch to re-run.
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

        act(() => {
          fireEvent.click(confirmBtn);
        });
        await expectStillPending(pending);

        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        });
        await expect(pending).resolves.toEqual({ decision: "rejected" });
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it("re-checks on Retry, keeps the refusal up while it reads, and reopens approval once it clears", async () => {
      vi.useFakeTimers();
      try {
        const retry = vi.fn();
        void requestMcpConfirmation(
          {
            requestId: "req-retry",
            actionId: "worktree.delete",
            actionTitle: "Delete worktree",
            actionDescription: "Permanently delete a worktree.",
            argsSummary: '{"worktreeId":"wt-1"}',
            danger: "confirm",
            previewPending: true,
          },
          undefined,
          { retryPreview: retry }
        );
        render(<McpConfirmDialog />);
        const held = {
          lines: ["⚠ Could not finish checking this worktree's submodules."],
          worktreeDeleteBlock: "unverified" as const,
        };
        act(() => {
          useMcpConfirmStore.getState().setPreview("req-retry", held);
        });
        act(() => {
          vi.advanceTimersByTime(1200);
        });
        const title = WORKTREE_DELETE_BLOCK_COPY.unverified.title;
        expect(screen.getByText(title)).toBeTruthy();
        const confirmBtn = () => screen.getByRole("button", { name: "Delete worktree" });
        const pressRetry = () => {
          const retryBtn = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
          act(() => {
            retryBtn.focus();
            fireEvent.click(retryBtn);
          });
        };

        // A re-check that finds the same refusal still says what it found.
        pressRetry();
        const beforeAnswer = useAnnouncerStore.getState().polite;
        act(() => {
          useMcpConfirmStore.getState().setPreview("req-retry", held);
        });
        const stillBlocked = useAnnouncerStore.getState().polite;
        expect(stillBlocked).not.toBe(beforeAnswer);
        expect(stillBlocked?.msg).toMatch(/still blocked/);
        expect(confirmBtn().getAttribute("aria-disabled")).toBe("true");

        pressRetry();
        expect(retry).toHaveBeenCalledTimes(2);
        // The refusal stays up while the re-check reads, and approval stays shut.
        expect(screen.getByText(title)).toBeTruthy();
        expect(screen.getByText("Checking again")).toBeTruthy();
        expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(
          true
        );
        expect(confirmBtn().getAttribute("aria-disabled")).toBe("true");
        // Nothing is announced until the answer lands.
        expect(useAnnouncerStore.getState().polite).toBe(stillBlocked);

        act(() => {
          useMcpConfirmStore
            .getState()
            .setPreview("req-retry", { lines: ["No uncommitted changes."] });
        });

        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        expect(confirmBtn().hasAttribute("aria-disabled")).toBe(false);
        expect(useAnnouncerStore.getState().polite?.msg).toMatch(/no longer blocked/);
        // The Retry that had focus went with the refusal.
        expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });
  });

  // #12692: an agent pane is asked, not refused, above its tier — and may keep
  // allowing the tool for the rest of the session.
  describe("agent-pane approval (#12692)", () => {
    it("offers the session scope only when main said so, unchecked", () => {
      void enqueue({ offerSessionApproval: true, danger: "safe", actionTitle: "Push" });
      render(<McpConfirmDialog />);

      const box = screen.getByRole("checkbox", { name: "Allow for this session" });
      expect(box.getAttribute("aria-checked")).toBe("false");
      expect(screen.getByText("Agent in a terminal panel")).toBeTruthy();
    });

    it("renders no session option for any other requester", () => {
      void enqueue({ danger: "safe" });
      render(<McpConfirmDialog />);

      expect(screen.queryByRole("checkbox", { name: "Allow for this session" })).toBeNull();
    });

    it("approves for the session when the box is ticked, and once when it is not", async () => {
      const session = enqueue({
        requestId: "a",
        offerSessionApproval: true,
        danger: "safe",
        actionTitle: "Push",
      });
      const once = enqueue({
        requestId: "b",
        offerSessionApproval: true,
        danger: "safe",
        actionTitle: "Push",
      });
      render(<McpConfirmDialog />);

      act(() => {
        fireEvent.click(screen.getByRole("checkbox", { name: "Allow for this session" }));
      });
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Push and allow for session" }));
      });
      await expect(session).resolves.toEqual({ decision: "approved", scope: "session" });

      // The promoted request must not inherit the tick.
      expect(
        screen
          .getByRole("checkbox", { name: "Allow for this session" })
          .getAttribute("aria-checked")
      ).toBe("false");
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Push once" }));
      });
      await expect(once).resolves.toEqual({ decision: "approved" });
    });

    it("says an above-tier request is about reach, not danger", () => {
      void enqueue({ approvalReason: "above-tier", danger: "safe" });
      render(<McpConfirmDialog />);

      expect(screen.getByText(/needs your approval/)).toBeTruthy();
    });
  });

  // #14992: with several agents running, which pane or tab is asking is often
  // what decides the answer, and the user can go and look without answering.
  describe("the requester (#14992)", () => {
    const PANE = {
      identity: { kind: "pane", terminalId: "t-orch" },
      name: "Orchestrator",
      kindLabel: "Claude",
      worktreeId: "wt-2",
      worktreeName: "feature/auth",
    } as const satisfies McpConfirmRequester;

    function requesterRow(): string {
      return screen.getByText("Requested by").parentElement?.textContent ?? "";
    }

    it("names the pane and its agent, and its worktree only when it isn't on screen", () => {
      void enqueue({ offerSessionApproval: true, danger: "safe", requester: PANE });
      const { unmount } = render(<McpConfirmDialog />);
      expect(requesterRow()).toContain("Orchestrator");
      expect(requesterRow()).toContain("Claude");
      expect(requesterRow()).not.toContain("feature/auth");
      unmount();

      // Where the pane is now, not where it was when it asked.
      requesterMocks.live = { present: true, otherWorktreeName: "feature/moved" };
      render(<McpConfirmDialog />);
      expect(requesterRow()).toContain("feature/moved");
      expect(requesterRow()).not.toContain("feature/auth");
      expect(screen.getByRole("button", { name: "Show panel" })).toBeTruthy();
    });

    it("names the pane a session grant would cover", () => {
      void enqueue({
        offerSessionApproval: true,
        danger: "safe",
        actionTitle: "Push",
        requester: PANE,
      });
      render(<McpConfirmDialog />);

      const grant = screen.getByRole("checkbox", { name: "Allow for this session" });
      const description = document.getElementById(grant.getAttribute("aria-describedby") ?? "");
      expect(description?.textContent).toBe(
        "Later Push calls from 'Orchestrator' · any arguments · up to 30 minutes"
      );
    });

    it("names the Assistant tab that asked", () => {
      void enqueue({
        danger: "safe",
        sessionOrigin: "help",
        requester: { identity: { kind: "assistant", helpSessionId: "help-2" }, name: "Session 2" },
      });
      render(<McpConfirmDialog />);

      expect(requesterRow()).toContain("Daintree Assistant");
      expect(requesterRow()).toContain("Session 2");
      expect(screen.getByRole("button", { name: "Show tab" })).toBeTruthy();
    });

    it("says a requester has gone rather than offering to show it", () => {
      requesterMocks.live = { present: false };
      void enqueue({ offerSessionApproval: true, danger: "safe", requester: PANE });
      render(<McpConfirmDialog />);

      expect(requesterRow()).toContain("No longer open");
      expect(screen.queryByRole("button", { name: "Show panel" })).toBeNull();
    });

    it("still names an unnamed pane as a pane when it can't offer the session grant", () => {
      requesterMocks.live = { present: false };
      void enqueue({ danger: "safe", requester: { identity: PANE.identity } });
      render(<McpConfirmDialog />);

      expect(requesterRow()).toContain("Agent in a terminal panel");
      expect(requesterRow()).not.toContain("Unidentified client");
      expect(requesterRow()).not.toContain("No longer open");
    });

    it("steps aside to show the pane, leaving the request unanswered, and comes back to it", async () => {
      vi.useFakeTimers();
      try {
        const pending = enqueue(
          { requestId: "req-show", danger: "safe", actionTitle: "Push", requester: PANE },
          mainDeadline()
        );
        render(<McpConfirmDialog />);

        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
        });
        await act(async () => {
          await Promise.resolve();
        });

        expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
        expect(requesterMocks.show).toHaveBeenCalledWith(PANE.identity);
        const region = screen.getByRole("region", { name: "Approval request" });
        expect(region.textContent).toContain("Run 'Push'?");
        await expectStillPending(pending);

        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Review request" }));
        });
        expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Push" }));
        });
        expect(await pending).toEqual({ decision: "approved" });
        expect(requesterMocks.show).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("goes to the requester only once the dialog has finished closing", async () => {
      presence.defer = true;
      void enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
      render(<McpConfirmDialog />);

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      // Going now would lose focus to the close handing it back.
      expect(requesterMocks.show).not.toHaveBeenCalled();

      act(() => {
        presence.finish?.();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(requesterMocks.show).toHaveBeenCalledWith(PANE.identity);
    });

    it("goes nowhere when the request is brought back before the dialog has closed", async () => {
      presence.defer = true;
      const pending = enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
      render(<McpConfirmDialog />);

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
      });
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Review request" }));
      });
      // Whatever the abandoned exit would have done, it doesn't.
      await act(async () => {
        presence.finish?.();
        await Promise.resolve();
      });

      expect(requesterMocks.show).not.toHaveBeenCalled();
      expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Push" }));
      });
      await expect(pending).resolves.toEqual({ decision: "approved" });
    });

    it("still animates out when an identified request is the last one answered", async () => {
      presence.defer = true;
      const pending = enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
      render(<McpConfirmDialog />);
      const surface = () => document.querySelector('[role="dialog"], [role="alertdialog"]');
      const opened = surface();

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await expect(pending).resolves.toEqual({ decision: "rejected" });
      // The same surface, exiting, not a fresh one.
      expect(opened).not.toBeNull();
      expect(surface()).toBe(opened);

      act(() => {
        presence.finish?.();
      });
      expect(surface()).toBeNull();
    });

    it("comes straight back when the requester can't be reached", async () => {
      requesterMocks.show.mockResolvedValue(false);
      void enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
      render(<McpConfirmDialog />);

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(requesterMocks.show).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
    });

    it("brings the next request up when the one stepped aside from expires (#15700)", async () => {
      vi.useFakeTimers();
      try {
        const expiring = enqueue(
          { requestId: "req-aside", danger: "safe", actionTitle: "Push", requester: PANE },
          mainDeadline()
        );
        const next = enqueue(
          { requestId: "req-next", danger: "safe", actionTitle: "Pull" },
          mainDeadline()
        );
        render(<McpConfirmDialog />);
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });

        expect(await expiring).toEqual({ decision: "timeout" });
        expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
        expect(screen.getByText("Run 'Pull'?")).toBeTruthy();
        expect(
          screen.getByText(
            "The previous request, 'Push', timed out before an answer, so nothing ran"
          )
        ).toBeTruthy();
        await expectStillPending(next);
      } finally {
        vi.useRealTimers();
      }
    });

    it("says again that the previous request expired when the next comes back into view (#15700)", async () => {
      void enqueue({ requestId: "req-expiring", danger: "safe", actionTitle: "Push" });
      void enqueue({ requestId: "req-next", danger: "safe", actionTitle: "Pull", requester: PANE });
      render(<McpConfirmDialog />);
      act(() => {
        useMcpConfirmStore.getState().expire("req-expiring");
      });
      const promoted = useAnnouncerStore.getState().polite;
      expect(promoted?.msg).toContain("The previous request, 'Push', timed out");

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(useAnnouncerStore.getState().polite).toBe(promoted);
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Review request" }));
      });

      const reopened = useAnnouncerStore.getState().polite;
      expect(reopened?.msg).toBe(promoted?.msg);
      expect(reopened?.id).toBeGreaterThan(promoted?.id ?? Infinity);
    });

    it("keeps the request's clock running while it is stepped aside", async () => {
      vi.useFakeTimers();
      try {
        const pending = enqueue(
          { requestId: "req-clock", danger: "safe", actionTitle: "Push", requester: PANE },
          mainDeadline()
        );
        render(<McpConfirmDialog />);
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });

        expect(await pending).toEqual({ decision: "timeout" });
        const region = screen.getByRole("region", { name: "Approval request" });
        expect(region.textContent).toContain("Timed out");
        act(() => {
          fireEvent.click(screen.getByRole("button", { name: "Review request" }));
        });
        expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Show panel" })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("lands initial focus on Cancel rather than the control that steps away", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({ danger: "safe", actionTitle: "Push", argsSummary: "", requester: PANE });
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });

        expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    describe("where focus goes (#16950)", () => {
      let paneInput: HTMLInputElement;
      let paneKeys: ReturnType<typeof vi.fn<(event: KeyboardEvent) => void>>;
      const appended: HTMLElement[] = [];
      function append<T extends HTMLElement>(element: T): T {
        document.body.appendChild(element);
        appended.push(element);
        return element;
      }
      beforeEach(() => {
        // The requester's pane, which takes focus once it has been navigated to.
        paneInput = append(document.createElement("input"));
        paneKeys = vi.fn<(event: KeyboardEvent) => void>();
        paneInput.addEventListener("keydown", paneKeys);
        requesterMocks.show.mockImplementation(async () => {
          paneInput.focus();
          return true;
        });
      });
      afterEach(() => {
        for (const element of appended.splice(0)) element.remove();
      });

      function focusedOpener(): HTMLButtonElement {
        const opener = append(document.createElement("button"));
        opener.focus();
        return opener;
      }

      // A click focuses the button it lands on, which fireEvent alone does not.
      function press(name: string) {
        const button = screen.getByRole("button", { name });
        button.focus();
        act(() => {
          fireEvent.click(button);
        });
      }

      async function stepAside() {
        press("Show panel");
        await act(async () => {
          presence.finish?.();
          await Promise.resolve();
        });
      }

      async function expireAside(requestId: string) {
        void enqueue(
          { requestId, danger: "safe", actionTitle: "Push", requester: PANE },
          mainDeadline()
        );
        render(<McpConfirmDialog />);
        await stepAside();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
        });
        expect(screen.getByRole("region", { name: "Approval request" }).textContent).toContain(
          "Timed out"
        );
      }

      it("hands focus from Show panel straight to the pane, never back through the opener", async () => {
        presence.defer = true;
        const opener = focusedOpener();
        void enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
        render(<McpConfirmDialog />);
        const openerFocused = vi.fn();
        opener.addEventListener("focus", openerFocused);

        await stepAside();

        expect(requesterMocks.show).toHaveBeenCalledWith(PANE.identity);
        expect(document.activeElement).toBe(paneInput);
        expect(openerFocused).not.toHaveBeenCalled();
      });

      it("returns to where the user last was once the request brought back is answered", async () => {
        focusedOpener();
        const pending = enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
        render(<McpConfirmDialog />);

        await stepAside();
        expect(document.activeElement).toBe(paneInput);
        // Moved on within the pane before coming back.
        const paneEditor = append(document.createElement("textarea"));
        paneEditor.focus();

        press("Review request");
        press("Cancel");

        await expect(pending).resolves.toEqual({ decision: "rejected" });
        expect(document.activeElement).toBe(paneEditor);
      });

      it("returns the next opening to its own opener, not an earlier pane visit", async () => {
        presence.defer = true;
        const opener = focusedOpener();
        void enqueue({ requestId: "req-a", danger: "safe", actionTitle: "Push", requester: PANE });
        render(<McpConfirmDialog />);
        await stepAside();
        press("Review request");
        press("Cancel");
        act(() => {
          presence.finish?.();
        });

        opener.focus();
        void enqueue({ requestId: "req-b", danger: "safe", actionTitle: "Pull" });
        await act(async () => {
          await Promise.resolve();
        });
        press("Cancel");
        expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
        act(() => {
          presence.finish?.();
        });

        expect(document.activeElement).toBe(opener);
      });

      it("forgets the pane visit when the request settles while it stands aside", async () => {
        const opener = focusedOpener();
        void enqueue({ requestId: "req-a", danger: "safe", actionTitle: "Push", requester: PANE });
        render(<McpConfirmDialog />);
        await stepAside();
        act(() => {
          useMcpConfirmStore.getState().drop("req-a");
        });
        expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();

        opener.focus();
        void enqueue({ requestId: "req-b", danger: "safe", actionTitle: "Pull" });
        await act(async () => {
          await Promise.resolve();
        });
        press("Cancel");

        expect(document.activeElement).toBe(opener);
      });

      it("puts focus back on the opener when the pane can't be reached, and returns there after", async () => {
        presence.defer = true;
        requesterMocks.show.mockResolvedValue(false);
        const opener = focusedOpener();
        const pending = enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
        render(<McpConfirmDialog />);
        const openerFocused = vi.fn();
        opener.addEventListener("focus", openerFocused);

        await stepAside();
        expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();
        // Before the dialog came back, whose own initial focus may follow at once.
        expect(openerFocused).toHaveBeenCalledTimes(1);

        press("Cancel");
        await expect(pending).resolves.toEqual({ decision: "rejected" });
        act(() => {
          presence.finish?.();
        });
        expect(document.activeElement).toBe(opener);
      });

      it("does nothing from the Show panel of a request held on screen after it was answered", async () => {
        presence.defer = true;
        focusedOpener();
        const pending = enqueue({ danger: "safe", actionTitle: "Push", requester: PANE });
        render(<McpConfirmDialog />);
        await stepAside();
        press("Review request");
        press("Cancel");
        await expect(pending).resolves.toEqual({ decision: "rejected" });

        // Still on screen mid-exit, and still clickable.
        press("Show panel");
        await act(async () => {
          presence.finish?.();
          await Promise.resolve();
        });

        expect(requesterMocks.show).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
        expect(document.activeElement).toBe(paneInput);
      });

      it("lets Escape put away a pill whose request timed out, before the pane sees it", async () => {
        vi.useFakeTimers();
        try {
          const pending = enqueue(
            { requestId: "req-esc", danger: "safe", actionTitle: "Push", requester: PANE },
            mainDeadline()
          );
          render(<McpConfirmDialog />);
          await stepAside();
          expect(document.activeElement).toBe(paneInput);

          // Still waiting: Escape is the pane's.
          expect(fireEvent.keyDown(paneInput, { key: "Escape" })).toBe(true);
          expect(paneKeys).toHaveBeenCalledTimes(1);
          expect(screen.getByRole("region", { name: "Approval request" })).toBeTruthy();

          await act(async () => {
            await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
          });
          expect(await pending).toEqual({ decision: "timeout" });

          let consumed = false;
          act(() => {
            consumed = !fireEvent.keyDown(paneInput, { key: "Escape" });
          });

          expect(consumed).toBe(true);
          expect(paneKeys).toHaveBeenCalledTimes(1);
          expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
          expect(useMcpConfirmStore.getState().current).toBeNull();
          expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
          expect(document.activeElement).toBe(paneInput);
        } finally {
          vi.useRealTimers();
        }
      });

      it("hands focus back to the pane when Escape puts the pill away from the pill itself", async () => {
        vi.useFakeTimers();
        try {
          await expireAside("req-pill");

          const review = screen.getByRole("button", { name: "Review request" });
          review.focus();
          act(() => {
            fireEvent.keyDown(review, { key: "Escape" });
          });

          expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
          expect(document.activeElement).toBe(paneInput);
        } finally {
          vi.useRealTimers();
        }
      });

      it.each([
        ["a modified Escape", { key: "Escape", shiftKey: true }],
        ["an IME's Escape", { key: "Escape", keyCode: 229 }],
        ["a composing Escape", { key: "Escape", isComposing: true }],
        ["another key", { key: "Enter" }],
      ])("leaves the timed-out pill up on %s", async (_label, init) => {
        vi.useFakeTimers();
        try {
          await expireAside("req-keys");

          act(() => {
            fireEvent.keyDown(paneInput, init);
          });

          expect(screen.getByRole("region", { name: "Approval request" })).toBeTruthy();
        } finally {
          vi.useRealTimers();
        }
      });

      it("leaves Escape to a modal open over the page while the timed-out pill is up", async () => {
        vi.useFakeTimers();
        try {
          await expireAside("req-modal");

          const modal = append(document.createElement("div"));
          modal.setAttribute("role", "dialog");
          modal.setAttribute("aria-modal", "true");
          expect(fireEvent.keyDown(paneInput, { key: "Escape" })).toBe(true);
          expect(screen.getByRole("region", { name: "Approval request" })).toBeTruthy();

          modal.remove();
          act(() => {
            fireEvent.keyDown(paneInput, { key: "Escape" });
          });
          expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it("leaves Escape to a popup's own field, but not to the app's", async () => {
        vi.useFakeTimers();
        // The open popup, and the app's own surfaces, both on the escape stack.
        const entry = registerEscape(() => {});
        try {
          await expireAside("req-field");

          const search = append(document.createElement("input"));
          expect(fireEvent.keyDown(search, { key: "Escape" })).toBe(true);
          expect(screen.getByRole("region", { name: "Approval request" })).toBeTruthy();

          const app = append(document.createElement("div"));
          app.id = "root";
          const composer = app.appendChild(document.createElement("textarea"));
          act(() => {
            fireEvent.keyDown(composer, { key: "Escape" });
          });
          expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
        } finally {
          entry.unregister();
          vi.useRealTimers();
        }
      });

      it("leaves Escape to a field's open suggestion list", async () => {
        vi.useFakeTimers();
        try {
          await expireAside("req-suggest");
          const composer = append(document.createElement("textarea"));
          composer.setAttribute("role", "combobox");
          composer.setAttribute("aria-expanded", "true");

          expect(fireEvent.keyDown(composer, { key: "Escape" })).toBe(true);
          expect(screen.getByRole("region", { name: "Approval request" })).toBeTruthy();

          composer.setAttribute("aria-expanded", "false");
          act(() => {
            fireEvent.keyDown(composer, { key: "Escape" });
          });
          expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      describe("a navigation that fails late", () => {
        let navigations: Array<(arrived: boolean) => void>;
        beforeEach(() => {
          navigations = [];
          requesterMocks.show.mockImplementation(
            () => new Promise<boolean>((resolve) => navigations.push(resolve))
          );
        });

        it("doesn't bring the request back from a visit since ended", async () => {
          void enqueue({
            requestId: "req-a",
            danger: "safe",
            actionTitle: "Push",
            requester: PANE,
          });
          render(<McpConfirmDialog />);
          await stepAside();
          press("Review request");
          await stepAside();
          expect(navigations).toHaveLength(2);

          await act(async () => {
            navigations[0]?.(false);
            await Promise.resolve();
          });

          expect(screen.getByRole("region", { name: "Approval request" })).toBeTruthy();
          expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
        });

        it("doesn't move focus once the dialog that started it has gone", async () => {
          focusedOpener();
          void enqueue({
            requestId: "req-a",
            danger: "safe",
            actionTitle: "Push",
            requester: PANE,
          });
          const { unmount } = render(<McpConfirmDialog />);
          await stepAside();
          unmount();
          const elsewhere = append(document.createElement("button"));
          elsewhere.focus();

          await act(async () => {
            navigations[0]?.(false);
            await Promise.resolve();
          });

          expect(document.activeElement).toBe(elsewhere);
        });

        it("doesn't pull focus from the next request once its own has settled", async () => {
          const opener = focusedOpener();
          void enqueue({
            requestId: "req-a",
            danger: "safe",
            actionTitle: "Push",
            requester: PANE,
          });
          render(<McpConfirmDialog />);
          await stepAside();
          act(() => {
            useMcpConfirmStore.getState().drop("req-a");
          });
          opener.focus();
          void enqueue({ requestId: "req-b", danger: "safe", actionTitle: "Pull" });
          await act(async () => {
            await Promise.resolve();
          });
          const cancel = screen.getByRole("button", { name: "Cancel" });
          cancel.focus();

          await act(async () => {
            navigations[0]?.(false);
            await Promise.resolve();
          });

          expect(document.activeElement).toBe(cancel);
          expect(screen.getByRole("button", { name: "Pull" })).toBeTruthy();
        });
      });

      it("moves focus to Close when the request times out under a focused Show panel", async () => {
        vi.useFakeTimers();
        try {
          void enqueue(
            { requestId: "req-under", danger: "safe", actionTitle: "Push", requester: PANE },
            mainDeadline()
          );
          render(<McpConfirmDialog />);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          screen.getByRole("button", { name: "Show panel" }).focus();

          await act(async () => {
            await vi.advanceTimersByTimeAsync(MCP_CONFIRM_DECISION_MS);
          });

          expect(screen.queryByRole("button", { name: "Show panel" })).toBeNull();
          expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
          expect(document.activeElement?.textContent).toBe("Close");
        } finally {
          vi.useRealTimers();
        }
      });

      it("leaves focus on a body control the same request keeps", () => {
        void enqueue({ requestId: "req-keep", previewPending: true });
        render(<McpConfirmDialog />);
        const args = screen.getByRole("button", { name: "Arguments" });
        args.focus();

        act(() => {
          useMcpConfirmStore.getState().setPreview("req-keep", { lines: ["No changes."] });
        });

        expect(document.activeElement).toBe(args);
      });
    });
  });

  describe("settling the last request (#16950)", () => {
    const appended: HTMLElement[] = [];
    afterEach(() => {
      for (const element of appended.splice(0)) element.remove();
    });

    it("keeps the request on screen, and focus where it was, until the close hands it back", async () => {
      presence.defer = true;
      const opener = document.createElement("button");
      appended.push(document.body.appendChild(opener));
      opener.focus();
      const pending = enqueue({ actionTitle: "Delete worktree" });
      render(<McpConfirmDialog />);

      const closeButton = screen.getByRole("button", { name: "Close dialog" });
      closeButton.focus();
      act(() => {
        fireEvent.click(closeButton);
      });
      await expect(pending).resolves.toEqual({ decision: "rejected" });

      // Mid-exit: the same request, and the same control, still there.
      expect(screen.getByText("Run 'Delete worktree'?")).toBeTruthy();
      expect(document.activeElement).toBe(closeButton);
      expect(closeButton.hasAttribute("disabled")).toBe(false);

      act(() => {
        presence.finish?.();
      });
      expect(document.activeElement).toBe(opener);
      expect(screen.queryByText("Run 'Delete worktree'?")).toBeNull();
    });

    it("keeps a focused body control in place through the exit", async () => {
      presence.defer = true;
      const pending = enqueue({ actionTitle: "Delete worktree" });
      render(<McpConfirmDialog />);

      const args = screen.getByRole("button", { name: "Arguments" });
      args.focus();
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      await expect(pending).resolves.toEqual({ decision: "rejected" });

      expect(args.isConnected).toBe(true);
      expect(document.activeElement).toBe(args);
    });
  });

  describe("the description (#16950)", () => {
    it.each(["confirm", "safe"] as const)(
      "names one element, holding the action and its rationale (%s)",
      (danger) => {
        void enqueue({ danger, dangerRationale: "Removes the directory and its changes." });
        render(<McpConfirmDialog />);

        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
        const id = dialog?.getAttribute("aria-describedby") ?? "";
        expect(id).not.toBe("");
        expect([...document.querySelectorAll("[id]")].filter((el) => el.id === id)).toHaveLength(1);
        const description = document.getElementById(id);
        expect(description?.textContent).toContain("Permanently delete a worktree.");
        expect(description?.textContent).toContain("Removes the directory and its changes.");
        expect(dialog?.querySelector("p p")).toBeNull();
      }
    );
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
        useMcpConfirmStore
          .getState()
          .setPreview("req-pending", { lines: ["No uncommitted changes."] });
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
        .setPreview("req-title", { lines: ["Branch: main", "  abcdef1 Fix — Ada"] });
    });

    expect(screen.getByText("Branch and local commits")).toBeTruthy();
    expect(screen.queryByText("Working tree changes")).toBeNull();
  });

  it("shows the requesting-bearer identity for external dispatches (#9157)", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      callerInfo: { token4LastChars: "1234", userAgent: "Claude Code" },
    });
    render(<McpConfirmDialog />, { wrapper: TooltipProvider });

    expect(screen.getByText("Requested by")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("…1234")).toBeTruthy();
  });

  it("names a host's agent with no token suffix when it carries none", () => {
    void enqueue({
      actionTitle: "Get current worktree",
      callerInfo: { token4LastChars: "", userAgent: 'Agent on host "studio-01"' },
    });
    render(<McpConfirmDialog />, { wrapper: TooltipProvider });

    expect(screen.getByText('Agent on host "studio-01"')).toBeTruthy();
    expect(document.body.textContent).not.toContain("…");
  });

  // The client-supplied name leads and the token trails: the user agent is what
  // a human recognises, the token suffix is the corroborating detail.
  it("orders the caller's own name before the token suffix", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      callerInfo: { token4LastChars: "1234", userAgent: "Claude Code" },
    });
    render(<McpConfirmDialog />, { wrapper: TooltipProvider });

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

  it("keeps the action description beside the rationale, since each can carry its own warning", () => {
    void enqueue({
      actionTitle: "Delete worktree",
      dangerRationale: "Permanently removes the worktree directory and any uncommitted changes.",
    });
    render(<McpConfirmDialog />);

    expect(screen.getByText("Permanently delete a worktree.")).toBeTruthy();
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
      useMcpConfirmStore.getState().setPreview("req-empty", { lines: [] });
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
      // A deadline main never extended: another machine is timing the call.
      const p = enqueue(
        { actionTitle: "Delete worktree", danger: "confirm" },
        { deadlineAt: Date.now() + MCP_DISPATCH_TIMEOUT_MS }
      );

      // ~29s spent queued behind earlier modals before promotion.
      act(() => {
        vi.advanceTimersByTime(29_000);
      });
      render(<McpConfirmDialog />);

      // Run out the remaining budget to main's deadline and no further.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      // Its time ran out before it reached the screen, so it never opens to
      // be approved at all.
      await expect(p).resolves.toEqual({ decision: "timeout", unseen: true });
      expect(screen.queryByRole("button", { name: "Delete worktree" })).toBeNull();
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
      const p = enqueue({ actionTitle: "Delete worktree", danger: "confirm" }, mainDeadline());

      // ~27.5s spent queued behind earlier modals before promotion, which once
      // left only ~500ms of a budget that started at enqueue.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(27_500);
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

  describe("assistant Daintree confirmations preference (#13137)", () => {
    const PREFERENCE_GROUP = "Daintree confirmations for the assistant";

    // The preference sits behind a collapsed disclosure; open it when present.
    function expandPreference() {
      const toggle = screen.queryByRole("button", { name: /Daintree confirmations/ });
      if (toggle) act(() => fireEvent.click(toggle));
    }

    async function renderLoaded() {
      render(<McpConfirmDialog />);
      await act(async () => {
        await Promise.resolve();
      });
      expandPreference();
    }

    function segment(label: string): HTMLElement {
      return screen.getByRole("radio", { name: label });
    }

    it("offers the preference for the assistant's own request and names the setting", async () => {
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      expect(screen.getByRole("radiogroup", { name: PREFERENCE_GROUP })).toBeTruthy();
      expect(segment("Follow agent setting").getAttribute("aria-checked")).toBe("true");
      const text = document.body.textContent ?? "";
      expect(text).toContain("Follow agent setting · asks");
      expect(text).toContain("Follows Settings > Agents > Skip permission prompts (off)");
      expect(text).toContain("even if you cancel");
    });

    it("follows the assistant agent's own skip setting over the global (#14141)", async () => {
      helpPanelState.preferredAgentId = "claude";
      agentSettingsState.agents = { claude: { dangerousMode: "on" } };
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      const text = document.body.textContent ?? "";
      expect(text).toContain("Follow agent setting · doesn't ask");
      expect(text).toContain("Follows Claude's skip permission prompts setting (on)");
    });

    it("follows the agent running in this view over a different chosen agent (#14141)", async () => {
      helpPanelState.preferredAgentId = "codex";
      helpPanelState.activeSlotAgentId = "claude";
      agentSettingsState.agents = {
        claude: { dangerousMode: "off" },
        codex: { dangerousMode: "on" },
      };
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      const text = document.body.textContent ?? "";
      expect(text).toContain("Follow agent setting · asks");
      expect(text).toContain("Follows Claude's skip permission prompts setting (off)");
    });

    // The fourth mode's actions are chosen in Settings (#16752); the dialog
    // names it in full to a screen reader and says how many it hands over.
    it("shows ask-except with the number of actions it hands over", async () => {
      helpAssistantApi.getSettings.mockResolvedValue({
        daintreeConfirmations: "ask-except",
        daintreeConfirmationsExcept: ["worktree.deleteOwned", "host.settings"],
      });
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      expect(segment("Ask, except for…").getAttribute("aria-checked")).toBe("true");
      const text = document.body.textContent ?? "";
      expect(text).toContain("Ask, except for 2 actions");
      expect(text).toContain("Choose the actions that don't ask in Settings > Daintree Assistant");
    });

    it("saves ask-except when chosen, and offers it only when the answer carries the list", async () => {
      helpAssistantApi.getSettings.mockResolvedValue({
        daintreeConfirmations: "never-ask",
        daintreeConfirmationsExcept: [],
      });
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      await act(async () => {
        fireEvent.click(segment("Ask, except for…"));
      });
      expect(helpAssistantApi.setSettings).toHaveBeenCalledWith({
        daintreeConfirmations: "ask-except",
      });
    });

    it("still shows ask-except as chosen when it is the stored mode, list or not", async () => {
      helpAssistantApi.getSettings.mockResolvedValue({ daintreeConfirmations: "ask-except" });
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      const chosen = segment("Ask, except for…");
      expect(chosen.getAttribute("aria-checked")).toBe("true");
      expect(chosen.tabIndex).toBe(0);
    });

    it("leaves ask-except out for a Daintree too old to keep it", async () => {
      helpAssistantApi.getSettings.mockResolvedValue({ daintreeConfirmations: "never-ask" });
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      expect(screen.queryByRole("radio", { name: "Ask, except for…" })).toBeNull();
      expect(segment("Never ask").getAttribute("aria-checked")).toBe("true");
    });

    it.each([
      ["inherit", true, "Follow agent setting · doesn't ask"],
      ["always-ask", true, "Always ask · asks"],
      ["never-ask", false, "Never ask · doesn't ask"],
      ["ask-except", true, "Ask, except for… · asks"],
    ] as const)(
      "states what %s resolves to with the global setting %s",
      async (preference, globalSkip, expected) => {
        agentSettingsState.globalSkipPermissions = globalSkip;
        helpAssistantApi.getSettings.mockResolvedValue({ daintreeConfirmations: preference });
        void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
        await renderLoaded();

        expect(document.body.textContent ?? "").toContain(expected);
      }
    );

    it.each([
      ["external origin", { sessionOrigin: "external" as const }],
      ["missing origin", {}],
      [
        "api-key client",
        {
          sessionOrigin: "help" as const,
          callerInfo: { userAgent: "Claude Code", token4LastChars: "1234" },
        },
      ],
      ["agent pane", { sessionOrigin: "help" as const, offerSessionApproval: true }],
    ])("is not offered for the %s", async (_label, overrides) => {
      void enqueue({ actionTitle: "Delete worktree", ...overrides });
      await renderLoaded();

      expect(screen.queryByRole("radiogroup", { name: PREFERENCE_GROUP })).toBeNull();
      expect(helpAssistantApi.getSettings).not.toHaveBeenCalled();
    });

    it("saves the choice without answering the request on screen", async () => {
      vi.useFakeTimers();
      try {
        const p = enqueue({
          actionTitle: "Close terminal",
          danger: "safe",
          sessionOrigin: "help",
          selectableTargets: BATCH_TARGETS,
        });
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expandPreference();

        act(() => {
          fireEvent.click(segment("Never ask"));
        });

        expect(helpAssistantApi.setSettings).toHaveBeenCalledWith({
          daintreeConfirmations: "never-ask",
        });
        expect(segment("Never ask").getAttribute("aria-checked")).toBe("true");
        // The protected-close checklist keeps its selection through the change.
        expect(screen.getByText("3 of 3 selected")).toBeTruthy();
        await expectStillPending(p);
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });

    it("puts the choice back and says so when the save fails", async () => {
      helpAssistantApi.setSettings.mockRejectedValue(new Error("disk full"));
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      await act(async () => {
        fireEvent.click(segment("Never ask"));
        await Promise.resolve();
      });

      expect(segment("Follow agent setting").getAttribute("aria-checked")).toBe("true");
      expect(document.body.textContent ?? "").toContain("Couldn't save that change");
      expect(loggerMocks.logError).toHaveBeenCalled();
    });

    it("keeps the control disabled and says so when the setting can't be read", async () => {
      helpAssistantApi.getSettings.mockRejectedValue(new Error("ipc down"));
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      expect(document.body.textContent ?? "").toContain("Couldn't read the current setting");
      for (const label of ["Follow agent setting", "Always ask", "Never ask"]) {
        expect(segment(label).hasAttribute("disabled")).toBe(true);
      }
    });

    it("does not let an earlier failed save undo a later successful one", async () => {
      const rejections: Array<(err: Error) => void> = [];
      helpAssistantApi.setSettings.mockImplementation((patch: { daintreeConfirmations: string }) =>
        patch.daintreeConfirmations === "always-ask"
          ? Promise.resolve()
          : new Promise<void>((_resolve, reject) => rejections.push(reject))
      );
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      // Never (pending) → Always (saved) → Never (saved later); the first Never fails last.
      act(() => {
        fireEvent.click(segment("Never ask"));
      });
      await act(async () => {
        fireEvent.click(segment("Always ask"));
        await Promise.resolve();
      });
      helpAssistantApi.setSettings.mockResolvedValue(undefined);
      await act(async () => {
        fireEvent.click(segment("Never ask"));
        await Promise.resolve();
      });
      await act(async () => {
        rejections[0]?.(new Error("disk full"));
        await Promise.resolve();
      });

      expect(segment("Never ask").getAttribute("aria-checked")).toBe("true");
      expect(document.body.textContent ?? "").not.toContain("Couldn't save that change");
    });

    it("shows an older save that succeeds after the newest one failed", async () => {
      let resolveFirst: (() => void) | undefined;
      helpAssistantApi.setSettings.mockImplementationOnce(
        () => new Promise<void>((resolve) => (resolveFirst = resolve))
      );
      helpAssistantApi.setSettings.mockRejectedValueOnce(new Error("disk full"));
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      act(() => {
        fireEvent.click(segment("Never ask"));
      });
      await act(async () => {
        fireEvent.click(segment("Always ask"));
        await Promise.resolve();
      });
      expect(segment("Follow agent setting").getAttribute("aria-checked")).toBe("true");

      await act(async () => {
        resolveFirst?.();
        await Promise.resolve();
      });

      expect(segment("Never ask").getAttribute("aria-checked")).toBe("true");
    });

    it("falls back to the last saved value, not the last pick, when the newest save fails", async () => {
      helpAssistantApi.setSettings.mockResolvedValueOnce(undefined);
      void enqueue({ actionTitle: "Delete worktree", sessionOrigin: "help" });
      await renderLoaded();

      await act(async () => {
        fireEvent.click(segment("Always ask"));
        await Promise.resolve();
      });
      helpAssistantApi.setSettings.mockRejectedValue(new Error("disk full"));
      await act(async () => {
        fireEvent.click(segment("Never ask"));
        await Promise.resolve();
      });

      expect(segment("Always ask").getAttribute("aria-checked")).toBe("true");
      expect(document.body.textContent ?? "").toContain("Couldn't save that change");
    });

    it("lands initial focus on Cancel rather than the preference control", async () => {
      vi.useFakeTimers();
      try {
        void enqueue({
          actionTitle: "Focus terminal",
          danger: "safe",
          sessionOrigin: "help",
          argsSummary: "",
        });
        render(<McpConfirmDialog />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(50);
        });

        expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
      } finally {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
      }
    });
  });
});
