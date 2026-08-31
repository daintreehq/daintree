// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpActivityTracker, type McpActivityTrackerHost } from "../McpActivityTracker";
import type { HelpSessionSnapshot } from "../HelpSessionController";

const { addFigure, helpPanelState, projectStoreState } = vi.hoisted(() => ({
  addFigure: vi.fn(),
  helpPanelState: { sessions: {} as Record<number, unknown>, activeSlot: 0 },
  projectStoreState: { currentProject: { id: "proj-1", path: "/tmp/proj-1" } },
}));

vi.mock("@/store/helpPanelStore", () => {
  const store = (selector?: (s: typeof helpPanelState) => unknown) =>
    selector ? selector(helpPanelState) : helpPanelState;
  store.getState = () => ({ ...helpPanelState, addFigure });
  return { useHelpPanelStore: store };
});

vi.mock("@/store", () => {
  const projectStore = (selector?: (s: typeof projectStoreState) => unknown) =>
    selector ? selector(projectStoreState) : projectStoreState;
  projectStore.getState = () => projectStoreState;
  return { useProjectStore: projectStore };
});

vi.mock("@/clients/projectClient", () => ({ projectClient: {} }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

/** Captures the handler each `on*` subscription registers so tests can fire it. */
function makeMcpBridge() {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const register =
    (name: string) =>
    (fn: (payload: unknown) => void): (() => void) => {
      handlers[name] = fn;
      return () => delete handlers[name];
    };
  return {
    handlers,
    bridge: {
      onTierNotPermitted: register("tier"),
      onSessionRevoked: register("revoked"),
      onGrantLifecycle: register("grant"),
      onToolCallStarted: register("started"),
      onToolCallSettled: register("settled"),
      onTurnOutcomeAlert: register("outcome"),
      onDisplayImage: register("image"),
    },
  };
}

const EMPTY_SNAPSHOT = {
  mcpActivity: null,
  tierMismatch: null,
  sessionRevoked: null,
  activeGrant: null,
  grantEnded: null,
  outcomeAlert: null,
} as unknown as HelpSessionSnapshot;

/**
 * #12108. With concurrent lanes every session in a project shares ONE
 * WebContents, so the transport can no longer say which lane a push belongs
 * to — the payload's session id is the only thing that can. These tests pin
 * that every listener family filters on it, because an unfiltered push paints
 * a sibling lane's banner over the conversation the user is actually in.
 */
describe("McpActivityTracker — lane gating (#12108)", () => {
  let patch: McpActivityTrackerHost["patch"] & ReturnType<typeof vi.fn>;
  let host: McpActivityTrackerHost;
  let mcp: ReturnType<typeof makeMcpBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    patch = vi.fn() as typeof patch;
    mcp = makeMcpBridge();
    Object.defineProperty(window, "electron", {
      value: { mcpServer: mcp.bridge },
      writable: true,
      configurable: true,
    });
    host = {
      getSnapshot: () => EMPTY_SNAPSHOT,
      patch,
      // This tracker belongs to the lane holding "session-mine".
      getSessionId: () => "session-mine",
      getSlot: () => 1,
    };
    new McpActivityTracker(host).start();
  });

  it("ignores every push aimed at a sibling lane's session", () => {
    mcp.handlers.tier!({ sessionId: "session-other", toolId: "git.push", tier: "action" });
    mcp.handlers.revoked!({ sessionId: "session-other", denialKind: "tier" });
    mcp.handlers.grant!({
      type: "grant.issued",
      sessionId: "session-other",
      toolId: "git.push",
      ttlMs: 1000,
      expiresAt: Date.now() + 1000,
    });
    mcp.handlers.started!({ sessionId: "session-other", toolId: "git.push", turnId: "t1" });
    mcp.handlers.outcome!({ helpSessionId: "session-other", outcome: "agent-stuck" });

    expect(patch).not.toHaveBeenCalled();
  });

  it("never files a sibling lane's figure into this conversation", () => {
    mcp.handlers.image!({
      sessionId: "session-other",
      imageId: "img-1",
      figureNumber: 1,
      figureLabel: "Figure 1",
      url: "https://daintree.org/a.png",
    });

    expect(addFigure).not.toHaveBeenCalled();
  });

  it("accepts a push for its own lane, and writes the figure into its own slot", () => {
    mcp.handlers.revoked!({ sessionId: "session-mine", denialKind: "tier" });
    expect(patch).toHaveBeenCalledWith({
      sessionRevoked: { sessionId: "session-mine", denialKind: "tier" },
    });

    mcp.handlers.image!({
      sessionId: "session-mine",
      imageId: "img-1",
      figureNumber: 1,
      figureLabel: "Figure 1",
      url: "https://daintree.org/a.png",
    });
    // Slot 1 — the tracker's own lane, not the store's active one.
    expect(addFigure).toHaveBeenCalledWith(1, expect.objectContaining({ imageId: "img-1" }));
  });

  it("drops every push while the lane has no session bound", () => {
    // A lane mid-relaunch has no id yet. Painting a banner here would stomp
    // the launch the user just started (#10017, generalized to lanes).
    patch.mockClear();
    const unboundHost: McpActivityTrackerHost = { ...host, getSessionId: () => null };
    const unbound = makeMcpBridge();
    Object.defineProperty(window, "electron", {
      value: { mcpServer: unbound.bridge },
      writable: true,
      configurable: true,
    });
    new McpActivityTracker(unboundHost).start();

    unbound.handlers.revoked!({ sessionId: "session-mine", denialKind: "tier" });
    unbound.handlers.started!({ sessionId: "session-mine", toolId: "git.push", turnId: "t1" });

    expect(patch).not.toHaveBeenCalled();
  });
});
