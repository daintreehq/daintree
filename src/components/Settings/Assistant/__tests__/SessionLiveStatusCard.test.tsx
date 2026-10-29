// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpSessionActiveGrant, HelpSessionLiveStatus } from "@shared/types";
import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { GlobalAssistantView } from "@shared/types/ipc/help";

interface Lane {
  sessionId: string | null;
  agentId: string | null;
  terminalId: string | null;
}

interface DockState {
  activeSlot: number;
  sessions: Record<number, Lane>;
  globalSelected: boolean;
  globalTarget: AgentDirectorySubject | null;
}

const {
  liveStatus,
  useLiveStatus,
  dock,
  panels,
  preferences,
  viewHostId,
  revokeGrant,
  revokeNativeGrant,
  issueNativeGrant,
} = vi.hoisted(() => {
  const liveStatus = { current: null as HelpSessionLiveStatus | null };
  return {
    liveStatus,
    useLiveStatus: vi.fn((sessionId: string | null) =>
      sessionId && liveStatus.current
        ? liveStatus.current
        : { connected: false, tier: "core" as const, activeGrants: [] }
    ),
    dock: { current: null as unknown as DockState },
    panels: { current: {} as Record<string, { kind: "terminal"; task: string | null }> },
    preferences: { showAgentTaskTitles: true },
    viewHostId: { current: null as string | null },
    revokeGrant: vi.fn(),
    revokeNativeGrant: vi.fn(),
    issueNativeGrant: vi.fn(),
  };
});

vi.mock("@/hooks", () => ({
  useHelpSessionLiveStatus: (sessionId: string | null) => useLiveStatus(sessionId),
}));

vi.mock("@/hooks/useHostConnection", () => ({
  getViewHostId: () => viewHostId.current,
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) =>
    ({ claude: { name: "Claude Code" }, codex: { name: "Codex" } })[id],
}));

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: (selector: (s: DockState) => unknown) => selector(dock.current),
  selectActiveSlot: (s: DockState) => s.sessions[s.activeSlot],
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (s: { panelsById: typeof panels.current }) => unknown) =>
    selector({ panelsById: panels.current }),
}));

vi.mock("@/store/preferencesStore", () => ({
  usePreferencesStore: (selector: (s: typeof preferences) => unknown) => selector(preferences),
}));

