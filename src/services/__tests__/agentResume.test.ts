import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

const buildResumeCommandMock = vi.hoisted(() => vi.fn());
const buildResumeLatestCommandMock = vi.hoisted(() => vi.fn());
const reconcileBypassFlagsMock = vi.hoisted(() => vi.fn());
const resolveEffectiveBypassMock = vi.hoisted(() => vi.fn());
const resolveAgentRuntimeSettingsMock = vi.hoisted(() =>
  vi.fn((): { preset?: { id: string; name: string; dangerousMode?: string } } => ({}))
);
const reconcileInlineModeFlagMock = vi.hoisted(() => vi.fn());
// Outermost reconcile in the chain; a pass-through keeps every assertion on
// the inline-mode mock's return value intact.
const reconcileDecorationFlagsMock = vi.hoisted(() => vi.fn((flags: string[]) => flags));
const resolveKeepDecorationsMock = vi.hoisted(() => vi.fn(() => false));
const getEffectiveAgentConfigMock = vi.hoisted(() => vi.fn());
const agentSettingsStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
// `resumeSessionIntoPanel` reads the panel store directly, the same way the
// action definitions it is shared with do.
const activateTerminalMock = vi.hoisted(() => vi.fn());
const restoreBackgroundTerminalMock = vi.hoisted(() => vi.fn());
const addPanelMock = vi.hoisted(() => vi.fn());
// The worktree on screen, which decides whether an existing pane can be
// brought forward without moving the view.
const selection = vi.hoisted(() => ({ activeWorktreeId: "wt-1" as string | null }));
const panelState = vi.hoisted(() => ({
  panelIds: [] as string[],
  panelsById: {} as Record<string, unknown>,
  activateTerminal: activateTerminalMock,
  restoreBackgroundTerminal: restoreBackgroundTerminalMock,
  addPanel: addPanelMock,
}));

// The launch executable comes from this view's CLI detection, which these tests
// don't load: the registry command stands.
vi.mock("@/utils/agentLaunchCommand", () => ({
  resolveCurrentAgentLaunchBaseCommand: vi.fn(async () => undefined),
  getCurrentLaunchCliDetail: vi.fn(async () => undefined),
  resolveAgentLaunchBaseCommand: vi.fn((registryCommand: string) => registryCommand),
}));

vi.mock("@shared/types/agentSettings", () => ({
  buildResumeCommand: buildResumeCommandMock,
  buildResumeLatestCommand: buildResumeLatestCommandMock,
  reconcilePermissionFlags: reconcileBypassFlagsMock,
  getPluginBypassArgHistory: () => [],
  resolveEffectivePermissionLevel: resolveEffectiveBypassMock,
  userPermissionArgs: () => [],
  capturedPermissionLevel: () => "auto",
  lesserPermissionLevel: (a: string, b: string) => {
    const order = ["cli-default", "auto", "skip"];
    return order.indexOf(a) <= order.indexOf(b) ? a : b;
  },
  reconcileInlineModeFlag: reconcileInlineModeFlagMock,
  reconcileDecorationFlags: reconcileDecorationFlagsMock,
  resolveKeepDecorations: resolveKeepDecorationsMock,
}));
vi.mock("@shared/utils/agentPresets", () => ({
  applyPresetBehaviorOverrides: (
    entry: Record<string, unknown>,
    preset?: { dangerousMode?: string }
  ) => (preset ? { ...entry, dangerousMode: preset.dangerousMode } : entry),
}));
vi.mock("@/utils/agentRuntimeSettings", () => ({
  resolveAgentRuntimeSettings: resolveAgentRuntimeSettingsMock,
}));
vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: () => ({ ccrPresetsByAgent: {} }) },
}));
vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: {
    getState: () => ({ presetsByAgent: { claude: [{ id: "team" }] }, hydratedProjectId: "a" }),
  },
}));
vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: getEffectiveAgentConfigMock,
}));
vi.mock("@/store/agentSettingsStore", () => ({ useAgentSettingsStore: agentSettingsStoreMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => panelState } }));
vi.mock("@/store/storeAccessors", () => ({
  getWorktreeSelectionSnapshot: () => ({ activeWorktreeId: selection.activeWorktreeId }),
}));
// Panes an open spawn batch has committed but not yet appended to `panelIds`.
const pendingBatchIds = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/store/slices/panelRegistry/hydrationBatch", () => ({
  getPendingBatchIds: () => pendingBatchIds.ids,
}));

