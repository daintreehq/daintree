// @vitest-environment jsdom
/**
 * useOverflowBadgeSeverity — issue #6416.
 *
 * The toolbar's `…` overflow trigger needs a single dot whose color reflects
 * the most-severe hidden state, plus left/right independence. These tests
 * mock every store the hook reads and assert the priority fold:
 *   critical (errorCount + problems) > warning (agent waiting/directing,
 *   active voice recording) > info (notification unread, agent-tray
 *   discovery) > null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { AgentState, AgentAvailabilityState, CliAvailability } from "@shared/types";

let mockPanelsById: Record<string, unknown> = {};
let mockPanelIds: string[] = [];
let mockActiveWorktreeId: string | null = null;
let mockNotificationUnreadCount = 0;
let mockAvailability: CliAvailability = {} as CliAvailability;
let mockOnboardingLoaded = true;
let mockSeenAgentIds: string[] = [];

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ panelsById: mockPanelsById, panelIds: mockPanelIds }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (s: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: mockActiveWorktreeId }),
}));

vi.mock("@/store/slices/notificationHistorySlice", () => ({
  useNotificationHistoryStore: (selector: (s: { unreadCount: number }) => unknown) =>
    selector({ unreadCount: mockNotificationUnreadCount }),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: { availability: CliAvailability }) => unknown) =>
    selector({ availability: mockAvailability }),
}));

vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  useAgentDiscoveryOnboarding: () => ({
    loaded: mockOnboardingLoaded,
    seenAgentIds: mockSeenAgentIds,
    welcomeCardDismissed: false,
    setupBannerDismissed: false,
    markAgentsSeen: vi.fn(),
    dismissWelcomeCard: vi.fn(),
    dismissSetupBanner: vi.fn(),
  }),
}));

// Real implementations of these — they're pure helpers.
vi.mock("zustand/react/shallow", () => ({
  useShallow: <T>(selector: T) => selector,
}));

// Pull the agent id straight off the panel so tests can drive the runtime
// identity derivation without recreating the full deriveTerminalChrome
// pipeline. The hook only needs the id; this short-circuits the real
// helper.
vi.mock("@/utils/terminalType", () => ({
  getRuntimeOrBootAgentId: (panel: { agentId?: string }) => panel?.agentId,
}));

import { useOverflowBadgeSeverity } from "../useOverflowBadgeSeverity";

function makePanel(overrides: {
  id: string;
  agentId?: string;
  agentState?: AgentState;
  worktreeId?: string;
  location?: string;
}) {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    runtimeAgentId: overrides.agentId,
    bootAgentId: overrides.agentId,
    agentState: overrides.agentState,
    worktreeId: overrides.worktreeId ?? null,
    location: overrides.location ?? "grid",
    type: "agent",
  };
}

describe("useOverflowBadgeSeverity", () => {
  beforeEach(() => {
    mockPanelsById = {};
    mockPanelIds = [];
    mockActiveWorktreeId = null;
    mockNotificationUnreadCount = 0;
    mockAvailability = {} as CliAvailability;
    mockOnboardingLoaded = true;
    mockSeenAgentIds = [];
  });

  it("returns null for an empty overflow list", () => {
    const { result } = renderHook(() => useOverflowBadgeSeverity([], 0));
    expect(result.current).toBeNull();
  });

  it("returns null when overflowed buttons have no active state", () => {
    const { result } = renderHook(() =>
      useOverflowBadgeSeverity(["problems", "notification-center"], 0)
    );
    expect(result.current).toBeNull();
  });

  it("returns critical when problems is overflowed and errorCount > 0", () => {
    const { result } = renderHook(() => useOverflowBadgeSeverity(["problems"], 3));
    expect(result.current).toBe("critical");
  });

  it("returns null when problems is overflowed but errorCount is 0", () => {
    const { result } = renderHook(() => useOverflowBadgeSeverity(["problems"], 0));
    expect(result.current).toBeNull();
  });

  it("returns warning when voice-recording is overflowed (its presence implies active recording)", () => {
    const { result } = renderHook(() => useOverflowBadgeSeverity(["voice-recording"], 0));
    expect(result.current).toBe("warning");
  });

  it("returns warning when an overflowed agent has a waiting panel", () => {
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "claude", agentState: "waiting" }),
    };
    mockPanelIds = ["p-1"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBe("warning");
  });

  it("returns warning when an overflowed agent has a directing panel", () => {
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "claude", agentState: "directing" }),
    };
    mockPanelIds = ["p-1"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBe("warning");
  });

  it("surfaces a waiting panel even when a sibling working panel exists for the same agent", () => {
    // Folding via getDominantAgentState would return "working" (no dot)
    // and silence the waiting panel — the exact scenario the overflow dot
    // is meant to flag.
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "claude", agentState: "working" }),
      "p-2": makePanel({ id: "p-2", agentId: "claude", agentState: "waiting" }),
    };
    mockPanelIds = ["p-1", "p-2"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBe("warning");
  });

  it("ignores overflowed agents whose panels are in passive states", () => {
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "claude", agentState: "working" }),
    };
    mockPanelIds = ["p-1"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBeNull();
  });

  it("ignores panels for agents that are not overflowed", () => {
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "codex", agentState: "waiting" }),
    };
    mockPanelIds = ["p-1"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBeNull();
  });

  it("ignores trashed and background panels even when state is waiting", () => {
    mockPanelsById = {
      "p-1": makePanel({
        id: "p-1",
        agentId: "claude",
        agentState: "waiting",
        location: "trash",
      }),
      "p-2": makePanel({
        id: "p-2",
        agentId: "claude",
        agentState: "waiting",
        location: "background",
      }),
    };
    mockPanelIds = ["p-1", "p-2"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBeNull();
  });

  it("scopes panels to the active worktree when one is set", () => {
    mockActiveWorktreeId = "wt-1";
    mockPanelsById = {
      "p-1": makePanel({
        id: "p-1",
        agentId: "claude",
        agentState: "waiting",
        worktreeId: "wt-2",
      }),
    };
    mockPanelIds = ["p-1"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    expect(result.current).toBeNull();
  });

  it("returns info when notification-center is overflowed and unread count > 0", () => {
    mockNotificationUnreadCount = 5;
    const { result } = renderHook(() => useOverflowBadgeSeverity(["notification-center"], 0));
    expect(result.current).toBe("info");
  });

  it("returns null when notification-center is overflowed but unread count is 0", () => {
    mockNotificationUnreadCount = 0;
    const { result } = renderHook(() => useOverflowBadgeSeverity(["notification-center"], 0));
    expect(result.current).toBeNull();
  });

  it("returns info when agent-tray is overflowed and a launchable agent is unseen", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    mockAvailability = { claude: "ready" } as unknown as CliAvailability;
    mockSeenAgentIds = ["codex"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["agent-tray"], 0));
    expect(result.current).toBe("info");
  });

  it("returns null for agent-tray when every launchable agent has been seen", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    mockAvailability = { claude: "ready" } as unknown as CliAvailability;
    mockSeenAgentIds = ["claude"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["agent-tray"], 0));
    expect(result.current).toBeNull();
  });

  it("returns null for agent-tray when onboarding has not yet loaded", () => {
    mockOnboardingLoaded = false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    mockAvailability = { claude: "ready" } as unknown as CliAvailability;
    mockSeenAgentIds = [];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["agent-tray"], 0));
    expect(result.current).toBeNull();
  });

  it("ignores unlaunchable agents when computing agent-tray discovery", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    mockAvailability = {
      claude: "missing" as AgentAvailabilityState,
    } as unknown as CliAvailability;
    mockSeenAgentIds = [];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["agent-tray"], 0));
    expect(result.current).toBeNull();
  });

  it("prefers critical over warning when both are present", () => {
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "claude", agentState: "waiting" }),
    };
    mockPanelIds = ["p-1"];
    const { result } = renderHook(() => useOverflowBadgeSeverity(["problems", "claude"], 4));
    expect(result.current).toBe("critical");
  });

  it("prefers warning over info when both are present", () => {
    mockNotificationUnreadCount = 2;
    const { result } = renderHook(() =>
      useOverflowBadgeSeverity(["voice-recording", "notification-center"], 0)
    );
    expect(result.current).toBe("warning");
  });

  it("ignores unknown ids without crashing", () => {
    const { result } = renderHook(() =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      useOverflowBadgeSeverity(["plugin.acme.unknown" as never], 0)
    );
    expect(result.current).toBeNull();
  });

  it("computes left and right severities independently", () => {
    mockPanelsById = {
      "p-1": makePanel({ id: "p-1", agentId: "claude", agentState: "waiting" }),
    };
    mockPanelIds = ["p-1"];
    mockNotificationUnreadCount = 1;
    const { result: left } = renderHook(() => useOverflowBadgeSeverity(["claude"], 0));
    const { result: right } = renderHook(() =>
      useOverflowBadgeSeverity(["notification-center"], 0)
    );
    expect(left.current).toBe("warning");
    expect(right.current).toBe("info");
  });
});