vi.mock("@/utils/terminalTitleDisplay", () => ({
  getTerminalTaskTitle: (panel: { task: string | null }) => panel.task,
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { SessionLiveStatusCard } from "../SessionLiveStatusCard";

function perTool(toolId: string): HelpSessionActiveGrant {
  return {
    sessionId: "transport-1",
    toolId,
    expiresAt: Date.now() + 600_000,
    ttlMs: 900_000,
    kind: "per-tool",
  };
}

const AUTOMATION: HelpSessionActiveGrant = {
  sessionId: "transport-1",
  toolId: "*",
  expiresAt: Date.now() + 600_000,
  ttlMs: 900_000,
  kind: "native",
  grantId: "g1",
  allowedTools: ["recipe.run"],
  maxUses: 5,
  remainingUses: 5,
};

const LANE_ONE: Lane = { sessionId: "help-1", agentId: "claude", terminalId: "t-1" };
const LANE_TWO: Lane = { sessionId: "help-2", agentId: "codex", terminalId: "t-2" };

const globalSubject = (incarnation: number): AgentDirectorySubject => ({
  hostId: "local",
  scope: { kind: "global" },
  terminalId: "g-1",
  incarnation,
});

function globalView(patch: Partial<GlobalAssistantView> = {}): GlobalAssistantView {
  return {
    phase: "absent",
    generation: 0,
    agentId: null,
    terminalId: null,
    attachments: [],
    inputOwner: null,
    inputEpoch: 0,
    subject: null,
    ...patch,
  };
}

const globalRunning = (patch: Partial<GlobalAssistantView> = {}) =>
  globalView({
    phase: "running",
    generation: 1,
    agentId: "claude",
    terminalId: "g-1",
    subject: globalSubject(1),
    ...patch,
  });

let globalListeners: Set<(state: GlobalAssistantView) => void>;
let getGlobalAssistantState: ReturnType<typeof vi.fn>;

function pushGlobal(state: GlobalAssistantView): void {
  act(() => {
    for (const listener of globalListeners) listener(state);
  });
}

function identityOf(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-testid="assistant-live-session-identity"]')?.textContent;
}

beforeEach(() => {
  dock.current = {
    activeSlot: 0,
    sessions: { 0: LANE_ONE },
    globalSelected: false,
    globalTarget: null,
  };
  panels.current = {};
  preferences.showAgentTaskTitles = true;
  viewHostId.current = null;
  useLiveStatus.mockClear();
  revokeGrant.mockReset();
  revokeNativeGrant.mockReset();
  issueNativeGrant.mockReset();
  issueNativeGrant.mockResolvedValue({ grantId: "g2" });
  liveStatus.current = {
    connected: true,
    tier: "core",
    activeGrants: [perTool("terminal.kill"), perTool("project.runCheck"), AUTOMATION],
  };
  globalListeners = new Set();
  getGlobalAssistantState = vi.fn(async () => globalView());
  Object.defineProperty(window, "electron", {
    value: {
      mcpServer: { revokeGrant, revokeNativeGrant, issueNativeGrant },
      help: {
        getGlobalAssistantState,
        onGlobalAssistantChanged: (listener: (state: GlobalAssistantView) => void) => {
          globalListeners.add(listener);
          return () => globalListeners.delete(listener);
        },
      },
    },
    writable: true,
    configurable: true,
  });
});

describe("SessionLiveStatusCard per-tool revoke (#14975)", () => {
  it("ends one per-tool grant by its transport session and leaves the rest alone", async () => {
    let settle: (() => void) | undefined;
    revokeGrant.mockReturnValue(
      new Promise((resolve) => {
        settle = () =>
          resolve({ sessionId: "transport-1", toolId: "project.runCheck", revoked: true });
      })
    );
    const { getByRole } = render(<SessionLiveStatusCard configuredTier="core" />);
    const target = () => getByRole("button", { name: "Revoke project.runCheck" });
    const sibling = () => getByRole("button", { name: "Revoke terminal.kill" });

    fireEvent.click(target());

    expect(revokeGrant).toHaveBeenCalledTimes(1);
    expect(revokeGrant).toHaveBeenCalledWith({
      sessionId: "transport-1",
      toolId: "project.runCheck",
    });
    expect(revokeNativeGrant).not.toHaveBeenCalled();
    expect(target().getAttribute("aria-busy")).toBe("true");
    expect(sibling().getAttribute("aria-busy")).toBeNull();

    settle?.();
    await waitFor(() => expect(target().getAttribute("aria-busy")).toBeNull());
    expect(sibling()).toBeTruthy();
  });

  it("keeps the row and says why when the revoke fails", async () => {
    revokeGrant.mockRejectedValue(new Error("Caller is not the pinned renderer"));
    const { getByRole, findByRole } = render(<SessionLiveStatusCard configuredTier="core" />);

    fireEvent.click(getByRole("button", { name: "Revoke terminal.kill" }));

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Caller is not the pinned renderer");
    expect(getByRole("button", { name: "Revoke terminal.kill" })).toBeTruthy();
  });

  it("drops a pending revoke and its error when the active session changes", async () => {
    let rejectRevoke: (() => void) | undefined;
    revokeGrant.mockReturnValue(
      new Promise((_, reject) => {
        rejectRevoke = () => reject(new Error("Caller is not the pinned renderer"));
      })
    );
    const { getByRole, queryByRole, rerender } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );
    fireEvent.click(getByRole("button", { name: "Revoke terminal.kill" }));

    dock.current = { ...dock.current, activeSlot: 1, sessions: { 0: LANE_ONE, 1: LANE_TWO } };
    liveStatus.current = {
      connected: true,
      tier: "core",
      activeGrants: [{ ...perTool("terminal.kill"), sessionId: "transport-2" }],
    };
    rerender(<SessionLiveStatusCard configuredTier="core" />);
    expect(
      getByRole("button", { name: "Revoke terminal.kill" }).getAttribute("aria-busy")
    ).toBeNull();

    rejectRevoke?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryByRole("alert")).toBeNull();
  });
});