import {
  bringResumedPaneForward,
  buildResumePanelOptions,
  findLiveResumePanelId,
  reconcileResumeLaunchFlags,
  resumeSessionIntoPanel,
  RESUME_UNAVAILABLE_MESSAGE,
} from "../agentResume";
import { resolveCurrentAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";

const baseSession: AgentSessionRecord = {
  sessionId: "s-1",
  agentId: "claude",
  worktreeId: "wt-1",
  title: "Claude",
  projectId: null,
  savedAt: 1000,
  agentLaunchFlags: ["--dangerously-skip-permissions"],
};

beforeEach(() => {
  vi.clearAllMocks();
  agentSettingsStoreMock.getState.mockReturnValue({
    settings: {
      globalSkipPermissions: true,
      agents: { claude: { dangerousArgs: "--dangerously-skip-permissions" } },
    },
  });
  resolveEffectiveBypassMock.mockReturnValue("skip");
  resolveAgentRuntimeSettingsMock.mockReturnValue({});
  reconcileBypassFlagsMock.mockReturnValue(["--dangerously-skip-permissions"]);
  // Inline reconciliation is layered after bypass; pass the flags through so the
  // existing resume-command assertions (bypass token) still hold (#10876).
  reconcileInlineModeFlagMock.mockImplementation((flags: string[]) => flags);
  getEffectiveAgentConfigMock.mockReturnValue({ name: "Claude", command: "claude" });
  buildResumeCommandMock.mockReturnValue("claude --resume s-1");
  buildResumeLatestCommandMock.mockReturnValue("claude --continue");
  setPanels();
  addPanelMock.mockResolvedValue("term-new");
  selection.activeWorktreeId = "wt-1";
  pendingBatchIds.ids = [];
});

function pane(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal",
    location: "grid",
    agentSessionId: "s-1",
    worktreeId: "wt-1",
    ...overrides,
  };
}

function setPanels(...panes: Array<{ id: string }>) {
  panelState.panelIds = panes.map((p) => p.id);
  panelState.panelsById = Object.fromEntries(panes.map((p) => [p.id, p]));
}

