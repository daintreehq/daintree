import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
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
      expect(manifest[0].id).toBe("actions.list");
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

      expect(manifest[0].inputSchema).toBeDefined();
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

      expect(manifest[0].enabled).toBe(false);
      expect(manifest[0].disabledReason).toBe("Test disabled");
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
      expect(manifest[0].id).toBe("actions.safe");
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
});
