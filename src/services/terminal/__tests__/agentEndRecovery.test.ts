import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentExitedPayload } from "@shared/types";
import type { AgentEndObservation } from "@shared/types/ipc/agent";
import type { PanelInstance, PresetSwitchResume, PtyPanelData } from "@shared/types/panel";

const store = vi.hoisted(() => {
  const state = {
    panelsById: {} as Record<string, PanelInstance>,
    panelIds: ["pane-a"] as string[],
    restartTerminal: vi.fn(async () => {}),
    restartTerminalOnPreset: vi.fn(async () => ({ success: true })),
    restartTerminalOnAccount: vi.fn(async () => ({ success: true })),
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

const agentSettingsGet = vi.hoisted(() => vi.fn());
vi.mock("@/clients", () => ({ agentSettingsClient: { get: agentSettingsGet } }));

const saveNormalized = vi.hoisted(() => vi.fn());
vi.mock("@/store/slices/panelRegistry/persistence", () => ({ saveNormalized }));

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
  startNewAfterRefusedSwitch,
  returnAfterRefusedSwitch,
  dismissRefusedPresetSwitch,
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
      resumeRefused: false,
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
  store.state.restartTerminalOnPreset.mockReset();
  store.state.restartTerminalOnPreset.mockImplementation(async () => ({ success: true }));
  store.state.restartTerminalOnAccount.mockReset();
  store.state.restartTerminalOnAccount.mockImplementation(async () => ({ success: true }));
  agentSettingsGet.mockReset();
  agentSettingsGet.mockResolvedValue({ agents: {} });
  saveNormalized.mockReset();
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

  it("leaves a shell busy with a job no detector recognises", () => {
    store.state.panelsById = { "pane-a": pane({ activityType: "background" }) };
    handleAgentEnd(exited({ selfUpdateSucceeded: true }));

    expect(store.state.restartTerminal).not.toHaveBeenCalled();
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

  it("shares its reservation with restore recovery", async () => {
    const { reserveResumeSession } = await import("../restoreRecoveryLaunch");
    const release = reserveResumeSession("codex", "picked");
    try {
      await expect(resumeFromAgentEndOffer("pane-a", "picked")).resolves.toBe("held-elsewhere");
    } finally {
      release?.();
    }
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
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

describe("a preset switch that kept the conversation (#16045)", () => {
  const attempt: PresetSwitchResume = {
    agentId: "codex",
    sessionId: LAUNCH_ID,
    target: { kind: "preset", presetId: "company" },
    prior: {
      agentPresetId: "personal",
      env: { CODEX_HOME: "/home/me/.codex" },
      agentLaunchFlags: ["--yolo"],
      cwd: "/repo",
    },
  };

  function switched(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
    return pane({
      agentPresetId: "company",
      env: { CODEX_HOME: "/home/me/.codex-company" },
      restartKey: 3,
      presetSwitchResume: attempt,
      ...overrides,
    });
  }

  it("turns the CLI's refusal into the pane's offer, ahead of the generic one", () => {
    store.state.panelsById = { "pane-a": switched() };

    // The echoed `codex resume <id>` reads as a hint; the refusal still wins.
    handleAgentEnd(exited({ resumeRefused: true, resumeHintSeen: true }), 3);

    expect(current().presetSwitchResume).toEqual({ ...attempt, refused: true });
    expect(current().agentResumeOffer).toBeUndefined();
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(store.state.restartTerminalOnPreset).not.toHaveBeenCalled();
  });

  it("takes a refusal at a PTY exit too", () => {
    store.state.panelsById = { "pane-a": switched() };

    handleAgentEnd(exited({ resumeRefused: true }, { exitKind: "terminal" }), 3);

    expect(current().presetSwitchResume?.refused).toBe(true);
  });

  it("leaves any other end to the handling every launched run gets", () => {
    store.state.panelsById = { "pane-a": switched() };

    handleAgentEnd(exited({}), 3);

    expect(current().presetSwitchResume?.refused).toBeUndefined();
    expect(current().agentResumeOffer).toEqual({ agentId: "codex", sessionId: LAUNCH_ID });
  });

  it.each([
    ["a restart since the event arrived", switched(), 2],
    ["a pane since moved to another preset", switched({ agentPresetId: "backup" }), 3],
    ["a pane with no switch to answer", pane({ restartKey: 3 }), 3],
  ])("ignores a refusal for %s", (_label, panel, restartKey) => {
    store.state.panelsById = { "pane-a": panel };

    handleAgentEnd(exited({ resumeRefused: true }), restartKey);

    expect(current().presetSwitchResume?.refused).toBeUndefined();
  });

  it("starts a new conversation on the refusing preset when asked", async () => {
    store.state.panelsById = {
      "pane-a": switched({ presetSwitchResume: { ...attempt, refused: true } }),
    };

    await startNewAfterRefusedSwitch("pane-a");

    expect(store.state.restartTerminalOnPreset).toHaveBeenCalledWith("pane-a", "company");
  });

  /** A restart that spawned: the store bumps the pane's restart count. */
  function restartSpawns(): void {
    store.state.restartTerminal.mockImplementation(async () => {
      const panel = current();
      store.state.panelsById = {
        "pane-a": { ...panel, restartKey: (panel.restartKey ?? 0) + 1 },
      };
    });
  }

  it("goes back to the launch it left, persisted, and reopens the conversation there", async () => {
    store.state.panelsById = {
      "pane-a": switched({ presetSwitchResume: { ...attempt, refused: true } }),
    };
    restartSpawns();

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("launched");

    expect(current().agentPresetId).toBe("personal");
    expect(current().env).toEqual({ CODEX_HOME: "/home/me/.codex" });
    expect(current().presetSwitchResume).toBeUndefined();
    expect(saveNormalized).toHaveBeenCalledTimes(1);
    expect(store.state.restartTerminal).toHaveBeenCalledWith("pane-a", {
      resumeSessionId: LAUNCH_ID,
    });
  });

  it("goes back nowhere while another pane holds the conversation", async () => {
    store.state.panelsById = {
      "pane-a": switched({ presetSwitchResume: { ...attempt, refused: true } }),
      "pane-b": pane({ id: "pane-b", agentState: "working" }),
    };

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("held-elsewhere");

    expect(current().agentPresetId).toBe("company");
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });

  it("keeps the offer, and the pane as it is, while another reopen holds the conversation", async () => {
    store.state.panelsById = {
      "pane-a": switched({ presetSwitchResume: { ...attempt, refused: true } }),
    };
    const { reserveResumeSession } = await import("../restoreRecoveryLaunch");
    const release = reserveResumeSession("codex", LAUNCH_ID);
    try {
      await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("held-elsewhere");
    } finally {
      release?.();
    }

    expect(current().agentPresetId).toBe("company");
    expect(current().presetSwitchResume?.refused).toBe(true);
    expect(saveNormalized).not.toHaveBeenCalled();
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });

  it("puts the pane back on the refusing preset, offer and all, when the restart started nothing", async () => {
    // The restart refused before its spawn: the count never moved.
    store.state.panelsById = {
      "pane-a": switched({
        cwd: "/repo/company",
        conversationCwd: "/repo/origin",
        presetSwitchResume: { ...attempt, refused: true },
      }),
    };

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("unavailable");

    expect(store.state.restartTerminal).toHaveBeenCalledTimes(1);
    expect(current().agentPresetId).toBe("company");
    expect(current().env).toEqual({ CODEX_HOME: "/home/me/.codex-company" });
    expect(current().presetSwitchResume).toEqual({ ...attempt, refused: true });
    expect(current().cwd).toBe("/repo/company");
    expect(current().conversationCwd).toBe("/repo/origin");
    expect(saveNormalized).toHaveBeenCalledTimes(2);
  });

  it("leaves a folder a move set while the refused restart checked it", async () => {
    store.state.panelsById = {
      "pane-a": switched({
        cwd: "/repo/company",
        presetSwitchResume: { ...attempt, refused: true },
      }),
    };
    store.state.restartTerminal.mockImplementation(async () => {
      store.state.panelsById = {
        "pane-a": { ...current(), cwd: "/moved", conversationCwd: "/repo" },
      };
    });

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("unavailable");

    expect(current().agentPresetId).toBe("company");
    expect(current().cwd).toBe("/moved");
    expect(current().conversationCwd).toBe("/repo");
  });

  it("holds the conversation for the whole restart, and lets it go after", async () => {
    store.state.panelsById = {
      "pane-a": switched({ presetSwitchResume: { ...attempt, refused: true } }),
    };
    const { isResumeSessionReserved } = await import("../restoreRecoveryLaunch");
    let finish: () => void = () => {};
    store.state.restartTerminal.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    );

    const back = returnAfterRefusedSwitch("pane-a");
    await Promise.resolve();
    expect(isResumeSessionReserved("codex", LAUNCH_ID)).toBe(true);

    finish();
    await back;
    expect(isResumeSessionReserved("codex", LAUNCH_ID)).toBe(false);
  });

  it("reads a pane that never restarted as a restart count of zero", () => {
    store.state.panelsById = { "pane-a": switched({ restartKey: undefined }) };

    // An event read before a switch that has since bumped the count to one.
    handleAgentEnd(exited({ resumeRefused: true }), 0);
    expect(current().presetSwitchResume?.refused).toBe(true);

    store.state.panelsById = { "pane-a": switched({ restartKey: 1 }) };
    handleAgentEnd(exited({ resumeRefused: true }), 0);
    expect(current().presetSwitchResume?.refused).toBeUndefined();
  });

  it("acts on neither choice once the shell has moved on", async () => {
    store.state.panelsById = {
      "pane-a": switched({
        presetSwitchResume: { ...attempt, refused: true },
        detectedProcessId: "npm",
      }),
    };

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("unavailable");
    await expect(startNewAfterRefusedSwitch("pane-a")).resolves.toEqual({
      success: false,
      error: "unavailable",
    });
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(store.state.restartTerminalOnPreset).not.toHaveBeenCalled();
  });

  it("acts on neither choice before the CLI refused", async () => {
    store.state.panelsById = { "pane-a": switched() };

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("unavailable");
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });

  it("clears the offer on dismissal", () => {
    store.state.panelsById = {
      "pane-a": switched({ presetSwitchResume: { ...attempt, refused: true } }),
    };

    dismissRefusedPresetSwitch("pane-a");

    expect(current().presetSwitchResume).toBeUndefined();
  });
});

describe("an account switch that kept the conversation (#16135)", () => {
  const COMPANY = "/home/me/.codex-company";
  const PERSONAL = "/home/me/.codex-personal";
  const attempt: PresetSwitchResume = {
    agentId: "codex",
    sessionId: LAUNCH_ID,
    target: { kind: "account", accountId: "company" },
    prior: {
      agentPresetId: "zai",
      agentAccountId: "personal",
      env: { OPENAI_BASE_URL: "https://zai", CODEX_HOME: PERSONAL },
      cwd: "/repo",
    },
  };

  function switched(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
    return pane({
      agentPresetId: "zai",
      agentAccountId: "company",
      env: { OPENAI_BASE_URL: "https://zai", CODEX_HOME: COMPANY },
      restartKey: 3,
      presetSwitchResume: attempt,
      ...overrides,
    });
  }

  function refused(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
    return switched({ presetSwitchResume: { ...attempt, refused: true }, ...overrides });
  }

  function restartSpawns(): void {
    store.state.restartTerminal.mockImplementation(async () => {
      const panel = current();
      store.state.panelsById = {
        "pane-a": { ...panel, restartKey: (panel.restartKey ?? 0) + 1 },
      };
    });
  }

  it("turns the CLI's refusal on the new account into the pane's offer, starting nothing", () => {
    store.state.panelsById = {
      "pane-a": switched({ agentResumeOffer: { agentId: "codex", sessionId: LAUNCH_ID } }),
    };

    handleAgentEnd(exited({ resumeRefused: true, resumeHintSeen: true }), 3);

    expect(current().presetSwitchResume).toEqual({ ...attempt, refused: true });
    expect(current().agentResumeOffer).toBeUndefined();
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(store.state.restartTerminalOnAccount).not.toHaveBeenCalled();
    expect(store.state.restartTerminalOnPreset).not.toHaveBeenCalled();
  });

  it("takes a refusal on the default login, which the pane records as no account", () => {
    const toDefault: PresetSwitchResume = {
      ...attempt,
      target: { kind: "account", accountId: null },
    };
    store.state.panelsById = {
      "pane-a": switched({
        agentAccountId: undefined,
        env: { OPENAI_BASE_URL: "https://zai" },
        presetSwitchResume: toDefault,
      }),
    };

    handleAgentEnd(exited({ resumeRefused: true }, { exitKind: "terminal" }), 3);

    expect(current().presetSwitchResume?.refused).toBe(true);
  });

  it.each([
    ["a pane since moved to another account", switched({ agentAccountId: "other" }), 3],
    ["a pane since moved to the default login", switched({ agentAccountId: undefined }), 3],
    ["a restart since the event arrived", switched(), 2],
  ])("ignores a refusal for %s", (_label, panel, restartKey) => {
    store.state.panelsById = { "pane-a": panel };

    handleAgentEnd(exited({ resumeRefused: true }), restartKey);

    // Left as it was, still watching, not dropped.
    expect(current().presetSwitchResume).toBe(attempt);
  });

  it.each([
    ["moved to another account", { agentAccountId: "other" }],
    ["moved to the default login", { agentAccountId: undefined }],
  ])("acts on neither choice once a pane with a refused offer has %s", async (_label, moved) => {
    store.state.panelsById = { "pane-a": refused(moved) };

    await expect(startNewAfterRefusedSwitch("pane-a")).resolves.toEqual({
      success: false,
      error: "unavailable",
    });
    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("unavailable");

    expect(current().agentAccountId).toBe(moved.agentAccountId);
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
    expect(store.state.restartTerminalOnAccount).not.toHaveBeenCalled();
    expect(agentSettingsGet).not.toHaveBeenCalled();
  });

  it("starts a new conversation on the account's folder as saved now", async () => {
    agentSettingsGet.mockResolvedValue({
      agents: {
        codex: {
          accounts: [
            { id: "personal", name: "Personal", configDir: PERSONAL },
            { id: "company", name: "Company", configDir: "/home/me/.codex-moved" },
          ],
        },
      },
    });
    store.state.panelsById = { "pane-a": refused() };

    await expect(startNewAfterRefusedSwitch("pane-a")).resolves.toEqual({ success: true });

    expect(store.state.restartTerminalOnAccount).toHaveBeenCalledWith("pane-a", {
      id: "company",
      envVar: "CODEX_HOME",
      configDir: "/home/me/.codex-moved",
    });
    expect(store.state.restartTerminalOnPreset).not.toHaveBeenCalled();
  });

  it("starts a new conversation on the default login without reading an account", async () => {
    store.state.panelsById = {
      "pane-a": refused({
        agentAccountId: undefined,
        env: { OPENAI_BASE_URL: "https://zai" },
        presetSwitchResume: {
          ...attempt,
          target: { kind: "account", accountId: null },
          refused: true,
        },
      }),
    };

    await expect(startNewAfterRefusedSwitch("pane-a")).resolves.toEqual({ success: true });

    expect(store.state.restartTerminalOnAccount).toHaveBeenCalledWith("pane-a", null);
    expect(agentSettingsGet).not.toHaveBeenCalled();
  });

  it("starts nothing on an account removed since the switch, and keeps the offer", async () => {
    agentSettingsGet.mockResolvedValue({
      agents: { codex: { accounts: [{ id: "personal", name: "Personal", configDir: PERSONAL }] } },
    });
    store.state.panelsById = { "pane-a": refused() };

    const result = await startNewAfterRefusedSwitch("pane-a");

    expect(result).toEqual({ success: false, error: "Codex has no account 'company'" });
    expect(store.state.restartTerminalOnAccount).not.toHaveBeenCalled();
    expect(current().presetSwitchResume?.refused).toBe(true);
  });

  it.each([
    ["was answered meanwhile", () => switched({ presetSwitchResume: undefined })],
    [
      "refused another switch meanwhile",
      () => refused({ presetSwitchResume: { ...attempt, refused: true } }),
    ],
    ["moved account, offer and all", () => ({ ...current(), agentAccountId: "other" })],
  ])("starts nothing when the pane %s while the account was read", async (_label, next) => {
    let answer: (value: unknown) => void = () => {};
    agentSettingsGet.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    store.state.panelsById = { "pane-a": refused() };

    const startNew = startNewAfterRefusedSwitch("pane-a");
    await Promise.resolve();
    store.state.panelsById = { "pane-a": next() };
    answer({
      agents: { codex: { accounts: [{ id: "company", name: "Company", configDir: COMPANY }] } },
    });

    await expect(startNew).resolves.toEqual({ success: false, error: "unavailable" });
    expect(store.state.restartTerminalOnAccount).not.toHaveBeenCalled();
  });

  it("goes back to the account it left, folder and all, and reopens the conversation there", async () => {
    store.state.panelsById = { "pane-a": refused() };
    restartSpawns();

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("launched");

    expect(current().agentAccountId).toBe("personal");
    expect(current().env).toEqual({ OPENAI_BASE_URL: "https://zai", CODEX_HOME: PERSONAL });
    expect(current().agentPresetId).toBe("zai");
    expect(current().presetSwitchResume).toBeUndefined();
    expect(store.state.restartTerminal).toHaveBeenCalledWith("pane-a", {
      resumeSessionId: LAUNCH_ID,
    });
    // Read from the captured launch, never looked up again.
    expect(agentSettingsGet).not.toHaveBeenCalled();
  });

  it.each([
    ["its own launch layer", { OPENAI_BASE_URL: "https://zai" }],
    ["no launch layer", undefined],
  ])(
    "goes back to the default login with %s, leaving neither the account nor its folder",
    async (_label, priorEnv) => {
      store.state.panelsById = {
        "pane-a": refused({
          presetSwitchResume: {
            ...attempt,
            prior: { agentPresetId: "zai", env: priorEnv, cwd: "/repo" },
            refused: true,
          },
        }),
      };
      let seenAtRestart: PtyPanelData | undefined;
      store.state.restartTerminal.mockImplementation(async () => {
        seenAtRestart = current();
        store.state.panelsById = { "pane-a": { ...current(), restartKey: 4 } };
      });

      await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("launched");

      expect(seenAtRestart?.agentAccountId).toBeUndefined();
      expect(seenAtRestart?.env).toEqual(priorEnv);
    }
  );

  it("puts the pane back on the refusing account, offer and all, when the restart started nothing", async () => {
    store.state.panelsById = { "pane-a": refused() };
    let seenAtRestart: PtyPanelData | undefined;
    store.state.restartTerminal.mockImplementation(async () => {
      seenAtRestart = current();
    });

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("unavailable");

    // It did go back first: the restart was asked on the account the pane left.
    expect(store.state.restartTerminal).toHaveBeenCalledTimes(1);
    expect(seenAtRestart?.agentAccountId).toBe("personal");
    expect(seenAtRestart?.env?.CODEX_HOME).toBe(PERSONAL);
    expect(current().agentAccountId).toBe("company");
    expect(current().env).toEqual({ OPENAI_BASE_URL: "https://zai", CODEX_HOME: COMPANY });
    expect(current().presetSwitchResume).toEqual({ ...attempt, refused: true });
  });

  it("goes back nowhere while another pane holds the conversation", async () => {
    store.state.panelsById = {
      "pane-a": refused(),
      "pane-b": pane({ id: "pane-b", agentState: "working" }),
    };

    await expect(returnAfterRefusedSwitch("pane-a")).resolves.toBe("held-elsewhere");

    expect(current().agentAccountId).toBe("company");
    expect(store.state.restartTerminal).not.toHaveBeenCalled();
  });
});