describe("SessionLiveStatusCard automation grant form (#14982)", () => {
  it("leaves the next session's form alone when the last session's approval settles", async () => {
    let rejectIssue: (() => void) | undefined;
    issueNativeGrant.mockReturnValue(
      new Promise((_, reject) => {
        rejectIssue = () => reject(new Error("No live pinned session for this help session"));
      })
    );
    const { getByLabelText, getByRole, queryByRole, rerender } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );
    fireEvent.click(getByLabelText(/recipe\.run/));
    fireEvent.click(getByRole("button", { name: "Approve grant" }));
    expect(issueNativeGrant).toHaveBeenCalledTimes(1);

    dock.current = { ...dock.current, activeSlot: 1, sessions: { 0: LANE_ONE, 1: LANE_TWO } };
    liveStatus.current = { connected: true, tier: "core", activeGrants: [] };
    rerender(<SessionLiveStatusCard configuredTier="core" />);
    expect(getByLabelText(/recipe\.run/).dataset.state).toBe("unchecked");
    fireEvent.click(getByLabelText(/worktree\.deleteOwned/));

    rejectIssue?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryByRole("alert")).toBeNull();
    expect(getByLabelText(/worktree\.deleteOwned/).dataset.state).toBe("checked");
    expect(getByRole("button", { name: "Approve grant" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("SessionLiveStatusCard names the conversation it describes (#14990)", () => {
  it("names the project lane on screen and the agent running it, and reads that lane", () => {
    dock.current = { ...dock.current, activeSlot: 1, sessions: { 0: LANE_ONE, 1: LANE_TWO } };
    const { container } = render(<SessionLiveStatusCard configuredTier="core" />);

    expect(identityOf(container)).toBe("Project · Session 2 · Codex");
    expect(useLiveStatus).toHaveBeenCalledWith("help-2");
    expect(useLiveStatus).not.toHaveBeenCalledWith("help-1");
  });

  it("names a lane by the task title its tab shows, and by number when titles are off", () => {
    panels.current = { "t-1": { kind: "terminal", task: "Fix  auth\ntests" } };
    const { container, rerender } = render(<SessionLiveStatusCard configuredTier="core" />);
    expect(identityOf(container)).toBe("Project · 'Fix auth tests' · Claude Code");

    preferences.showAgentTaskTitles = false;
    rerender(<SessionLiveStatusCard configuredTier="core" />);
    expect(identityOf(container)).toBe("Project · Session 1 · Claude Code");
  });

  it("reports a lane with a session but no live tool connection as unconnected, not as none", () => {
    liveStatus.current = null;
    const { container } = render(<SessionLiveStatusCard configuredTier="core" />);

    expect(identityOf(container)).toBe("Project · Session 1 · Claude Code");
    expect(container.textContent).toContain("Not connected to Daintree's tools");
    expect(container.textContent).not.toContain("None.");
  });

  it("says a lane with nothing in it has no session", () => {
    dock.current = {
      ...dock.current,
      sessions: { 0: { sessionId: null, agentId: null, terminalId: null } },
    };
    const { container } = render(<SessionLiveStatusCard configuredTier="core" />);

    expect(identityOf(container)).toBe("Project · Session 1");
    expect(container.textContent).toContain("None. Open the assistant to start one");
  });

  it("approves an automation grant only for the lane it names, never with tools picked for another", async () => {
    const { container, getByRole, getByLabelText, rerender } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );
    fireEvent.click(getByLabelText(/recipe\.run/));

    dock.current = { ...dock.current, activeSlot: 1, sessions: { 0: LANE_ONE, 1: LANE_TWO } };
    rerender(<SessionLiveStatusCard configuredTier="core" />);

    expect(identityOf(container)).toBe("Project · Session 2 · Codex");
    expect(getByLabelText(/recipe\.run/).dataset.state).toBe("unchecked");
    fireEvent.click(getByRole("button", { name: "Approve grant" }));
    expect(issueNativeGrant).not.toHaveBeenCalled();

    fireEvent.click(getByLabelText(/worktree\.deleteOwned/));
    fireEvent.click(getByRole("button", { name: "Approve grant" }));
    expect(issueNativeGrant).toHaveBeenCalledTimes(1);
    expect(issueNativeGrant).toHaveBeenCalledWith(
      expect.objectContaining({ helpSessionId: "help-2", allowedTools: ["worktree.deleteOwned"] })
    );
    await waitFor(() =>
      expect(getByLabelText(/worktree\.deleteOwned/).dataset.state).toBe("unchecked")
    );
  });
});

describe("SessionLiveStatusCard with Global selected in the dock (#14990)", () => {
  beforeEach(() => {
    dock.current = { ...dock.current, globalSelected: true };
  });

  it("describes the running global assistant, never the connected project lane behind it", async () => {
    getGlobalAssistantState.mockResolvedValue(globalRunning());
    const { container, findByText, queryByRole } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );

    expect(await findByText(/^Running\./)).toBeTruthy();
    expect(identityOf(container)).toBe("Global · Claude Code");
    expect(container.textContent).not.toContain("None.");
    expect(container.textContent).not.toContain("Session 1");
    expect(useLiveStatus).not.toHaveBeenCalled();
    expect(queryByRole("button", { name: "Approve grant" })).toBeNull();
    expect(queryByRole("button", { name: /^Revoke/ })).toBeNull();
  });

  it("follows the run's lifecycle as main broadcasts it", async () => {
    const { container, findByText } = render(<SessionLiveStatusCard configuredTier="core" />);
    expect(await findByText(/^Not running\./)).toBeTruthy();
    expect(identityOf(container)).toBe("Global");

    pushGlobal(globalView({ phase: "launching", generation: 1, agentId: "codex" }));
    expect(container.textContent).toContain("Starting…");
    expect(identityOf(container)).toBe("Global · Codex");

    pushGlobal(globalRunning({ agentId: "codex" }));
    expect(container.textContent).toContain("Running.");
  });

  it("keeps a change pushed while the first read is in flight over that read's answer", async () => {
    let answer: ((state: GlobalAssistantView) => void) | undefined;
    getGlobalAssistantState.mockReturnValue(
      new Promise<GlobalAssistantView>((resolve) => {
        answer = resolve;
      })
    );
    const { container } = render(<SessionLiveStatusCard configuredTier="core" />);
    expect(globalListeners.size).toBe(1);

    pushGlobal(globalRunning());
    await act(async () => {
      answer?.(globalView());
    });

    expect(container.textContent).toContain("Running.");
    expect(container.textContent).not.toContain("Not running");
  });

  it("says the read failed, and reads again on Retry", async () => {
    getGlobalAssistantState.mockRejectedValueOnce(new Error("bridge down"));
    getGlobalAssistantState.mockResolvedValueOnce(globalRunning());
    const { findByRole, findByText, getByRole } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );

    expect((await findByRole("alert")).textContent).toContain(
      "Couldn't read the global assistant's state"
    );
    fireEvent.click(getByRole("button", { name: "Retry" }));

    expect(await findByText(/^Running\./)).toBeTruthy();
    expect(getGlobalAssistantState).toHaveBeenCalledTimes(2);
    expect(globalListeners.size).toBe(1);
  });

  it("says the exact run the dock opened has ended, without naming its successor", async () => {
    dock.current = { ...dock.current, globalTarget: globalSubject(1) };
    getGlobalAssistantState.mockResolvedValue(
      globalRunning({ agentId: "codex", subject: globalSubject(2) })
    );
    const { container, findByText } = render(<SessionLiveStatusCard configuredTier="core" />);

    expect(await findByText("The global assistant session you opened has ended")).toBeTruthy();
    expect(identityOf(container)).toBe("Global");
    expect(container.textContent).not.toContain("Running.");
  });

  it("reads nothing in a window bound to another host", () => {
    viewHostId.current = "host-2";
    const { container } = render(<SessionLiveStatusCard configuredTier="core" />);

    expect(container.textContent).toContain("This window runs on another host");
    expect(getGlobalAssistantState).not.toHaveBeenCalled();
    expect(globalListeners.size).toBe(0);
  });

  it("stops listening once the dock goes back to a project lane", async () => {
    getGlobalAssistantState.mockResolvedValue(globalRunning());
    const { container, findByText, rerender } = render(
      <SessionLiveStatusCard configuredTier="core" />
    );
    await findByText(/^Running\./);

    dock.current = { ...dock.current, globalSelected: false };
    rerender(<SessionLiveStatusCard configuredTier="core" />);

    expect(globalListeners.size).toBe(0);
    expect(identityOf(container)).toBe("Project · Session 1 · Claude Code");
    expect(useLiveStatus).toHaveBeenCalledWith("help-1");
  });
});
