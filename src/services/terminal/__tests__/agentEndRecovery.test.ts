import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExitedPayload } from "@shared/types";
import type { AgentEndObservation } from "@shared/types/ipc/agent";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

const store = vi.hoisted(() => {
  const state = {
    panelsById: {} as Record<string, PanelInstance>,
    restartTerminal: vi.fn(async () => {}),
  };
  return {
    state,
    getState: () => state,
    setState: (updater: (s: typeof state) => Partial<typeof state> | typeof state) => {
      Object.assign(state, updater(state));
    },
  };
});

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: store.getState, setState: store.setState },
}));

vi.mock("@/utils/logger", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

vi.mock("@/services/agentResume", () => ({ reconcileResumeLaunchFlags: () => [] }));

vi.mock("@/utils/agentLaunchCommand", () => ({
  getCurrentLaunchCliDetail: async () => undefined,
  resolveAgentLaunchBaseCommand: (registryCommand: string) => registryCommand,
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) =>
    id === "codex" || id === "claude" ? { resume: { kind: "session-id" } } : undefined,
}));

const {
  handleAgentEnd,
  resumeFromAgentEndOffer,
  dismissAgentResumeOffer,
  _resetAgentEndRecoveryForTests,
} = await import("../agentEndRecovery");

const LAUNCH_ID = "01a124b5-0000-7000-8000-000000000001";

function pane(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "pane-a",
    kind: "terminal",
    title: "Codex",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "codex",
    agentSessionId: LAUNCH_ID,
    agentState: "exited",
    ...overrides,
  };
}

function exited(
  agentEnd: Partial<AgentEndObservation>,
  overrides: Partial<AgentExitedPayload> = {}
): AgentExitedPayload {
  return {
    terminalId: "pane-a",
    agentType: "codex",
    timestamp: 1,
    exitKind: "subcommand",
    agentEnd: {
      launchedRun: true,
      resumeHintSeen: false,
      selfUpdateSucceeded: false,
      ...agentEnd,
    },
    ...overrides,
  };
}

function current(id = "pane-a"): PtyPanelData {
  return store.state.panelsById[id] as PtyPanelData;
}

beforeEach(() => {
  _resetAgentEndRecoveryForTests();
  store.state.panelsById = { "pane-a": pane() };
  store.state.restartTerminal.mockReset();
  store.state.restartTerminal.mockImplementation(async () => {});
});

describe("handleAgentEnd", () => {
  it("relaunches the launch conversation once after a successful self-update", () => {
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).toHaveBeenCalledTimes(1);
    expect(store.state.restartTerminal).toHaveBeenCalledWith("pane-a", {
      resumeSessionId: LAUNCH_ID,
    });
    expect(current().agentResumeOffer).toBeUndefined();
  });

  it("never relaunches the same conversation twice, even across a new generation", () => {
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));
    // The relaunch is a fresh PTY whose updater "succeeds" again.
    store.state.panelsById = { "pane-a": pane({ restartKey: 1 }) };
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).toHaveBeenCalledTimes(1);
    // The second exit falls through to the manual offer instead.
    expect(current().agentResumeOffer).toEqual({ agentId: "codex", sessionId: LAUNCH_ID });
  });

  it("does not relaunch a conversation another pane already holds", () => {
    store.state.panelsById["pane-b"] = pane({ id: "pane-b", agentState: "working" });
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });

  it("offers a resume, never a retry, when the update failed or was cancelled", () => {
    handleAgentEnd(exited({ selfUpdateSucceeded: false }));

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(current().agentResumeOffer).toEqual({ agentId: "codex", sessionId: LAUNCH_ID });
  });

  it("offers the session picker to an anonymous Codex launch, and never auto-relaunches it", () => {
    store.state.panelsById = { "pane-a": pane({ agentSessionId: undefined }) };
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(current().agentResumeOffer).toEqual({ agentId: "codex" });
  });

  it("offers nothing for an anonymous launch of an agent with no picker", () => {
    store.state.panelsById = {
      "pane-a": pane({ launchAgentId: "claude", agentSessionId: undefined }),
    };
    handleAgentEnd(exited({}, { agentType: "claude" }));

    expect(current().agentResumeOffer).toBeUndefined();
  });

  it("stays quiet when the agent left its own resume hint", () => {
    handleAgentEnd(exited({ resumeHintSeen: true }));

    expect(current().agentResumeOffer).toBeUndefined();
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ["a later run in the same shell", exited({ launchedRun: false, selfUpdateSucceeded: true })],
    ["a PTY exit", exited({ selfUpdateSucceeded: true }, { exitKind: "terminal" })],
    [
      "another agent than the launch one",
      exited({ selfUpdateSucceeded: true }, { agentType: "claude" }),
    ],
    ["no observation", { ...exited({}), agentEnd: undefined }],
  ])("ignores %s", (_label, payload) => {
    handleAgentEnd(payload);

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(current().agentResumeOffer).toBeUndefined();
  });

  it("leaves a shell the user has already carried on in", () => {
    store.state.panelsById = { "pane-a": pane({ detectedProcessId: "npm" }) };
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(current().agentResumeOffer).toBeUndefined();
  });

  it("ignores a pane that is trashed or already restarting", () => {
    store.state.panelsById = { "pane-a": pane({ location: "trash" }) };
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));
    store.state.panelsById = { "pane-a": pane({ isRestarting: true }) };
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });
});

describe("resume offer actions", () => {
  it("reopens the picked conversation in place", async () => {
    await expect(resumeFromAgentEndOffer("pane-a", "picked")).resolves.toBe("launched");
    expect(store.state.restartTerminal).toHaveBeenCalledWith("pane-a", {
      resumeSessionId: "picked",
    });
  });

  it("lets only one of two concurrent picks reopen the same conversation", async () => {
    store.state.panelsById["pane-b"] = pane({ id: "pane-b", agentSessionId: undefined });
    let release: () => void = () => {};
    store.state.restartTerminal.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    );

    const first = resumeFromAgentEndOffer("pane-a", "picked");
    await expect(resumeFromAgentEndOffer("pane-b", "picked")).resolves.toBe("held-elsewhere");
    release();
    await expect(first).resolves.toBe("launched");
    expect(store.state.restartTerminal).toHaveBeenCalledTimes(1);
  });

  it("refuses a conversation a sibling pane holds", async () => {
    store.state.panelsById["pane-b"] = pane({ id: "pane-b", agentSessionId: "picked" });
    await expect(resumeFromAgentEndOffer("pane-a", "picked")).resolves.toBe("held-elsewhere");
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });

  it("clears the offer on dismissal", () => {
    store.state.panelsById = {
      "pane-a": pane({ agentResumeOffer: { agentId: "codex", sessionId: LAUNCH_ID } }),
    };
    dismissAgentResumeOffer("pane-a");
    expect(current().agentResumeOffer).toBeUndefined();
  });
});
