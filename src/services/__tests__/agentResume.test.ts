import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

const buildResumeCommandMock = vi.hoisted(() => vi.fn());
const buildResumeLatestCommandMock = vi.hoisted(() => vi.fn());
const reconcileBypassFlagsMock = vi.hoisted(() => vi.fn());
const resolveEffectiveBypassMock = vi.hoisted(() => vi.fn());
const getEffectiveAgentConfigMock = vi.hoisted(() => vi.fn());
const agentSettingsStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));

vi.mock("@shared/types/agentSettings", () => ({
  buildResumeCommand: buildResumeCommandMock,
  buildResumeLatestCommand: buildResumeLatestCommandMock,
  reconcileBypassFlags: reconcileBypassFlagsMock,
  resolveEffectiveBypass: resolveEffectiveBypassMock,
}));
vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentConfig: getEffectiveAgentConfigMock,
}));
vi.mock("@/store/agentSettingsStore", () => ({ useAgentSettingsStore: agentSettingsStoreMock }));

import { buildResumePanelOptions, reconcileResumeLaunchFlags } from "../agentResume";

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
  getEffectiveAgentConfigMock.mockReturnValue({ name: "Claude", command: "claude" });
  buildResumeCommandMock.mockReturnValue("claude --resume s-1");
  buildResumeLatestCommandMock.mockReturnValue("claude --continue");
});

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
