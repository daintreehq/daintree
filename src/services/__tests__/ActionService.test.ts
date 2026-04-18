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

    it("should warn when registering duplicate action", () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

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
      service.register(action);

      expect(consoleWarn).toHaveBeenCalledWith(
        '[WARN] Action "actions.list" already registered. Overwriting.',
        ""
      );

      consoleWarn.mockRestore();
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
      const action: ActionDefinition<void, string> = {
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
      const action: ActionDefinition<{ name: string }, void> = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: z.object({ name: z.string() }),
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
      const action: ActionDefinition<{ count: number }, void> = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description: "A test action",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: z.object({ count: z.number() }),
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
        const action: ActionDefinition<void, string> = {
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
