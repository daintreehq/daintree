import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

const mockResourceAction = vi.fn();
const mockOnAddTerminal = vi.fn();

// Stub all external imports that worktreeActions.ts pulls in
vi.mock("@/clients", () => ({
  copyTreeClient: {},
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
      onAddTerminal: mockOnAddTerminal,
    };
    registerWorktreeActions(registry as never, callbacks as never);
  });

  it("registers all 6 resource action IDs", () => {
    for (const id of RESOURCE_ACTION_IDS) {
      expect(registry.has(id), `missing action: ${id}`).toBe(true);
    }
  });

  it.each([
    ["worktree.resource.provision", "safe"],
    ["worktree.resource.teardown", "confirm"],
    ["worktree.resource.resume", "safe"],
    ["worktree.resource.pause", "safe"],
    ["worktree.resource.status", "safe"],
    ["worktree.resource.connect", "safe"],
  ] as const)("%s has danger=%s", (id, expectedDanger) => {
    const factory = registry.get(id)!;
    const def = factory();
    expect(def.danger).toBe(expectedDanger);
  });

  it.each([
    "worktree.resource.provision",
    "worktree.resource.teardown",
    "worktree.resource.resume",
    "worktree.resource.pause",
  ] as const)("%s is a discoverable MCP tool (kept off the eager tools/list)", (id) => {
    const def = registry.get(id)!();
    expect(def.mcpVisibility).toBe("discoverable");
  });

  it("status keeps its eager (unclassified) MCP visibility", () => {
    const def = registry.get("worktree.resource.status")!();
    expect(def.mcpVisibility).toBeUndefined();
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
    mockOnAddTerminal.mockReset();
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

  it("worktree.resource.connect passes spawnedBy through to terminal creation", async () => {
    mockWorktrees.set("wt-1", {
      path: "/repo/worktree",
      name: "Remote Resource",
      resourceConnectCommand: "ssh devbox",
    });
    const def = registry.get("worktree.resource.connect")!();

    await def.run!({ worktreeId: "wt-1", spawnedBy: "mcp" }, {});

    expect(mockOnAddTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        command: "ssh devbox",
        worktreeId: "wt-1",
        spawnedBy: "mcp",
      })
    );
  });

  it.each([
    ["worktree.resource.provision", "provision", "Provision failed"],
    ["worktree.resource.teardown", "teardown", "Teardown failed"],
    ["worktree.resource.resume", "resume", "Resume failed"],
    ["worktree.resource.pause", "pause", "Pause failed"],
    ["worktree.resource.status", "status", "Status check failed"],
  ] as const)("%s notifies and rejects on failure", async (actionId, verb, expectedTitle) => {
    // status action gates on hasStatusCommand inside run() — seed it so we reach
    // resourceAction. The cached resourceStatus is deliberately stale: before
    // #11533 the status action swallowed the rejection and resolved with this
    // value, indistinguishable from a fresh successful read.
    mockWorktrees.set("/test", {
      hasStatusCommand: true,
      resourceStatus: { lastStatus: "stale", lastCheckedAt: 1 },
    });
    const clientError = new Error("Command exited with code 1");
    mockResourceAction.mockRejectedValueOnce(clientError);
    const def = registry.get(actionId)!();

    // Rejects with the original error instance — the action rethrows rather
    // than wrapping, so identity and stack survive for the dispatch layer.
    await expect(def.run!({}, { activeWorktreeId: "/test" })).rejects.toBe(clientError);

    expect(mockResourceAction).toHaveBeenCalledWith("/test", verb);
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

  it("worktree.resource.status rejects rather than returning a stale cached status", async () => {
    mockWorktrees.set("/test", {
      hasStatusCommand: true,
      resourceStatus: { lastStatus: "healthy", lastCheckedAt: 1 },
    });
    mockResourceAction.mockRejectedValueOnce(new Error("status command exited with code 1"));
    const def = registry.get("worktree.resource.status")!();

    const outcome = await def
      .run!({}, { activeWorktreeId: "/test" })
      .then((value) => ({ resolved: true as const, value }))
      .catch(() => ({ resolved: false as const }));

    // The pre-fix bug resolved with { configured: true, status: <the seeded
    // stale object> }; a caller had no way to tell that from a fresh check.
    expect(outcome.resolved).toBe(false);
  });

  it.each([
    "worktree.resource.provision",
    "worktree.resource.teardown",
    "worktree.resource.resume",
    "worktree.resource.pause",
    "worktree.resource.status",
  ] as const)(
    "%s notifies and rejects when no worktree is selected (precondition covered by the catch)",
    async (actionId) => {
      const def = registry.get(actionId)!();

      // The selfNotifiesOnExecutionError contract requires the catch to cover
      // every throw out of run(), preconditions included — otherwise the
      // palette suppresses a toast that was never shown.
      await expect(def.run!({}, {})).rejects.toThrow("No worktree selected");

      expect(mockResourceAction).not.toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledOnce();
    }
  );

  it("worktree.resource.status notifies and rejects when the worktree is not found", async () => {
    const def = registry.get("worktree.resource.status")!();

    await expect(def.run!({}, { activeWorktreeId: "/missing" })).rejects.toThrow(
      "Worktree not found"
    );

    expect(mockResourceAction).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Status check failed" })
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

      // A non-Error rejection is rethrown as-is, so the value reaches
      // dispatch() unchanged; only the toast copy falls back.
      await expect(def.run!({}, { activeWorktreeId: "/test" })).rejects.toBeNull();

      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expectedTitle,
          message: fallbackMessage,
        })
      );
    }
  );

  it.each([
    "worktree.resource.provision",
    "worktree.resource.teardown",
    "worktree.resource.resume",
    "worktree.resource.pause",
    "worktree.resource.status",
  ] as const)("%s declares that it self-notifies on execution error", (actionId) => {
    expect(registry.get(actionId)!().selfNotifiesOnExecutionError).toBe(true);
  });

  it("connect does not claim to self-notify (it has no catch of its own)", () => {
    expect(registry.get("worktree.resource.connect")!().selfNotifiesOnExecutionError).toBeUndefined();
  });

  it.each([
    "worktree.resource.provision",
    "worktree.resource.teardown",
    "worktree.resource.resume",
    "worktree.resource.pause",
  ] as const)("%s declares no result schema (it resolves with nothing)", (actionId) => {
    const def = registry.get(actionId)!();
    expect(def.resultSchema).toBeUndefined();
    // z.void() would convert to a schema with no top-level `type: "object"`,
    // which buildToolOutputSchema discards — so publishing one is pointless.
    expect(def.mcpOutputSchema).toBeUndefined();
  });

  it("worktree.resource.status publishes its result schema to MCP", () => {
    const def = registry.get("worktree.resource.status")!();
    // resultSchema alone never reaches the wire — publication is gated on the
    // mcpOutputSchema flag, so both are required together.
    expect(def.resultSchema).toBeDefined();
    expect(def.mcpOutputSchema).toBe(true);
  });

  it("worktree.resource.status result schema accepts both branches run() returns", async () => {
    const def = registry.get("worktree.resource.status")!();
    const schema = def.resultSchema!;

    mockWorktrees.set("/unconfigured", { hasStatusCommand: false });
    const unconfigured = await def.run!({}, { activeWorktreeId: "/unconfigured" });
    expect(schema.safeParse(unconfigured).success).toBe(true);

    const resourceStatus = {
      lastStatus: "ready",
      lastOutput: "ok",
      error: "none",
      lastCheckedAt: 5,
      endpoint: "https://devbox.example",
      meta: { region: "us-east-1" },
      provider: "acme",
      resumedAt: 6,
      pausedAt: 7,
    };
    mockWorktrees.set("/configured", { hasStatusCommand: true, resourceStatus });
    mockResourceAction.mockResolvedValueOnce(undefined);
    const configured = await def.run!({}, { activeWorktreeId: "/configured" });
    expect(schema.safeParse(configured).success).toBe(true);
  });

  it("copy details action writes the error message to the clipboard", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    mockResourceAction.mockRejectedValueOnce(new Error("Command exited with code 1"));
    const def = registry.get("worktree.resource.provision")!();
    await expect(def.run!({}, { activeWorktreeId: "/test" })).rejects.toThrow(
      "Command exited with code 1"
    );

    const callArgs = mockNotify.mock.calls[0]![0];
    expect(callArgs.action.label).toBe("Copy details");
    await callArgs.action.onClick();

    expect(writeTextMock).toHaveBeenCalledWith("Command exited with code 1");
  });
});
