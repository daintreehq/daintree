import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionService } from "../../../ActionService";

// ActionService pulls in the shortcut-hint store and keybinding service at
// module load; the manifest-schema suite below only needs it to import cleanly.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));

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

  it("worktree.resource.status returns { configured: false, status: null } when no status command", async () => {
    mockWorktrees.set("/test", { hasStatusCommand: false });
    const def = registry.get("worktree.resource.status")!();
    const result = await def.run!({}, { activeWorktreeId: "/test" });

    expect(result).toEqual({ configured: false, status: null });
    expect(mockResourceAction).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.resource.status returns the status written by the check, not the one cached before it", async () => {
    // The command writes a fresh status into the store as it runs, so seeding a
    // different value first proves the action re-reads afterwards instead of
    // capturing the pre-command snapshot.
    const staleStatus = { lastStatus: "unknown", lastCheckedAt: 0 };
    const freshStatus = { lastStatus: "healthy", lastCheckedAt: 99 };
    mockWorktrees.set("/test", { hasStatusCommand: true, resourceStatus: staleStatus });
    mockResourceAction.mockImplementationOnce(() => {
      mockWorktrees.set("/test", { hasStatusCommand: true, resourceStatus: freshStatus });
      return Promise.resolve(undefined);
    });

    const def = registry.get("worktree.resource.status")!();
    const result = await def.run!({}, { activeWorktreeId: "/test" });

    expect(mockResourceAction).toHaveBeenCalledWith("/test", "status");
    expect(result).toEqual({ configured: true, status: freshStatus });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.resource.status resolves when the resource itself reports an error", async () => {
    // A status command that runs successfully but reports an unhealthy resource
    // is a successful check — distinct from the command failing to execute.
    const resourceStatus = { lastStatus: "unhealthy", error: "container exited", lastCheckedAt: 3 };
    mockWorktrees.set("/test", { hasStatusCommand: true, resourceStatus });
    mockResourceAction.mockResolvedValueOnce(undefined);

    const def = registry.get("worktree.resource.status")!();

    await expect(def.run!({}, { activeWorktreeId: "/test" })).resolves.toEqual({
      configured: true,
      status: resourceStatus,
    });
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

  // The palette suppresses its own toast for any action claiming
  // `selfNotifiesOnExecutionError`, so a false claim silently hides a real
  // failure. Rather than mirror the flag literal, force a failure and check the
  // claim against what run() actually did — this fails both if the flag is set
  // without notifying and if an action notifies without declaring it.
  it.each(RESOURCE_ACTION_IDS)(
    "%s: the self-notify claim matches whether run() actually notified on failure",
    async (actionId) => {
      // No worktree seeded, so every action throws its precondition error.
      const def = registry.get(actionId)!();
      await expect(def.run!({}, {})).rejects.toThrow();

      const actuallyNotified = mockNotify.mock.calls.length > 0;
      expect(actuallyNotified).toBe(def.selfNotifiesOnExecutionError === true);
    }
  );

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

  it("still rejects with the original error when the notification layer throws", async () => {
    // The palette trusts these actions to have notified, so a throw from notify
    // must not be allowed to replace the real failure — that would surface a
    // misleading error and, with the palette suppressing, possibly no toast.
    mockNotify.mockImplementationOnce(() => {
      throw new Error("notification store unavailable");
    });
    const clientError = new Error("Command exited with code 1");
    mockResourceAction.mockRejectedValueOnce(clientError);
    const def = registry.get("worktree.resource.provision")!();

    await expect(def.run!({}, { activeWorktreeId: "/test" })).rejects.toBe(clientError);
    // Falls back to a plain toast rather than giving up on notifying entirely.
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  it("still rejects with the original error when the error value itself is hostile", async () => {
    // formatErrorMessage evaluates `instanceof Error` outside its own guard, so
    // a proxy with a throwing trap makes the helper itself throw.
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      }
    );
    mockResourceAction.mockRejectedValueOnce(hostile);
    const def = registry.get("worktree.resource.pause")!();

    await expect(def.run!({}, { activeWorktreeId: "/test" })).rejects.toBe(hostile);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Pause failed", message: "Resource pause failed" })
    );
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

// #11533 — worktree.resource.status declares its result shape. A `resultSchema`
// alone never reaches the wire: publication is gated on `mcpOutputSchema`, and
// buildToolOutputSchema drops anything whose top-level type isn't "object".
// Registering through the real ActionService exercises the Zod -> JSON Schema
// conversion, so these assert the *generated* schema rather than the flags.
describe("worktree.resource.status emits a manifest outputSchema (#11533)", () => {
  let registerAll: () => ActionService;

  beforeAll(async () => {
    const { ActionService } = await import("../../../ActionService");
    const { registerWorktreeResourceActions } = await import("../worktreeResourceActions");
    registerAll = () => {
      const registry: ActionRegistry = new Map();
      registerWorktreeResourceActions(registry, {
        onAddTerminal: vi.fn(),
      } as unknown as ActionCallbacks);
      const service = new ActionService();
      for (const [, factory] of registry) {
        service.register(factory() as AnyActionDefinition);
      }
      return service;
    };
  });

  function outputSchema(service: ActionService, id: ActionId): Record<string, unknown> | undefined {
    return service.get(id)?.outputSchema;
  }

  it("generates an object-typed outputSchema keyed by configured/status", () => {
    const schema = outputSchema(registerAll(), "worktree.resource.status");
    expect(schema).toBeDefined();
    // buildToolOutputSchema discards any schema that isn't object-typed, which
    // is why a discriminated union (emitted as a bare oneOf) can't be used here.
    expect(schema!.type).toBe("object");

    expect(schema!.properties).toHaveProperty("configured");
    expect(schema!.properties).toHaveProperty("status");
    expect(schema!.required).toEqual(expect.arrayContaining(["configured", "status"]));
  });

  it("advertises every field of the resource status object, and admits null", () => {
    const schema = outputSchema(registerAll(), "worktree.resource.status")!;
    const serialized = JSON.stringify(schema.properties);

    // `status` is null whenever no status command is configured, so a strict
    // MCP client would reject the unconfigured branch without the null arm.
    expect(serialized).toContain("null");

    for (const field of [
      "lastStatus",
      "lastOutput",
      "error",
      "lastCheckedAt",
      "endpoint",
      "meta",
      "provider",
      "resumedAt",
      "pausedAt",
    ]) {
      expect(serialized).toContain(field);
    }
  });

  it("publishes no outputSchema for the actions that resolve with nothing", () => {
    const service = registerAll();
    for (const id of [
      "worktree.resource.provision",
      "worktree.resource.teardown",
      "worktree.resource.resume",
      "worktree.resource.pause",
      "worktree.resource.connect",
    ] as const) {
      expect(
        outputSchema(service, id),
        `${id} should not advertise an output schema`
      ).toBeUndefined();
    }
  });
});
