import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

const mockResourceAction = vi.fn();

// Stub all external imports that worktreeActions.ts pulls in
vi.mock("@/clients", () => ({
  copyTreeClient: {},
  githubClient: {},
  systemClient: {},
  worktreeClient: { resourceAction: mockResourceAction },
  projectClient: {},
}));

const mockWorktrees = new Map<string, Record<string, unknown>>();

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: mockWorktrees }) }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({}) },
}));

vi.mock("@/lib/copyTreeFormat", () => ({
  DEFAULT_COPYTREE_FORMAT: "text",
}));

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: { getState: () => ({ addTerminal: vi.fn() }) },
}));

type ActionFactory = () => AnyActionDefinition;

const RESOURCE_ACTION_IDS = [
  "worktree.resource.provision",
  "worktree.resource.teardown",
  "worktree.resource.resume",
  "worktree.resource.pause",
  "worktree.resource.status",
  "worktree.resource.connect",
] as const;

describe("worktree resource action definitions", () => {
  const registry = new Map<string, ActionFactory>();

  beforeAll(async () => {
    const { registerWorktreeActions } = await import("../worktreeActions");
    const callbacks = {
      getWorktrees: vi.fn(),
      onOpenSettings: vi.fn(),
      onCreateWorktree: vi.fn(),
      onDeleteWorktree: vi.fn(),
      onSwitchWorktree: vi.fn(),
    };
    registerWorktreeActions(registry as never, callbacks as never);
  });

  it("registers all 6 resource action IDs", () => {
    for (const id of RESOURCE_ACTION_IDS) {
      expect(registry.has(id), `missing action: ${id}`).toBe(true);
    }
  });

  it.each([
    ["worktree.resource.provision", "confirm"],
    ["worktree.resource.teardown", "confirm"],
    ["worktree.resource.resume", "safe"],
    ["worktree.resource.pause", "confirm"],
    ["worktree.resource.status", "safe"],
    ["worktree.resource.connect", "safe"],
  ] as const)("%s has danger=%s", (id, expectedDanger) => {
    const factory = registry.get(id)!;
    const def = factory();
    expect(def.danger).toBe(expectedDanger);
  });

  it("all resource actions have category=worktree and kind=command", () => {
    for (const id of RESOURCE_ACTION_IDS) {
      const def = registry.get(id)!();
      expect(def.category).toBe("worktree");
      expect(def.kind).toBe("command");
      expect(def.scope).toBe("renderer");
    }
  });

  it("connect action is enabled only when resourceConnectCommand exists", () => {
    const def = registry.get("worktree.resource.connect")!();
    // No worktree in the mocked store → isEnabled should return false
    expect(def.isEnabled!({ activeWorktreeId: "/test" })).toBe(false);
  });

  beforeEach(() => {
    mockResourceAction.mockReset();
    mockNotify.mockReset();
  });

  afterEach(() => {
    mockWorktrees.clear();
  });

  it.each([
    ["worktree.resource.provision", "hasProvisionCommand"],
    ["worktree.resource.teardown", "hasTeardownCommand"],
    ["worktree.resource.resume", "hasResumeCommand"],
    ["worktree.resource.pause", "hasPauseCommand"],
  ] as const)("%s is enabled when %s is true", (actionId, flag) => {
    mockWorktrees.set("/test", { [flag]: true });
    const def = registry.get(actionId)!();
    expect(def.isEnabled!({ activeWorktreeId: "/test" })).toBe(true);
  });

  it("provision/teardown/resume/pause are disabled when worktree lacks command-specific flags", () => {
    const gatedIds = RESOURCE_ACTION_IDS.filter(
      (id) => id !== "worktree.resource.connect" && id !== "worktree.resource.status"
    );
    for (const id of gatedIds) {
      const def = registry.get(id)!();
      // No worktree in the mocked store → isEnabled should return false
      expect(def.isEnabled!({ activeWorktreeId: "/test" }), `${id} should be disabled`).toBe(false);
    }
  });

  it("worktree.resource.status is always enabled (no isEnabled gate)", () => {
    const def = registry.get("worktree.resource.status")!();
    expect(def.isEnabled).toBeUndefined();
    expect(def.disabledReason).toBeUndefined();
  });

  it("worktree.resource.status returns { configured: false, status: null } when no status command", async () => {
    mockWorktrees.set("/test", { hasStatusCommand: false });
    const def = registry.get("worktree.resource.status")!();
    const result = await def.run!({}, { activeWorktreeId: "/test" });

    expect(result).toEqual({ configured: false, status: null });
    expect(mockResourceAction).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.resource.status returns { configured: true, status } on success", async () => {
    const resourceStatus = { lastStatus: "healthy" as const, lastCheckedAt: 0 };
    mockWorktrees.set("/test", { hasStatusCommand: true, resourceStatus });
    mockResourceAction.mockResolvedValueOnce(undefined);

    const def = registry.get("worktree.resource.status")!();
    const result = await def.run!({}, { activeWorktreeId: "/test" });

    expect(mockResourceAction).toHaveBeenCalledWith("/test", "status");
    expect(result).toEqual({ configured: true, status: resourceStatus });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each([
    ["worktree.resource.provision", "provision", "Provision failed"],
    ["worktree.resource.teardown", "teardown", "Teardown failed"],
    ["worktree.resource.resume", "resume", "Resume failed"],
    ["worktree.resource.pause", "pause", "Pause failed"],
    ["worktree.resource.status", "status", "Status check failed"],
  ] as const)("%s calls notify on failure", async (actionId, _action, expectedTitle) => {
    // status action gates on hasStatusCommand inside run() — seed it so we reach resourceAction
    mockWorktrees.set("/test", { hasStatusCommand: true });
    mockResourceAction.mockRejectedValueOnce(new Error("Command exited with code 1"));
    const def = registry.get(actionId)!();
    await def.run!({}, { activeWorktreeId: "/test" });

    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "high",
        title: expectedTitle,
        message: "Command exited with code 1",
        action: expect.objectContaining({
          label: "Copy details",
          onClick: expect.any(Function),
        }),
      })
    );
  });

  it.each([
    "worktree.resource.provision",
    "worktree.resource.teardown",
    "worktree.resource.resume",
    "worktree.resource.pause",
    "worktree.resource.status",
  ] as const)("%s does not notify on success", async (actionId) => {
    // status action gates on hasStatusCommand inside run() — seed it so we reach resourceAction
    mockWorktrees.set("/test", { hasStatusCommand: true });
    mockResourceAction.mockResolvedValueOnce(undefined);
    const def = registry.get(actionId)!();
    await def.run!({}, { activeWorktreeId: "/test" });

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each([
    ["worktree.resource.provision", "Provision failed", "Resource provisioning failed"],
    ["worktree.resource.teardown", "Teardown failed", "Resource teardown failed"],
    ["worktree.resource.resume", "Resume failed", "Resource resume failed"],
    ["worktree.resource.pause", "Pause failed", "Resource pause failed"],
    ["worktree.resource.status", "Status check failed", "Resource status check failed"],
  ] as const)(
    "%s uses fallback message for non-Error rejections",
    async (actionId, expectedTitle, fallbackMessage) => {
      // status action gates on hasStatusCommand inside run() — seed it so we reach resourceAction
      mockWorktrees.set("/test", { hasStatusCommand: true });
      mockResourceAction.mockRejectedValueOnce(null);
      const def = registry.get(actionId)!();
      await def.run!({}, { activeWorktreeId: "/test" });

      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expectedTitle,
          message: fallbackMessage,
        })
      );
    }
  );

  it("copy details action writes the error message to the clipboard", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    mockResourceAction.mockRejectedValueOnce(new Error("Command exited with code 1"));
    const def = registry.get("worktree.resource.provision")!();
    await def.run!({}, { activeWorktreeId: "/test" });

    const callArgs = mockNotify.mock.calls[0]![0];
    expect(callArgs.action.label).toBe("Copy details");
    await callArgs.action.onClick();

    expect(writeTextMock).toHaveBeenCalledWith("Command exited with code 1");
  });
});