describe("reconcileResumeLaunchFlags", () => {
  it("resolves effective bypass from the live settings store and reconciles flags", () => {
    const result = reconcileResumeLaunchFlags(baseSession);

    expect(resolveEffectiveBypassMock).toHaveBeenCalledWith(
      { dangerousArgs: "--dangerously-skip-permissions" },
      "claude",
      true
    );
    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith(
      ["--dangerously-skip-permissions"],
      "claude",
      "skip",
      {
        bypassArgs: "--dangerously-skip-permissions",
        pluginBypassArgHistory: [],
        userArgs: [],
        carriedArgs: [],
      }
    );
    expect(result).toEqual(["--dangerously-skip-permissions"]);
  });

  it("passes an empty flag array when the session captured none", () => {
    reconcileResumeLaunchFlags({ agentId: "claude" });
    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith([], "claude", "skip", {
      bypassArgs: "--dangerously-skip-permissions",
      pluginBypassArgHistory: [],
      userArgs: [],
      carriedArgs: [],
    });
  });

  it("passes undefined dangerousArgs when the agent has no settings entry", () => {
    reconcileResumeLaunchFlags({ agentId: "gemini" });
    expect(resolveEffectiveBypassMock).toHaveBeenCalledWith({}, "gemini", true);
    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith([], "gemini", "skip", {
      bypassArgs: undefined,
      pluginBypassArgHistory: [],
      userArgs: [],
      carriedArgs: [],
    });
  });

  // #13046: the caller's verbatim tail never reaches the reconcile, and comes
  // back unchanged after it.
  it("reconciles only the settings-derived flags and re-appends the caller's", () => {
    const result = reconcileResumeLaunchFlags({
      agentId: "claude",
      agentLaunchFlags: ["--dangerously-skip-permissions", "--effort", "high"],
      callerLaunchFlags: ["--effort", "high"],
    });

    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith(
      ["--dangerously-skip-permissions"],
      "claude",
      "skip",
      {
        bypassArgs: "--dangerously-skip-permissions",
        pluginBypassArgHistory: [],
        userArgs: [],
        carriedArgs: ["--effort", "high"],
      }
    );
    expect(result).toEqual(["--dangerously-skip-permissions", "--effort", "high"]);
  });

  // #17435: a scheduled run resumes on the preset it ran on, so an Auto preset
  // under an agent set to Skip all isn't resolved as Skip all.
  it("resolves the record's preset over the agent's own mode", () => {
    resolveAgentRuntimeSettingsMock.mockReturnValue({
      preset: { id: "reviewed", name: "Reviewed", dangerousMode: "auto" },
    });
    reconcileResumeLaunchFlags({ ...baseSession, agentPresetId: "reviewed" });
    expect(resolveAgentRuntimeSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude", presetId: "reviewed" })
    );
    expect(resolveEffectiveBypassMock).toHaveBeenCalledWith(
      { dangerousArgs: "--dangerously-skip-permissions", dangerousMode: "auto" },
      "claude",
      true
    );
  });

  it("resumes on the agent's own settings when the record names no preset", () => {
    reconcileResumeLaunchFlags(baseSession);
    expect(resolveAgentRuntimeSettingsMock).not.toHaveBeenCalled();
    expect(reconcileBypassFlagsMock).toHaveBeenCalled();
  });

  it("resumes an unreadable preset at the lesser of its captured level and the agent's", () => {
    reconcileResumeLaunchFlags({ ...baseSession, agentPresetId: "gone" });
    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith(
      ["--dangerously-skip-permissions"],
      "claude",
      "auto",
      expect.anything()
    );
  });

  it("reads project presets only when the store holds the record's own project", () => {
    reconcileResumeLaunchFlags({ ...baseSession, agentPresetId: "team", projectId: "a" });
    expect(resolveAgentRuntimeSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectPresets: [{ id: "team" }] })
    );
    reconcileResumeLaunchFlags({ ...baseSession, agentPresetId: "team", projectId: "b" });
    expect(resolveAgentRuntimeSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectPresets: undefined })
    );
  });
});

