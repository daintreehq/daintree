import { beforeAll, afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const hintMocks = vi.hoisted(() => {
  const mockShow = vi.fn();
  const mockIncrementCount = vi.fn();
  const mockGetState = vi.fn(() => ({
    hydrated: true,
    counts: {} as Record<string, number>,
    show: mockShow,
    incrementCount: mockIncrementCount,
  }));
  const mockGetEffectiveCombo = vi.fn((_actionId: string): string | null => null);
  const mockGetDisplayCombo = vi.fn((_actionId: string): string => "");
  return { mockShow, mockIncrementCount, mockGetState, mockGetEffectiveCombo, mockGetDisplayCombo };
});

vi.mock("../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: hintMocks.mockGetState,
  },
}));

vi.mock("../KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: hintMocks.mockGetEffectiveCombo,
    getDisplayCombo: hintMocks.mockGetDisplayCombo,
  },
}));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { ActionService } from "../ActionService";
import type { ActionDefinition, ActionId } from "@shared/types/actions";

describe("ActionService", () => {
  let service: ActionService;

  beforeEach(() => {
    service = new ActionService();
    notifyMock.mockClear();
  });

  describe("register", () => {
    it("should register a new action", () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      const manifest = service.list();
      expect(manifest).toHaveLength(1);
      expect(manifest[0]!.id).toBe("actions.list");
    });

    it("has() reports whether an id is in the registry", () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };
      expect(service.has("actions.list" as ActionId)).toBe(false);
      service.register(action);
      expect(service.has("actions.list" as ActionId)).toBe(true);
    });

    it("unregister() removes an action and is a no-op for unknown ids", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action);
      service.unregister("actions.list" as ActionId);
      expect(service.has("actions.list" as ActionId)).toBe(false);

      // No-op on missing id — must not throw
      expect(() => service.unregister("never.registered" as ActionId)).not.toThrow();

      // After unregister, dispatch is NOT_FOUND
      const result = await service.dispatch("actions.list" as ActionId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("propagates pluginId and rawInputSchema onto ActionManifestEntry for plugin actions", () => {
      const action = {
        id: "acme.my-plugin.doThing" as ActionId,
        title: "Do Thing",
        description: "Does a thing",
        category: "plugin",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        pluginId: "acme.my-plugin",
        rawInputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action as unknown as ActionDefinition);

      const entry = service.get("acme.my-plugin.doThing" as ActionId);
      expect(entry).not.toBeNull();
      expect(entry!.pluginId).toBe("acme.my-plugin");
      expect(entry!.inputSchema).toEqual(action.rawInputSchema);
      // required:["name"] means args are required
      expect(entry!.requiresArgs).toBe(true);
    });

    it("treats rawInputSchema without a non-empty required array as args-optional", () => {
      const action = {
        id: "acme.plugin.maybe" as ActionId,
        title: "Maybe",
        description: "Optional args",
        category: "plugin",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        rawInputSchema: { type: "object", properties: { foo: { type: "string" } } },
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action as unknown as ActionDefinition);
      expect(service.get("acme.plugin.maybe" as ActionId)!.requiresArgs).toBe(false);
    });

    it("should throw when registering duplicate action and preserve the original registration", async () => {
      const originalRun = vi.fn().mockResolvedValue("original");
      const original: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Original Action",
        description: "Original",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: originalRun,
      };

      const duplicateRun = vi.fn().mockResolvedValue("duplicate");
      const duplicate: ActionDefinition = {
        ...original,
        title: "Duplicate Action",
        run: duplicateRun,
      };

      service.register(original);

      expect(() => service.register(duplicate)).toThrow(
        /^Action "actions\.list" is already registered\.$/
      );

      const result = await service.dispatch("actions.list" as ActionId);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.result).toBe("original");
      expect(originalRun).toHaveBeenCalledTimes(1);
      expect(duplicateRun).not.toHaveBeenCalled();
      expect(service.get("actions.list" as ActionId)?.title).toBe("Original Action");
    });
  });

  describe("dispatch", () => {
    it("should return NOT_FOUND error for unregistered action", async () => {
      const result = await service.dispatch("app.settings" as ActionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toContain("not found");
      }
    });

    it("should successfully execute a registered action", async () => {
      const mockRun = vi.fn().mockResolvedValue("success");
      const action: ActionDefinition<undefined, string> = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: mockRun,
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result).toBe("success");
      }
      expect(mockRun).toHaveBeenCalled();
    });

    it("should validate arguments with Zod schema", async () => {
      const nameSchema = z.object({ name: z.string() });
      const action: ActionDefinition<typeof nameSchema, void> = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: nameSchema,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      const invalidResult = await service.dispatch("actions.list", { name: 123 });
      expect(invalidResult.ok).toBe(false);
      if (!invalidResult.ok) {
        expect(invalidResult.error.code).toBe("VALIDATION_ERROR");
      }

      const validResult = await service.dispatch("actions.list", { name: "test" });
      expect(validResult.ok).toBe(true);
    });

    it("should check enablement before execution", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "Action is disabled for testing",
        run: mockRun,
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DISABLED");
        expect(result.error.message).toContain("disabled for testing");
      }
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("should show warning toast when disabled action has disabledReason", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "No focused terminal",
        run: vi.fn(),
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DISABLED");
      }
      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledWith({
        type: "warning",
        title: "'Test Action' disabled",
        message: "No focused terminal",
      });
    });

    it("should NOT show toast when disabled action has no disabledReason", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        run: vi.fn(),
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("should show toast for disabled action from non-agent sources", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "Disabled for test",
        run: vi.fn(),
      };

      service.register(action);

      for (const source of ["keybinding", "menu", "context-menu", "user"] as const) {
        notifyMock.mockClear();
        const result = await service.dispatch("actions.list", undefined, { source });
        expect(result.ok).toBe(false);
        expect(notifyMock).toHaveBeenCalledWith({
          type: "warning",
          title: "'Test Action' disabled",
          message: "Disabled for test",
        });
      }
    });

    it("should suppress disabled-action toast for agent source but still return DISABLED", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "Disabled for test",
        run: vi.fn(),
      };

      service.register(action);
      notifyMock.mockClear();

      const result = await service.dispatch("actions.list", undefined, { source: "agent" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DISABLED");
        expect(result.error.message).toBe("Disabled for test");
      }
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("should NOT show toast for enabled actions", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      await service.dispatch("actions.list");

      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("should reject restricted actions", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "restricted",
        scope: "renderer",
        run: mockRun,
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RESTRICTED");
      }
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("should handle execution errors", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockRejectedValue(new Error("Execution failed")),
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXECUTION_ERROR");
        expect(result.error.message).toContain("Execution failed");
      }
    });
  });

  describe("list", () => {
    it("should return empty array when no actions registered", () => {
      const manifest = service.list();
      expect(manifest).toEqual([]);
    });

    it("should include inputSchema from Zod schema", () => {
      const countSchema = z.object({ count: z.number() });
      const action: ActionDefinition<typeof countSchema, void> = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: countSchema,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest[0]!.inputSchema).toBeDefined();
    });

    it("should include enablement status", () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "Test disabled",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest[0]!.enabled).toBe(false);
      expect(manifest[0]!.disabledReason).toBe("Test disabled");
    });

    it("should omit restricted actions", () => {
      const safeAction: ActionDefinition = {
        id: "actions.safe" as ActionId,
        title: "Safe Action",
        description: "A safe action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      const restrictedAction: ActionDefinition = {
        id: "actions.restricted" as ActionId,
        title: "Restricted Action",
        description: "A restricted action",
        category: "test",
        kind: "command",
        danger: "restricted",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(safeAction);
      service.register(restrictedAction);

      const manifest = service.list();
      expect(manifest).toHaveLength(1);
      expect(manifest[0]!.id).toBe("actions.safe");
    });

    it("should propagate keywords to manifest entries", () => {
      const action: ActionDefinition = {
        id: "actions.keyworded" as ActionId,
        title: "Keyworded Action",
        description: "An action with keywords",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        keywords: ["save", "draft", "store"],
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest[0]!.keywords).toEqual(["save", "draft", "store"]);
    });

    it("should omit keywords when not defined", () => {
      const action: ActionDefinition = {
        id: "actions.noKeywords" as ActionId,
        title: "No Keywords Action",
        description: "An action without keywords",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest[0]!.keywords).toBeUndefined();
    });

    it("normalizes undefined title/description to empty strings on manifest entries", () => {
      // Regression: #6120 — IPC-sourced plugin actions could arrive with
      // undefined title or description even though the type system says
      // string. toManifestEntry must coerce so downstream consumers
      // (search filters, palette renderers) cannot crash on .toLowerCase().
      const malformed = {
        id: "actions.list" as ActionId,
        title: undefined,
        description: undefined,
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(malformed as unknown as ActionDefinition);
      const entry = service.get("actions.list" as ActionId);

      expect(entry).not.toBeNull();
      expect(entry!.title).toBe("");
      expect(entry!.description).toBe("");
    });
  });

  describe("get", () => {
    it("should return null for non-existent action", () => {
      const entry = service.get("app.settings" as ActionId);
      expect(entry).toBeNull();
    });

    it("should return manifest entry for existing action", () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const entry = service.get("actions.list");

      expect(entry).not.toBeNull();
      expect(entry?.id).toBe("actions.list");
      expect(entry?.title).toBe("Test Action");
    });
  });

  describe("action:dispatched event emission", () => {
    function installEmit(emit: (channel: string, payload: unknown) => Promise<void>) {
      const originalWindow = (globalThis as { window?: unknown }).window;
      const existing = (globalThis as unknown as { window?: Record<string, unknown> }).window;
      Object.defineProperty(globalThis, "window", {
        value: { ...existing, electron: { events: { emit } } },
        writable: true,
        configurable: true,
      });
      return () => {
        Object.defineProperty(globalThis, "window", {
          value: originalWindow,
          writable: true,
          configurable: true,
        });
      };
    }

    it("emits action:dispatched after run with category and durationMs", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        const action: ActionDefinition = {
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "preferences",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: vi.fn().mockResolvedValue(undefined),
        };
        service.register(action);
        await service.dispatch("actions.list" as ActionId);
        await Promise.resolve();

        expect(emit).toHaveBeenCalledTimes(1);
        const payload = emit.mock.calls[0]![1] as Record<string, unknown>;
        expect(payload.actionId).toBe("actions.list");
        expect(payload.category).toBe("preferences");
        expect(typeof payload.durationMs).toBe("number");
        expect(payload.durationMs as number).toBeGreaterThanOrEqual(0);
        expect(payload.safeArgs).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("does not emit action:dispatched when run throws", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: vi.fn().mockRejectedValue(new Error("boom")),
        });
        const result = await service.dispatch("actions.list" as ActionId);
        expect(result.ok).toBe(false);
        await Promise.resolve();
        expect(emit).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("does not emit action:dispatched on validation failure", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        const schema = z.object({ count: z.number() });
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          argsSchema: schema,
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("actions.list" as ActionId, { count: "bad" });
        await Promise.resolve();
        expect(emit).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("includes safeArgs when action opts in via safeBreadcrumbArgs", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "preferences",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          safeBreadcrumbArgs: ["show"],
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("actions.list" as ActionId, {
          show: true,
          secret: "should-not-leak",
        });
        await Promise.resolve();

        expect(emit).toHaveBeenCalledTimes(1);
        const payload = emit.mock.calls[0]![1] as Record<string, unknown>;
        expect(payload.safeArgs).toEqual({ show: true });
      } finally {
        restore();
      }
    });

    it("omits safeArgs when action has no safeBreadcrumbArgs allowlist", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("actions.list" as ActionId, { path: "/etc/passwd" });
        await Promise.resolve();
        const payload = emit.mock.calls[0]![1] as Record<string, unknown>;
        expect(payload.safeArgs).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("preserves falsy primitive values under allowlisted keys", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "preferences",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          safeBreadcrumbArgs: ["show"],
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("actions.list" as ActionId, { show: false });
        await Promise.resolve();
        const payload = emit.mock.calls[0]![1] as { safeArgs?: Record<string, unknown> };
        expect(payload.safeArgs).toEqual({ show: false });
      } finally {
        restore();
      }
    });

    it("does not emit when an agent invokes a confirm action without the confirmed flag", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        const run = vi.fn().mockResolvedValue(undefined);
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description: "T",
          category: "test",
          kind: "command",
          danger: "confirm",
          scope: "renderer",
          run,
        });
        const result = await service.dispatch("actions.list" as ActionId, undefined, {
          source: "agent",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
        await Promise.resolve();
        expect(run).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  describe("lastAction tracking", () => {
    const makeAction = (
      id: string,
      overrides: Partial<ActionDefinition> = {}
    ): ActionDefinition => ({
      id: id as ActionId,
      title: "Test",
      description: "Test action",
      category: "test",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    it("returns null before any action has been dispatched", () => {
      expect(service.getLastAction()).toBeNull();
    });

    it("captures last action after a successful user dispatch", async () => {
      service.register(makeAction("test.repeatable"));
      await service.dispatch("test.repeatable" as ActionId, { foo: 1 }, { source: "user" });

      expect(service.getLastAction()).toEqual({
        actionId: "test.repeatable",
        args: { foo: 1 },
      });
    });

    it("captures after keybinding, menu, and context-menu dispatches", async () => {
      service.register(makeAction("test.keybinding"));
      service.register(makeAction("test.menu"));
      service.register(makeAction("test.context"));

      await service.dispatch("test.keybinding" as ActionId, undefined, { source: "keybinding" });
      expect(service.getLastAction()?.actionId).toBe("test.keybinding");

      await service.dispatch("test.menu" as ActionId, undefined, { source: "menu" });
      expect(service.getLastAction()?.actionId).toBe("test.menu");

      await service.dispatch("test.context" as ActionId, undefined, { source: "context-menu" });
      expect(service.getLastAction()?.actionId).toBe("test.context");
    });

    it("does not capture agent-source dispatches", async () => {
      service.register(makeAction("test.user"));
      service.register(makeAction("test.agent"));

      await service.dispatch("test.user" as ActionId, undefined, { source: "user" });
      expect(service.getLastAction()?.actionId).toBe("test.user");

      await service.dispatch("test.agent" as ActionId, undefined, { source: "agent" });
      expect(service.getLastAction()?.actionId).toBe("test.user");
    });

    it("does not capture when dispatch fails via execution error", async () => {
      service.register(makeAction("test.good"));
      service.register(
        makeAction("test.bad", { run: vi.fn().mockRejectedValue(new Error("boom")) })
      );

      await service.dispatch("test.good" as ActionId, undefined, { source: "user" });
      expect(service.getLastAction()?.actionId).toBe("test.good");

      const result = await service.dispatch("test.bad" as ActionId, undefined, { source: "user" });
      expect(result.ok).toBe(false);
      expect(service.getLastAction()?.actionId).toBe("test.good");
    });

    it("does not capture when dispatch fails validation", async () => {
      const schema = z.object({ count: z.number() });
      const action: ActionDefinition<typeof schema, void> = {
        id: "test.validated" as ActionId,
        title: "Test",
        description: "Test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: schema,
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action);

      await service.dispatch("test.validated" as ActionId, { count: "bad" }, { source: "user" });
      expect(service.getLastAction()).toBeNull();
    });

    it("does not capture actions marked nonRepeatable", async () => {
      service.register(makeAction("test.repeatable"));
      service.register(makeAction("test.palette", { nonRepeatable: true }));

      await service.dispatch("test.repeatable" as ActionId, undefined, { source: "user" });
      expect(service.getLastAction()?.actionId).toBe("test.repeatable");

      await service.dispatch("test.palette" as ActionId, undefined, { source: "user" });
      expect(service.getLastAction()?.actionId).toBe("test.repeatable");
    });

    it("does not capture danger:confirm actions even from user-facing sources", async () => {
      // Destructive actions (worktree.delete, git.push, project.remove, etc.) rely on
      // originating UI dialogs for consent. Capturing them would let Cmd+Shift+. silently
      // replay the destructive op without re-confirmation — explicitly disallowed.
      service.register(makeAction("test.safe"));
      service.register(makeAction("test.destructive", { danger: "confirm" }));

      await service.dispatch("test.safe" as ActionId, undefined, { source: "user" });
      expect(service.getLastAction()?.actionId).toBe("test.safe");

      await service.dispatch(
        "test.destructive" as ActionId,
        { worktreeId: "wt-1" },
        { source: "user" }
      );
      expect(service.getLastAction()?.actionId).toBe("test.safe");

      await service.dispatch("test.destructive" as ActionId, undefined, { source: "keybinding" });
      expect(service.getLastAction()?.actionId).toBe("test.safe");

      await service.dispatch("test.destructive" as ActionId, undefined, { source: "menu" });
      expect(service.getLastAction()?.actionId).toBe("test.safe");

      await service.dispatch("test.destructive" as ActionId, undefined, { source: "context-menu" });
      expect(service.getLastAction()?.actionId).toBe("test.safe");
    });

    it("replaces the stored action on each new eligible dispatch", async () => {
      service.register(makeAction("test.first"));
      service.register(makeAction("test.second"));

      await service.dispatch("test.first" as ActionId, { a: 1 }, { source: "user" });
      await service.dispatch("test.second" as ActionId, { b: 2 }, { source: "user" });

      expect(service.getLastAction()).toEqual({
        actionId: "test.second",
        args: { b: 2 },
      });
    });

    it("outer dispatch captures after inner dispatch completes (nested ordering)", async () => {
      // Regression: when a user-dispatched action internally calls another
      // dispatch with source: "user", the outer action must win the lastAction
      // slot — otherwise Cmd+Shift+. replays the inner alias instead of the
      // user's original intent.
      service.register(makeAction("test.inner"));
      service.register(
        makeAction("test.outer", {
          run: async () => {
            await service.dispatch("test.inner" as ActionId, undefined, { source: "user" });
          },
        })
      );

      await service.dispatch("test.outer" as ActionId, { marker: "outer" }, { source: "user" });

      expect(service.getLastAction()).toEqual({
        actionId: "test.outer",
        args: { marker: "outer" },
      });
    });

    it("captured args are isolated from later caller mutation", async () => {
      service.register(makeAction("test.mutable"));
      const args = { list: [1, 2, 3] };

      await service.dispatch("test.mutable" as ActionId, args, { source: "user" });
      args.list.push(999);

      expect(service.getLastAction()).toEqual({
        actionId: "test.mutable",
        args: { list: [1, 2, 3] },
      });
    });

    it("stores validated args, not the raw input", async () => {
      const schema = z.object({ name: z.string().default("default-name") });
      const action: ActionDefinition<typeof schema, void> = {
        id: "test.defaulted" as ActionId,
        title: "Test",
        description: "Test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: schema,
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action);

      await service.dispatch("test.defaulted" as ActionId, {}, { source: "user" });
      expect(service.getLastAction()).toEqual({
        actionId: "test.defaulted",
        args: { name: "default-name" },
      });
    });
  });

  describe("dispatch resilience", () => {
    it("should complete dispatch even when events.emit never resolves", async () => {
      const originalWindow = (globalThis as Record<string, unknown>).window;
      const emitSpy = vi.fn(() => new Promise<void>(() => {})); // never resolves
      Object.defineProperty(globalThis, "window", {
        value: {
          ...globalThis.window,
          electron: { events: { emit: emitSpy } },
        },
        writable: true,
        configurable: true,
      });

      try {
        const mockRun = vi.fn().mockResolvedValue("done");
        const action: ActionDefinition<undefined, string> = {
          id: "actions.list" as ActionId,
          title: "Test",
          description: "Test action",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: mockRun,
        };

        service.register(action);
        const result = await service.dispatch("actions.list");

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.result).toBe("done");
        }
        expect(mockRun).toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalled();
      } finally {
        Object.defineProperty(globalThis, "window", {
          value: originalWindow,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe("shortcut hints", () => {
    const {
      mockShow,
      mockIncrementCount,
      mockGetState,
      mockGetEffectiveCombo,
      mockGetDisplayCombo,
    } = hintMocks;

    const makeAction = (id: string): ActionDefinition => ({
      id: id as ActionId,
      title: "Test",
      description: "Test action",
      category: "test",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: vi.fn().mockResolvedValue(undefined),
    });

    beforeEach(() => {
      mockShow.mockClear();
      mockIncrementCount.mockClear();
      mockGetEffectiveCombo.mockReset().mockReturnValue(null);
      mockGetDisplayCombo.mockReset().mockReturnValue("");
      mockGetState.mockReturnValue({
        hydrated: true,
        counts: {},
        show: mockShow,
        incrementCount: mockIncrementCount,
      });
    });

    it("emits hint and increments count for user source with keybinding", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");
      mockGetDisplayCombo.mockReturnValue("⌘K");
      mockShow.mockReturnValue(true);

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "user" });

      expect(mockShow).toHaveBeenCalledWith("test.action", "⌘K");
      expect(mockIncrementCount).toHaveBeenCalledWith("test.action");
    });

    it("increments count unconditionally even when show returns false", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");
      mockGetDisplayCombo.mockReturnValue("⌘K");
      mockShow.mockReturnValue(false);

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "user" });

      expect(mockShow).toHaveBeenCalled();
      expect(mockIncrementCount).toHaveBeenCalledWith("test.action");
    });

    it("does not emit hint for keybinding source", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "keybinding" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    it("does not emit hint for menu source", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "menu" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    it("does not emit hint for context-menu source", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "context-menu" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    it("does not emit hint for agent source", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "agent" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    it("does not emit hint when action has no keybinding", async () => {
      mockGetEffectiveCombo.mockReturnValue(null);

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "user" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    it("does not emit hint when store is not hydrated", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");
      mockGetState.mockReturnValue({
        hydrated: false,
        counts: {},
        show: mockShow,
        incrementCount: mockIncrementCount,
      });

      service.register(makeAction("test.action"));
      await service.dispatch("test.action" as ActionId, undefined, { source: "user" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    it("does not emit hint when action execution fails", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");

      const failAction: ActionDefinition = {
        ...makeAction("test.fail"),
        run: vi.fn().mockRejectedValue(new Error("fail")),
      };
      service.register(failAction);
      await service.dispatch("test.fail" as ActionId, undefined, { source: "user" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });
  });

  describe("action definition validation", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterAll(() => {
      warnSpy.mockRestore();
    });

    beforeEach(() => {
      warnSpy.mockClear();
    });

    it("warns when action defines isEnabled but no disabledReason", () => {
      const action: ActionDefinition = {
        id: "test.noDisabledReason" as ActionId,
        title: "Test",
        description: "Test",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Action "test.noDisabledReason" defines isEnabled but no disabledReason callback'
        )
      );
    });

    it("does not warn when action has both isEnabled and disabledReason", () => {
      const action: ActionDefinition = {
        id: "test.bothCallbacks" as ActionId,
        title: "Test",
        description: "Test",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "Action is disabled for testing",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when action has neither isEnabled nor disabledReason", () => {
      const action: ActionDefinition = {
        id: "test.neither" as ActionId,
        title: "Test",
        description: "Test",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when action has disabledReason without isEnabled (valid pattern)", () => {
      const action: ActionDefinition = {
        id: "test.onlyDisabledReason" as ActionId,
        title: "Test",
        description: "Test",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        disabledReason: () => "Some reason",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns for multiple offending actions", () => {
      const action1: ActionDefinition = {
        id: "test.offender1" as ActionId,
        title: "Test 1",
        description: "Test 1",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        run: vi.fn().mockResolvedValue(undefined),
      };

      const action2: ActionDefinition = {
        id: "test.offender2" as ActionId,
        title: "Test 2",
        description: "Test 2",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => "Reason", // This one is OK
        run: vi.fn().mockResolvedValue(undefined),
      };

      const action3: ActionDefinition = {
        id: "test.offender3" as ActionId,
        title: "Test 3",
        description: "Test 3",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action1);
      service.register(action2);
      service.register(action3);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Action "test.offender1"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Action "test.offender3"'));
    });

    it("does not warn on duplicate registration (validate runs after duplicate-ID check)", () => {
      const action: ActionDefinition = {
        id: "test.duplicate" as ActionId,
        title: "Test",
        description: "Test",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        run: vi.fn().mockResolvedValue(undefined),
      };

      // First registration: warning fires
      service.register(action);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Second registration: duplicate-ID guard throws before validate runs
      warnSpy.mockClear();
      expect(() => service.register(action)).toThrow(/already registered/);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
