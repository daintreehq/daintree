/**
 * @vitest-environment jsdom
 *
 * Terminal output replaces a panel object on every activity write. The card
 * holds ids and value summaries, never the panels, so a stream re-renders the
 * terminal rows and nothing above them (#17051).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { PtyPanelData } from "@shared/types/panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));

vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  worktreeClient: {
    refresh: vi.fn(() => Promise.resolve()),
    switchEnvironment: vi.fn(),
    attachmentAction: vi.fn(() => Promise.resolve()),
  },
  errorsClient: { retry: vi.fn(() => Promise.resolve()) },
}));

// Only the card itself calls the summary hook, so its calls count the card's
// renders and none of the rows'.
const cardRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/hooks/useWorktreeTerminals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useWorktreeTerminals")>();
  return {
    ...actual,
    useWorktreeTerminalSummary: (worktreeId: string) => {
      cardRenders.count += 1;
      return actual.useWorktreeTerminalSummary(worktreeId);
    },
  };
});

vi.mock("@/hooks/app/useWorktreeDevServerSession", () => ({
  useWorktreeDevServerSession: () => undefined,
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({ usePluginContextMenuItems: () => [] }));
vi.mock("@/hooks/useForgeTooltip", () => {
  const tooltip = () => ({
    data: null,
    loading: false,
    error: false,
    missingCredential: false,
    providerId: "daintree.github.github",
    fetchTooltip: () => Promise.resolve(),
    reset: () => {},
  });
  return { useIssueTooltip: tooltip, usePRTooltip: tooltip };
});
vi.mock("@/hooks/useForgeAuthorAvatar", () => ({ useForgeAuthorAvatar: () => undefined }));
vi.mock("@/hooks/useReviewChangeHint", () => ({ useReviewChangeHint: () => null }));
vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../WorktreeDialogs", () => ({ WorktreeDialogs: () => null }));
vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

import { WorktreeCard } from "../../WorktreeCard";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";

const WORKTREE = {
  id: "wt-1",
  worktreeId: "wt-1",
  path: "/repo/wt-1",
  name: "wt-1",
  branch: "feature/login",
  isCurrent: false,
  isMainWorktree: false,
  lastActivityTimestamp: Date.now() - 60_000,
} as unknown as WorktreeState;

function panel(id: string, worktreeId: string, fields: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: id,
    worktreeId,
    location: "grid",
    hasPty: true,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    ...fields,
  } as unknown as PtyPanelData;
}

function seed(panels: PtyPanelData[]): void {
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const p of panels) (panelIdsByWorktreeId[p.worktreeId!] ??= []).push(p.id);
  usePanelStore.setState({
    panelIds: panels.map((p) => p.id),
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIdsByWorktreeId,
  });
}

// The status buffer's write: a fresh panel object in a fresh `panelsById`,
// every bucket array left as it was.
function streamOutput(id: string, line: number): void {
  act(() => {
    usePanelStore.setState((state) => ({
      panelsById: {
        ...state.panelsById,
        [id]: {
          ...state.panelsById[id]!,
          activityHeadline: `line ${line}`,
          activityStatus: "working",
          lastCommand: `make ${line}`,
          heldDurationMs: line * 2000,
        } as never,
      },
    }));
  });
}

function renderCard() {
  const store = createWorktreeStore();
  setCurrentViewStore(store);
  return render(
    <WorktreeStoreContext.Provider value={store}>
      <TooltipProvider>
        <WorktreeCard
          worktree={WORKTREE}
          isActive={false}
          isFocused={false}
          onSelect={vi.fn()}
          onOpenEditor={vi.fn()}
        />
      </TooltipProvider>
    </WorktreeStoreContext.Provider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  useWorktreeFilterStore.setState({ cardDensity: "comfortable", collapsedWorktrees: [] });
  useWorktreeSelectionStore.setState({
    expandedWorktrees: new Set(),
    expandedTerminals: new Set(["wt-1"]),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePanelStore.setState({ panelIds: [], panelsById: {}, panelIdsByWorktreeId: {} });
});

describe("WorktreeCard under streaming output", () => {
  it("does not re-render while its own or any other terminal streams output", () => {
    seed([
      panel("shell", "wt-1"),
      panel("agent", "wt-1", { detectedAgentId: "claude", agentState: "working" }),
      panel("elsewhere", "wt-2"),
    ]);
    renderCard();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const before = cardRenders.count;

    for (let line = 0; line < 3; line++) {
      streamOutput("shell", line);
      streamOutput("agent", line);
      streamOutput("elsewhere", line);
      act(() => {
        vi.advanceTimersByTime(16);
      });
    }
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(cardRenders.count).toBe(before);
    // The rows still follow the stream: they select their panels themselves.
    expect(screen.getByText("make 2")).toBeTruthy();
  });

  it("re-renders when an agent's state changes", () => {
    seed([panel("agent", "wt-1", { detectedAgentId: "claude", agentState: "working" })]);
    renderCard();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const before = cardRenders.count;

    act(() => {
      usePanelStore.setState((state) => ({
        panelsById: {
          ...state.panelsById,
          agent: { ...state.panelsById.agent!, agentState: "waiting" } as never,
        },
      }));
    });

    expect(cardRenders.count).toBeGreaterThan(before);
  });
});