describe("buildResumePanelOptions", () => {
  it("builds terminal options with the reconciled resume command and seeds agentSessionId", () => {
    const options = buildResumePanelOptions(baseSession, { cwd: "/active", worktreeId: "wt-1" });

    expect(buildResumeCommandMock).toHaveBeenCalledWith(
      "claude",
      "s-1",
      ["--dangerously-skip-permissions"],
      undefined
    );
    expect(options).toEqual({
      kind: "terminal",
      launchAgentId: "claude",
      title: "Claude",
      cwd: "/active",
      worktreeId: "wt-1",
      command: "claude --resume s-1",
      location: "grid",
      agentLaunchFlags: ["--dangerously-skip-permissions"],
      agentSessionId: "s-1",
    });
  });

  it("keeps the preset the record resolved on the resumed pane, and none it couldn't find", () => {
    resolveAgentRuntimeSettingsMock.mockReturnValue({
      preset: { id: "reviewed", name: "Reviewed", dangerousMode: "auto" },
    });
    expect(
      buildResumePanelOptions({ ...baseSession, agentPresetId: "reviewed" }, { cwd: "/active" })
        ?.agentPresetId
    ).toBe("reviewed");

    resolveAgentRuntimeSettingsMock.mockReturnValue({});
    expect(
      buildResumePanelOptions({ ...baseSession, agentPresetId: "gone" }, { cwd: "/active" })
    ).not.toHaveProperty("agentPresetId");
  });

  it("reopens a conversation from the account folder its record names (#17087)", () => {
    const store = { sessionId: "s-1", configDir: "/home/me/.claude-company" };

    expect(
      buildResumePanelOptions({ ...baseSession, conversationStore: store }, { cwd: "/active" })
        ?.conversationStore
    ).toEqual(store);
    expect(
      buildResumePanelOptions(
        { ...baseSession, conversationStore: { ...store, sessionId: "s-other" } },
        { cwd: "/active" }
      )?.conversationStore
    ).toBeUndefined();
  });

  // A resumed pane restarts from its stored flags, so dropping them would lose
  // the standing instruction (and model) on its first restart (#12431).
  it("stores the reconciled flags, not the captured ones, on the resumed pane", () => {
    const captured = ["--append-system-prompt", "Be terse", "--dangerously-skip-permissions"];
    const reconciled = ["--append-system-prompt", "Be terse"];
    reconcileBypassFlagsMock.mockReturnValue(reconciled);
    const options = buildResumePanelOptions(
      { ...baseSession, agentLaunchFlags: captured },
      { cwd: "/active" }
    );
    expect(options?.agentLaunchFlags).toEqual(reconciled);
  });

  // Tokens injected into an empty snapshot only serve the resume command; stored,
  // they would pass for a complete configuration and skip the settings rebuild.
  it("stores no flags when the record captured none, even if reconciliation injects some", () => {
    reconcileBypassFlagsMock.mockReturnValue(["--dangerously-skip-permissions"]);
    const options = buildResumePanelOptions(
      { ...baseSession, agentLaunchFlags: undefined },
      { cwd: "/active" }
    );
    expect(buildResumeCommandMock).toHaveBeenCalledWith(
      "claude",
      "s-1",
      ["--dangerously-skip-permissions"],
      undefined
    );
    expect(options?.agentLaunchFlags).toBeUndefined();
  });

  // The copy the host detected, or the one chosen for this agent, rather than
  // whichever copy PATH reaches first (#16399).
  it("starts the given executable when one is passed", () => {
    buildResumePanelOptions(baseSession, { cwd: "/active" }, "'/opt/claude-2/bin/claude'");
    expect(buildResumeCommandMock).toHaveBeenCalledWith(
      "claude",
      "s-1",
      ["--dangerously-skip-permissions"],
      "'/opt/claude-2/bin/claude'"
    );
  });

  it("falls back to buildResumeLatestCommand when no exact-session command exists", () => {
    buildResumeCommandMock.mockReturnValue(undefined);
    const options = buildResumePanelOptions(baseSession, { cwd: "/active", worktreeId: "wt-1" });
    expect(options?.command).toBe("claude --continue");
  });

  it("returns null when neither resume command is available", () => {
    buildResumeCommandMock.mockReturnValue(undefined);
    buildResumeLatestCommandMock.mockReturnValue(undefined);
    expect(buildResumePanelOptions(baseSession, { cwd: "/active" })).toBeNull();
  });

  it("returns null when the agent has no effective config", () => {
    getEffectiveAgentConfigMock.mockReturnValue(undefined);
    expect(buildResumePanelOptions(baseSession, { cwd: "/active" })).toBeNull();
  });

  it("returns null for a malformed record missing sessionId", () => {
    const malformed = { ...baseSession, sessionId: "" };
    expect(buildResumePanelOptions(malformed, { cwd: "/active" })).toBeNull();
    expect(getEffectiveAgentConfigMock).not.toHaveBeenCalled();
  });

  it("returns null for a malformed record missing agentId", () => {
    const malformed = { ...baseSession, agentId: "" };
    expect(buildResumePanelOptions(malformed, { cwd: "/active" })).toBeNull();
  });
});

