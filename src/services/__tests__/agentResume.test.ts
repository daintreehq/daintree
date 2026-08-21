import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

const buildResumeCommandMock = vi.hoisted(() => vi.fn());
const buildResumeLatestCommandMock = vi.hoisted(() => vi.fn());
const reconcileBypassFlagsMock = vi.hoisted(() => vi.fn());
const resolveEffectiveBypassMock = vi.hoisted(() => vi.fn());
const reconcileInlineModeFlagMock = vi.hoisted(() => vi.fn());
const resolveEffectiveInlineModeMock = vi.hoisted(() => vi.fn());
const getEffectiveAgentConfigMock = vi.hoisted(() => vi.fn());
const agentSettingsStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
// `resumeSessionIntoPanel` reads the panel store directly, the same way the
// action definitions it is shared with do.
const activateTerminalMock = vi.hoisted(() => vi.fn());
const restoreBackgroundTerminalMock = vi.hoisted(() => vi.fn());
const addPanelMock = vi.hoisted(() => vi.fn());
const panelState = vi.hoisted(() => ({
  panelIds: [] as string[],
  panelsById: {} as Record<string, unknown>,
  activateTerminal: activateTerminalMock,
  restoreBackgroundTerminal: restoreBackgroundTerminalMock,
  addPanel: addPanelMock,
}));

vi.mock("@shared/types/agentSettings", () => ({
  buildResumeCommand: buildResumeCommandMock,
  buildResumeLatestCommand: buildResumeLatestCommandMock,
  reconcileBypassFlags: reconcileBypassFlagsMock,
  resolveEffectiveBypass: resolveEffectiveBypassMock,
  reconcileInlineModeFlag: reconcileInlineModeFlagMock,
  resolveEffectiveInlineMode: resolveEffectiveInlineModeMock,
}));
vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: getEffectiveAgentConfigMock,
}));
vi.mock("@/store/agentSettingsStore", () => ({ useAgentSettingsStore: agentSettingsStoreMock }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => panelState } }));

import {
  buildResumePanelOptions,
  findLiveResumePanelId,
  reconcileResumeLaunchFlags,
  resumeSessionIntoPanel,
  RESUME_UNAVAILABLE_MESSAGE,
} from "../agentResume";

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
  resolveEffectiveBypassMock.mockReturnValue(true);
  reconcileBypassFlagsMock.mockReturnValue(["--dangerously-skip-permissions"]);
  // Inline reconciliation is layered after bypass; pass the flags through so the
  // existing resume-command assertions (bypass token) still hold (#10876).
  resolveEffectiveInlineModeMock.mockReturnValue(false);
  reconcileInlineModeFlagMock.mockImplementation((flags: string[]) => flags);
  getEffectiveAgentConfigMock.mockReturnValue({ name: "Claude", command: "claude" });
  buildResumeCommandMock.mockReturnValue("claude --resume s-1");
  buildResumeLatestCommandMock.mockReturnValue("claude --continue");
  setPanels();
  addPanelMock.mockResolvedValue("term-new");
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
      true,
      "--dangerously-skip-permissions"
    );
    expect(result).toEqual(["--dangerously-skip-permissions"]);
  });

  it("passes an empty flag array when the session captured none", () => {
    reconcileResumeLaunchFlags({ agentId: "claude" });
    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith(
      [],
      "claude",
      true,
      "--dangerously-skip-permissions"
    );
  });

  it("passes undefined dangerousArgs when the agent has no settings entry", () => {
    reconcileResumeLaunchFlags({ agentId: "gemini" });
    expect(resolveEffectiveBypassMock).toHaveBeenCalledWith({}, "gemini", true);
    expect(reconcileBypassFlagsMock).toHaveBeenCalledWith([], "gemini", true, undefined);
  });
});

describe("buildResumePanelOptions", () => {
  it("builds terminal options with the reconciled resume command and seeds agentSessionId", () => {
    const options = buildResumePanelOptions(baseSession, { cwd: "/active", worktreeId: "wt-1" });

    expect(buildResumeCommandMock).toHaveBeenCalledWith("claude", "s-1", [
      "--dangerously-skip-permissions",
    ]);
    expect(options).toEqual({
      kind: "terminal",
      launchAgentId: "claude",
      title: "Claude",
      cwd: "/active",
      worktreeId: "wt-1",
      command: "claude --resume s-1",
      location: "grid",
      agentSessionId: "s-1",
    });
  });

  it("prefers buildResumeCommand over buildResumeLatestCommand", () => {
    const options = buildResumePanelOptions(baseSession, { cwd: "/active", worktreeId: "wt-1" });
    expect(options?.command).toBe("claude --resume s-1");
    expect(buildResumeLatestCommandMock).not.toHaveBeenCalled();
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
  it("matches a live pane carrying the session in the same worktree", () => {
    setPanels(pane("term-1"));
    expect(findLiveResumePanelId("s-1", "wt-1")).toBe("term-1");
  });

  it("ignores a pane for the same session in another worktree", () => {
    setPanels(pane("term-1", { worktreeId: "wt-2" }));
    expect(findLiveResumePanelId("s-1", "wt-1")).toBeNull();
  });

  it("ignores trashed and dialog panes, which the caller cannot be handed", () => {
    setPanels(pane("term-1", { location: "trash" }), pane("term-2", { location: "dialog" }));
    expect(findLiveResumePanelId("s-1", "wt-1")).toBeNull();
  });

  it("still matches a backgrounded pane, which already owns the transcript", () => {
    setPanels(pane("term-1", { location: "background" }));
    expect(findLiveResumePanelId("s-1", "wt-1")).toBe("term-1");
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

  it("treats an absent worktree on both sides as the same scope", () => {
    setPanels(pane("term-1", { worktreeId: undefined }));
    expect(findLiveResumePanelId("s-1", null)).toBe("term-1");
  });
});

describe("resumeSessionIntoPanel", () => {
  const target = { cwd: "/active", worktreeId: "wt-1" };

  it("spawns a pane and reports the new terminal id", async () => {
    const result = await resumeSessionIntoPanel(baseSession, target);
    expect(result).toEqual({ terminalId: "term-new", outcome: "created", worktreeId: "wt-1" });
    expect(addPanelMock).toHaveBeenCalledTimes(1);
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

  it("throws when the agent is no longer registered", async () => {
    getEffectiveAgentConfigMock.mockReturnValue(undefined);
    await expect(resumeSessionIntoPanel(baseSession, target)).rejects.toThrow(
      RESUME_UNAVAILABLE_MESSAGE
    );
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
