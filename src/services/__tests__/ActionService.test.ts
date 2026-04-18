import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { ActionService } from "../ActionService";
import type { ActionDefinition, ActionId } from "@shared/types/actions";

describe("ActionService", () => {
  let service: ActionService;

  beforeEach(() => {
    service = new ActionService();
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
});