/**
 * The focus-or-spawn half, shared by the human resume hook and the
 * `agentSessionHistory.resume` action (#11908). These pin the behavior that
 * would silently diverge if either surface grew its own copy: which live panes
 * answer for a session, and what happens when two dispatches race the async
 * `addPanel` window.
 */
describe("findLiveResumePanelId", () => {
  it("matches a live pane carrying the session", () => {
    setPanels(pane("term-1"));
    expect(findLiveResumePanelId("s-1")).toBe("term-1");
  });

  it("matches a pane for the session wherever it is filed (#18009)", () => {
    // A live move refiles the pane under another worktree without touching the
    // agent, which still holds the conversation.
    setPanels(pane("term-1", { worktreeId: "wt-2" }));
    expect(findLiveResumePanelId("s-1")).toBe("term-1");
  });

  it("ignores a pane carrying another session", () => {
    setPanels(pane("term-1", { agentSessionId: "s-2" }));
    expect(findLiveResumePanelId("s-1")).toBeNull();
  });

  it("ignores trashed and dialog panes, which the caller cannot be handed", () => {
    setPanels(pane("term-1", { location: "trash" }), pane("term-2", { location: "dialog" }));
    expect(findLiveResumePanelId("s-1")).toBeNull();
  });

  it("still matches a backgrounded pane, which already owns the transcript", () => {
    setPanels(pane("term-1", { location: "background" }));
    expect(findLiveResumePanelId("s-1")).toBe("term-1");
  });

  it("reveals a backgrounded pane rather than reporting a focus nothing can see", async () => {
    // `activateTerminal` moves selection but never restores location, so
    // activating a hidden pane on its own would report `activatedExisting`
    // while the grid stayed unchanged.
    setPanels(pane("term-1", { location: "background" }));
    const result = await resumeSessionIntoPanel(baseSession, {
      cwd: "/active",
      worktreeId: "wt-1",
    });

    expect(restoreBackgroundTerminalMock).toHaveBeenCalledWith("term-1");
    expect(activateTerminalMock).toHaveBeenCalledWith("term-1");
    expect(result.outcome).toBe("activatedExisting");
  });

  it("does not try to restore a pane that is already in the grid", async () => {
    setPanels(pane("term-1"));
    await resumeSessionIntoPanel(baseSession, { cwd: "/active", worktreeId: "wt-1" });

    expect(restoreBackgroundTerminalMock).not.toHaveBeenCalled();
    expect(activateTerminalMock).toHaveBeenCalledWith("term-1");
  });

  it("matches a pane filed under no worktree", () => {
    setPanels(pane("term-1", { worktreeId: undefined }));
    expect(findLiveResumePanelId("s-1")).toBe("term-1");
  });

  it("passes over panes that don't hold the session to the one that does", () => {
    setPanels(
      pane("term-other", { agentSessionId: "s-2" }),
      pane("term-dialog", { location: "dialog" }),
      pane("term-trash", { location: "trash" }),
      pane("term-shell", { agentState: "exited" }),
      pane("term-holder", { worktreeId: "wt-3" })
    );
    expect(findLiveResumePanelId("s-1")).toBe("term-holder");
  });

  it("ignores a pane whose agent quit back to its shell, though it still names the session", () => {
    setPanels(pane("term-1", { worktreeId: "wt-2", agentState: "exited" }));
    expect(findLiveResumePanelId("s-1")).toBeNull();
  });

  it("finds a pane a spawn batch is still holding back from the panel order", () => {
    setPanels();
    panelState.panelsById = { "term-batched": pane("term-batched", { worktreeId: "wt-2" }) };
    pendingBatchIds.ids = ["term-batched"];
    expect(findLiveResumePanelId("s-1")).toBe("term-batched");
  });
});

describe("bringResumedPaneForward", () => {
  it("shows the pane's own worktree, then restores and focuses it", () => {
    const order: string[] = [];
    setPanels(pane("term-9", { worktreeId: "wt-2", location: "background" }));
    restoreBackgroundTerminalMock.mockImplementation(() => order.push("restore"));
    activateTerminalMock.mockImplementation(() => order.push("activate"));
    // Reported as filed elsewhere: where it is filed now is what counts.
    bringResumedPaneForward(
      { terminalId: "term-9", outcome: "created", worktreeId: "wt-1" },
      (id) => order.push(`show:${id}`)
    );
    expect(order).toEqual(["show:wt-2", "restore", "activate"]);
  });

  it("leaves a pane closed into the trash while it opened where it is", () => {
    setPanels(pane("term-9", { worktreeId: "wt-2", location: "trash" }));
    const show = vi.fn();
    bringResumedPaneForward({ terminalId: "term-9", outcome: "created", worktreeId: "wt-2" }, show);
    expect(show).not.toHaveBeenCalled();
    expect(activateTerminalMock).not.toHaveBeenCalled();
  });

  it("does nothing for a pane that has gone", () => {
    setPanels();
    const show = vi.fn();
    bringResumedPaneForward(
      { terminalId: "term-gone", outcome: "created", worktreeId: "wt-2" },
      show
    );
    expect(show).not.toHaveBeenCalled();
    expect(activateTerminalMock).not.toHaveBeenCalled();
  });
});

describe("resumeSessionIntoPanel", () => {
  const target = { cwd: "/active", worktreeId: "wt-1" };

  it("spawns a pane and reports the new terminal id", async () => {
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toEqual({ terminalId: "term-new", outcome: "created", worktreeId: "wt-1" });
    expect(addPanelMock).toHaveBeenCalledTimes(1);
  });

  it("resumes with the executable a launch of this agent starts now (#16399)", async () => {
    vi.mocked(resolveCurrentAgentLaunchBaseCommand).mockResolvedValueOnce("'/chosen/claude'");
    await resumeSessionIntoPanel(baseSession, target);
    expect(resolveCurrentAgentLaunchBaseCommand).toHaveBeenCalledWith("claude");
    expect(buildResumeCommandMock).toHaveBeenCalledWith(
      "claude",
      "s-1",
      expect.any(Array),
      "'/chosen/claude'"
    );
  });

  it("focuses the live pane instead of opening a second agent on one transcript", async () => {
    setPanels(pane("term-1"));
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toEqual({
      terminalId: "term-1",
      outcome: "activatedExisting",
      worktreeId: "wt-1",
    });
    expect(activateTerminalMock).toHaveBeenCalledWith("term-1");
    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("hands back a pane filed under another worktree rather than opening a second (#18009)", async () => {
    // A live move refiles the pane without touching its process, so the record
    // can still name the worktree the conversation began in.
    setPanels(pane("term-moved", { worktreeId: "wt-2" }));
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toEqual({
      terminalId: "term-moved",
      outcome: "activatedExisting",
      worktreeId: "wt-2",
    });
    expect(addPanelMock).not.toHaveBeenCalled();
    expect(activateTerminalMock).not.toHaveBeenCalled();
  });

  it("leaves a headless caller's view alone when the live pane is in another worktree", async () => {
    // Activating it could follow focus into its worktree; the caller gets the
    // id and where the pane is filed, and addresses it from there.
    setPanels(pane("term-moved", { worktreeId: "wt-2", location: "background" }));
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toEqual({
      terminalId: "term-moved",
      outcome: "activatedExisting",
      worktreeId: "wt-2",
    });
    expect(activateTerminalMock).not.toHaveBeenCalled();
    expect(restoreBackgroundTerminalMock).not.toHaveBeenCalled();
    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("shows the live pane's own worktree first when the caller may move the view", async () => {
    const order: string[] = [];
    setPanels(pane("term-moved", { worktreeId: "wt-2", location: "background" }));
    restoreBackgroundTerminalMock.mockImplementation(() => order.push("restore"));
    activateTerminalMock.mockImplementation(() => order.push("activate"));
    const showWorktree = vi.fn((id: string) => order.push(`show:${id}`));
    await resumeSessionIntoPanel(baseSession, target, { showWorktree });
    // Its own worktree, not the record's, and restored without being refiled.
    expect(order).toEqual(["show:wt-2", "restore", "activate"]);
    expect(restoreBackgroundTerminalMock).toHaveBeenCalledWith("term-moved");
    expect(activateTerminalMock).toHaveBeenCalledWith("term-moved");
  });

  it("leaves a headless caller's view alone for a pane filed under no worktree", async () => {
    setPanels(pane("term-loose", { worktreeId: undefined, location: "background" }));
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toMatchObject({ terminalId: "term-loose", worktreeId: null });
    expect(activateTerminalMock).not.toHaveBeenCalled();
    expect(restoreBackgroundTerminalMock).not.toHaveBeenCalled();
  });

  it("lets a joiner try under its own checks when the starter's own checks refused", async () => {
    // The joiner joins synchronously; the starter's check runs a tick later.
    const starter = resumeSessionIntoPanel(baseSession, target, {
      validateSpawn: () => {
        throw new Error("not from the worktree it named");
      },
    });
    const joiner = resumeSessionIntoPanel(baseSession, { cwd: "/other", worktreeId: "wt-2" });

    await expect(starter).rejects.toThrow("not from the worktree it named");
    await expect(joiner).resolves.toMatchObject({ terminalId: "term-new", outcome: "created" });
    expect(addPanelMock).toHaveBeenCalledTimes(1);
  });

  it("shares any other failure with a joiner rather than launching again", async () => {
    addPanelMock.mockResolvedValueOnce(null);
    const starter = resumeSessionIntoPanel(baseSession, target);
    const joiner = resumeSessionIntoPanel(baseSession, target);
    await expect(starter).rejects.toThrow(/closed before it finished opening/i);
    await expect(joiner).rejects.toThrow(/closed before it finished opening/i);
    expect(addPanelMock).toHaveBeenCalledTimes(1);
  });

  it("reports where the new pane is filed once it opens", async () => {
    // Moved while `addPanel` awaited its PTY prewarm.
    addPanelMock.mockImplementationOnce(async () => {
      setPanels(pane("term-new", { worktreeId: "wt-2" }));
      return "term-new";
    });
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toEqual({ terminalId: "term-new", outcome: "created", worktreeId: "wt-2" });
  });

  it("runs the spawn-only checks for a new launch and never for a live pane", async () => {
    const validateSpawn = vi.fn(() => {
      throw new Error("refused for a new launch");
    });
    const onBeforeSpawn = vi.fn();
    await expect(
      resumeSessionIntoPanel(baseSession, target, { validateSpawn, onBeforeSpawn })
    ).rejects.toThrow("refused for a new launch");
    expect(addPanelMock).not.toHaveBeenCalled();
    // A refused launch moves nothing.
    expect(onBeforeSpawn).not.toHaveBeenCalled();

    validateSpawn.mockClear();
    setPanels(pane("term-moved", { worktreeId: "wt-2" }));
    await expect(
      resumeSessionIntoPanel(baseSession, target, { validateSpawn })
    ).resolves.toMatchObject({ terminalId: "term-moved", outcome: "activatedExisting" });
    expect(validateSpawn).not.toHaveBeenCalled();
  });

  it("shares one launch between resumes aiming the session at different worktrees", async () => {
    let settle: (id: string) => void = () => {};
    addPanelMock.mockReturnValue(
      new Promise<string>((resolve) => {
        settle = resolve;
      })
    );
    const first = resumeSessionIntoPanel(baseSession, target);
    const second = resumeSessionIntoPanel(baseSession, { cwd: "/other", worktreeId: "wt-2" });
    settle("term-new");
    const [a, b] = await Promise.all([first, second]);

    expect(addPanelMock).toHaveBeenCalledTimes(1);
    // The joiner is told where the one pane is filed, not where it aimed.
    expect(b).toEqual(a);
    expect(a.worktreeId).toBe("wt-1");
  });

  it("hands back a pane that took the session while the launch was being prepared", async () => {
    vi.mocked(resolveCurrentAgentLaunchBaseCommand).mockImplementationOnce(async () => {
      setPanels(pane("term-restored", { worktreeId: "wt-2" }));
      return undefined;
    });
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toMatchObject({ terminalId: "term-restored", outcome: "activatedExisting" });
    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("collapses overlapping dispatches onto one spawn and one terminal id", async () => {
    // The live-pane scan cannot catch this on its own: the second caller runs it
    // inside the first one's await window, before any panel exists to find.
    let settle: (id: string) => void = () => {};
    addPanelMock.mockReturnValue(
      new Promise<string>((resolve) => {
        settle = resolve;
      })
    );
    const first = resumeSessionIntoPanel(baseSession, target);
    const second = resumeSessionIntoPanel(baseSession, target);
    settle("term-new");
    const [a, b] = await Promise.all([first, second]);

    expect(addPanelMock).toHaveBeenCalledTimes(1);
    expect(a.terminalId).toBe("term-new");
    expect(b.terminalId).toBe(a.terminalId);
  });

  it("releases the in-flight slot so a later resume can spawn again", async () => {
    await resumeSessionIntoPanel(baseSession, target);
    await resumeSessionIntoPanel(baseSession, target);
    expect(addPanelMock).toHaveBeenCalledTimes(2);
  });

  it("runs onBeforeSpawn before addPanel, so a worktree switch lands first", async () => {
    const order: string[] = [];
    addPanelMock.mockImplementation(async () => {
      order.push("addPanel");
      return "term-new";
    });
    await resumeSessionIntoPanel(baseSession, target, {
      onBeforeSpawn: () => order.push("onBeforeSpawn"),
    });
    expect(order).toEqual(["onBeforeSpawn", "addPanel"]);
  });

  it("skips onBeforeSpawn entirely when an existing pane answers the resume", async () => {
    setPanels(pane("term-1"));
    const onBeforeSpawn = vi.fn();
    await resumeSessionIntoPanel(baseSession, target, { onBeforeSpawn });
    expect(onBeforeSpawn).not.toHaveBeenCalled();
  });

  it("throws when the agent has no buildable resume command", async () => {
    buildResumeCommandMock.mockReturnValue(undefined);
    buildResumeLatestCommandMock.mockReturnValue(undefined);
    await expect(resumeSessionIntoPanel(baseSession, target)).rejects.toThrow(
      RESUME_UNAVAILABLE_MESSAGE
    );
    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("throws rather than fabricating an id when the panel vanishes mid-spawn", async () => {
    addPanelMock.mockResolvedValue(null);
    await expect(resumeSessionIntoPanel(baseSession, target)).rejects.toThrow(
      /closed before it finished opening/i
    );
  });

  it("frees the in-flight slot after a failure so a retry is not swallowed", async () => {
    addPanelMock.mockResolvedValueOnce(null);
    await expect(resumeSessionIntoPanel(baseSession, target)).rejects.toThrow();
    addPanelMock.mockResolvedValue("term-new");
    await expect(resumeSessionIntoPanel(baseSession, target)).resolves.toMatchObject({
      terminalId: "term-new",
    });
  });
});
