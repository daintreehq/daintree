import { beforeAll, afterAll, describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { useUIStore } from "@/store/uiStore";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import { ConfirmationStagedError } from "../actions/confirmationStaged";

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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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

    it("getTitle() resolves a registered action's title and falls back to empty string", () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Do Thing",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      // Unknown id resolves to "" without throwing.
      expect(service.getTitle("never.registered" as ActionId)).toBe("");

      service.register(action);
      expect(service.getTitle("actions.list" as ActionId)).toBe("Do Thing");

      // After unregister the title is no longer resolvable.
      service.unregister("actions.list" as ActionId);
      expect(service.getTitle("actions.list" as ActionId)).toBe("");
    });

    it("selfNotifiesOnExecutionError() reflects the flag and fails closed for unknown ids", () => {
      const base = {
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      } as const;

      // An unknown id fails closed — the caller keeps its own fallback toast
      // rather than silencing one that was never shown.
      expect(service.selfNotifiesOnExecutionError("never.registered" as ActionId)).toBe(false);

      service.register({
        ...base,
        id: "actions.list" as ActionId,
        title: "Self notifying",
        selfNotifiesOnExecutionError: true,
      } as ActionDefinition);
      expect(service.selfNotifiesOnExecutionError("actions.list" as ActionId)).toBe(true);

      service.register({
        ...base,
        id: "actions.get" as ActionId,
        title: "Quiet",
      } as ActionDefinition);
      expect(service.selfNotifiesOnExecutionError("actions.get" as ActionId)).toBe(false);
    });

    it("unregister() removes an action and is a no-op for unknown ids", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "Does a thing from a plugin with raw input and output schemas for testing plugin action registration.",
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
        description:
          "Optional args — an action whose argsSchema accepts undefined, for testing optional arg detection.",
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

    it("propagates rawOutputSchema onto ActionManifestEntry when no Zod resultSchema is set", () => {
      const rawOutput = {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      };
      const action = {
        id: "acme.plugin.report" as ActionId,
        title: "Report",
        description:
          "Returns a payload with a raw output schema for testing result schema handling in ActionService.",
        category: "plugin",
        kind: "query",
        danger: "safe",
        scope: "renderer",
        rawOutputSchema: rawOutput,
        mcpOutputSchema: true,
        run: vi.fn().mockResolvedValue({ ok: true }),
      };
      service.register(action as unknown as ActionDefinition);
      expect(service.get("acme.plugin.report" as ActionId)!.outputSchema).toEqual(rawOutput);
    });

    it("prefers Zod resultSchema over rawOutputSchema when both are provided", async () => {
      const { z } = await import("zod");
      const rawOutput = { type: "object", properties: { fallback: { type: "string" } } };
      const action = {
        id: "acme.plugin.both" as ActionId,
        title: "Both Schemas",
        description:
          "Has both result and raw output schema for testing priority between zod and raw schema in ActionService.",
        category: "plugin",
        kind: "query",
        danger: "safe",
        scope: "renderer",
        resultSchema: z.object({ canonical: z.string() }),
        rawOutputSchema: rawOutput,
        mcpOutputSchema: true,
        run: vi.fn().mockResolvedValue({ canonical: "x" }),
      };
      service.register(action as unknown as ActionDefinition);
      const entry = service.get("acme.plugin.both" as ActionId)!;
      expect(entry.outputSchema).toBeDefined();
      // resultSchema (Zod) wins — produced schema must mention the canonical
      // property, not the raw schema's `fallback`.
      const props = (entry.outputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.canonical).toBeDefined();
      expect(props.fallback).toBeUndefined();
    });

    it("should throw when registering duplicate action and preserve the original registration", async () => {
      const originalRun = vi.fn().mockResolvedValue("original");
      const original: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Original Action",
        description:
          "Original action definition used for testing duplicate registration handling in ActionService.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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

    it("executes a safe action dispatched from a plugin source", async () => {
      const mockRun = vi.fn().mockResolvedValue("ok");
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: mockRun,
      });

      const result = await service.dispatch("actions.list", undefined, { source: "plugin" });
      expect(result.ok).toBe(true);
      expect(mockRun).toHaveBeenCalled();
    });

    it("returns CONFIRMATION_REQUIRED for a confirm action from a plugin source (no confirmed bypass)", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "confirm",
        scope: "renderer",
        run: mockRun,
      });

      const result = await service.dispatch("actions.list", undefined, { source: "plugin" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(mockRun).not.toHaveBeenCalled();

      // Defense-in-depth: the host API never sets `confirmed`, but even a caller
      // spoofing confirmed:true on a "plugin" dispatch must NOT bypass the gate.
      const spoofed = await service.dispatch("actions.list", undefined, {
        source: "plugin",
        confirmed: true,
      });
      expect(spoofed.ok).toBe(false);
      if (!spoofed.ok) expect(spoofed.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("gates a statically-safe action when an agent dispatch carries a recipeId (#11860)", async () => {
      // The composite worktree actions are legitimately `safe` on their own but
      // spawn a recipe's terminals when the args name one, which is the gap
      // `recipe.run`'s confirm tier used to have a documented way around.
      const mockRun = vi.fn().mockResolvedValue(undefined);
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: z.object({ recipeId: z.string().optional() }).optional(),
        run: mockRun,
      });

      const blocked = await service.dispatch(
        "actions.list",
        { recipeId: "recipe-1" },
        { source: "agent" }
      );
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error.code).toBe("CONFIRMATION_REQUIRED");
      // Rejected BEFORE run(), so no worktree was created and no issue fetched.
      expect(mockRun).not.toHaveBeenCalled();

      const approved = await service.dispatch(
        "actions.list",
        { recipeId: "recipe-1" },
        { source: "agent", confirmed: true }
      );
      expect(approved.ok).toBe(true);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("leaves the same action ungated for an agent dispatch that names no recipe (#11860)", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: z.object({ recipeId: z.string().optional() }).optional(),
        run: mockRun,
      });

      const result = await service.dispatch("actions.list", {}, { source: "agent" });
      expect(result.ok).toBe(true);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it("reports the effective danger only when getDispatchMeta is given the dispatch (#11860)", async () => {
      // The MCP bridge and dispatch() must agree: if the bridge read the static
      // danger it would skip the modal, dispatch unconfirmed, and hand the agent
      // a CONFIRMATION_REQUIRED it has no way to satisfy.
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: z.object({ recipeId: z.string().optional() }).optional(),
        run: vi.fn().mockResolvedValue(undefined),
      });

      expect(service.getDispatchMeta("actions.list" as ActionId)?.danger).toBe("safe");
      const elevated = service.getDispatchMeta("actions.list" as ActionId, {
        source: "agent",
        args: { recipeId: "recipe-1" },
      });
      expect(elevated?.danger).toBe("confirm");
      // A statically-safe action has no rationale of its own, so the elevation
      // supplies one rather than showing the dialog an unexplained gate.
      expect(elevated?.dangerRationale).toBeTruthy();
      expect(
        service.getDispatchMeta("actions.list" as ActionId, {
          source: "user",
          args: { recipeId: "r" },
        })?.danger
      ).toBe("safe");
    });

    it("returns RESTRICTED for a restricted action from a plugin source", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "restricted",
        scope: "renderer",
        run: mockRun,
      });

      const result = await service.dispatch("actions.list", undefined, { source: "plugin" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("RESTRICTED");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("returns RESTRICTED for a denyPluginDispatch action from a plugin source (#10558)", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        denyPluginDispatch: true,
        scope: "renderer",
        run: mockRun,
      });

      const result = await service.dispatch("actions.list", undefined, { source: "plugin" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("RESTRICTED");
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("allows a denyPluginDispatch action from agent and user sources (#10558)", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      service.register({
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        denyPluginDispatch: true,
        scope: "renderer",
        run: mockRun,
      });

      const agentResult = await service.dispatch("actions.list", undefined, { source: "agent" });
      expect(agentResult.ok).toBe(true);
      const userResult = await service.dispatch("actions.list", undefined, { source: "user" });
      expect(userResult.ok).toBe(true);
      expect(mockRun).toHaveBeenCalledTimes(2);
    });

    it("should validate arguments with Zod schema", async () => {
      const nameSchema = z.object({ name: z.string() });
      const action: ActionDefinition<typeof nameSchema, void> = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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

    it("should NOT show warning toast when disabled action has disabledReason (#8814)", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        expect(result.error.message).toBe("No focused terminal");
      }
      expect(notifyMock).not.toHaveBeenCalled();
    });

    it("should NOT show toast when disabled action has no disabledReason", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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

    it("should NOT show toast for disabled action from any source (#8814)", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        if (!result.ok) {
          expect(result.error.code).toBe("DISABLED");
          expect(result.error.message).toBe("Disabled for test");
        }
        expect(notifyMock).not.toHaveBeenCalled();
      }
    });

    it("should suppress disabled-action toast for agent source but still return DISABLED", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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

    // A main-process AppError reaches the renderer with its own `code`/`name`
    // stripped by contextBridge, carrying the discriminant only in the message
    // prefix. Panes render `error.message` directly, so decoding has to happen
    // here or the prefix ships to the user (#11934).
    it("strips the AppError transport prefix from the surfaced message", async () => {
      const transported = new Error("[AppError|OUTSIDE_ROOT] Path is outside all allowed roots");
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockRejectedValue(transported),
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Path is outside all allowed roots");
        // Decoding the message must not reclassify the failure: PARTIAL_SUCCESS
        // stays the only carve-out from EXECUTION_ERROR.
        expect(result.error.code).toBe("EXECUTION_ERROR");
        // Consumers that decode `details` themselves still get the same throw.
        expect(result.error.details).toBe(transported);
      }
    });

    it("carries the decoded userMessage through to details", async () => {
      const transported = new Error(
        `[AppError|OUTSIDE_ROOT|${encodeURIComponent("Path is not in a project root")}] Path is outside all allowed roots`
      );
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockRejectedValue(transported),
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The three-segment form is what the preload actually emits when the
        // AppError carried a userMessage; only the transport wrapper is removed.
        expect(result.error.message).toBe("Path is outside all allowed roots");
        // `toMatchObject` rather than a cast: `details` is `unknown`, and the
        // repo's lint ratchet counts every type assertion.
        expect(result.error.details).toMatchObject({
          userMessage: "Path is not in a project root",
        });
      }
    });

    it.each([
      [
        "a prefix that is not at the start of the message",
        new Error("wrapped: [AppError|OUTSIDE_ROOT] Path is outside all allowed roots"),
        "wrapped: [AppError|OUTSIDE_ROOT] Path is outside all allowed roots",
      ],
      ["a rejection that is not an Error at all", "plain string failure", "plain string failure"],
    ])("leaves %s alone", async (_label, rejection, expected) => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test Action",
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockRejectedValue(rejection),
      };

      service.register(action);
      const result = await service.dispatch("actions.list");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(expected);
        expect(result.error.code).toBe("EXECUTION_ERROR");
      }
    });

    // #12120: the confirm gate above already required a host attestation for
    // agent dispatch, but run() could not see it — it only had the client-settable
    // `confirmed` on the action's own args, so a confirm-gated action re-asked
    // after the host modal was approved and returned `ok` having done nothing.
    describe("host-attested confirmation reaches run() (#12120)", () => {
      // Typed as the definition's own `run`, not `ReturnType<typeof vi.fn>` —
      // that resolves to `Mock<Procedure | Constructable>`, whose Constructable
      // arm carries no call signature and so satisfies no function type.
      function confirmAction(run: ActionDefinition["run"]): ActionDefinition {
        return {
          id: "actions.list" as ActionId,
          title: "Test Action",
          description: "A test action",
          category: "test",
          kind: "command",
          danger: "confirm",
          scope: "renderer",
          run,
        };
      }

      it("stamps ctx.hostConfirmed from the dispatch options", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        await service.dispatch("actions.list", undefined, { source: "agent", confirmed: true });

        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ hostConfirmed: true })
        );
      });

      it("leaves ctx.hostConfirmed unset when the host attested nothing", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        await service.dispatch("actions.list", undefined, { source: "user" });

        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ hostConfirmed: undefined })
        );
      });

      // The whole point of putting it on the context rather than in args: a
      // caller cannot plant it. Same property that makes `dispatchSource`
      // trustworthy — the stamp is unconditional and overwrites the override.
      it("overwrites a contextOverride that claims an approval the host never made", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        const result = await service.dispatch("actions.list", undefined, {
          source: "user",
          contextOverride: { hostConfirmed: true },
        });

        expect(result.ok).toBe(true);
        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ hostConfirmed: undefined })
        );
      });

      // The per-target half of the same attestation (#12123). A selectable
      // confirmation resolves to a SUBSET, and the action has to know which
      // subset — so the stamp carries the rows, on the same unspoofable terms.
      it("stamps ctx.hostApprovedTargets from the dispatch options", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        await service.dispatch("actions.list", undefined, {
          source: "agent",
          confirmed: true,
          hostApprovedTargets: [{ id: "t1", observedAgentRunning: true }],
        });

        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({
            hostApprovedTargets: [{ id: "t1", observedAgentRunning: true }],
          })
        );
      });

      // Distinct from an absent stamp, and the distinction is the whole gate: an
      // action must be able to tell "the approver kept nothing" from "no
      // selectable confirmation ran", because only the second is a refusal to act.
      it("carries an empty approval through as an empty array, not as absent", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        await service.dispatch("actions.list", undefined, {
          source: "agent",
          confirmed: true,
          hostApprovedTargets: [],
        });

        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ hostApprovedTargets: [] })
        );
      });

      // The recipe half (#12263). Same unspoofable terms, and load-bearing for
      // a different reason: this one decides HOW MANY terminals a run may open,
      // so a caller able to plant it could hand itself the full ten-pane recipe
      // the confirm dialog exists to gate.
      it("stamps ctx.hostApprovedRecipeRun from the dispatch options", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        await service.dispatch("actions.list", undefined, {
          source: "agent",
          confirmed: true,
          hostApprovedRecipeRun: { recipeId: "r1", terminalCount: 10, terminalsDigest: "deadbeef" },
        });

        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({
            hostApprovedRecipeRun: { recipeId: "r1", terminalCount: 10, terminalsDigest: "deadbeef" },
          })
        );
      });

      it("overwrites a contextOverride that claims a recipe approval nobody gave", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        const result = await service.dispatch("actions.list", undefined, {
          source: "agent",
          confirmed: true,
          contextOverride: {
            hostApprovedRecipeRun: { recipeId: "r1", terminalCount: 10, terminalsDigest: "deadbeef" },
          },
        });

        expect(result.ok).toBe(true);
        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ hostApprovedRecipeRun: undefined })
        );
      });

      it("overwrites a contextOverride that claims per-target approvals nobody gave", async () => {
        const mockRun = vi.fn().mockResolvedValue(undefined);
        service.register(confirmAction(mockRun));

        const result = await service.dispatch("actions.list", undefined, {
          source: "user",
          contextOverride: {
            hostApprovedTargets: [{ id: "t1", observedAgentRunning: false }],
          },
        });

        expect(result.ok).toBe(true);
        expect(mockRun).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({ hostApprovedTargets: undefined })
        );
      });

      it("maps a staged confirmation to CONFIRMATION_REQUIRED rather than resolving ok", async () => {
        const mockRun = vi
          .fn()
          .mockRejectedValue(new ConfirmationStagedError("Killing it did not happen"));
        service.register(confirmAction(mockRun));

        const result = await service.dispatch("actions.list", undefined, {
          source: "agent",
          confirmed: true,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
          expect(result.error.message).toContain("did not happen");
        }
      });
    });

    it("returns BINDING_STALE when contextOverride projectId differs from live context (#8432)", async () => {
      const mockRun = vi.fn().mockResolvedValue(undefined);
      const action: ActionDefinition = {
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
      service.setContextProvider(() => ({ projectId: "project-B" }));

      const result = await service.dispatch("actions.list", undefined, {
        contextOverride: { projectId: "project-A" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BINDING_STALE");
        expect(result.error.message).toContain("Do not retry");
      }
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("allows contextOverride when projectId matches live context (#8432)", async () => {
      const mockRun = vi.fn().mockResolvedValue("ok");
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
      service.setContextProvider(() => ({ projectId: "project-A" }));

      const result = await service.dispatch("actions.list", undefined, {
        contextOverride: { projectId: "project-A" },
      });

      expect(result.ok).toBe(true);
      expect(mockRun).toHaveBeenCalled();
    });

    it("allows contextOverride when liveContext has no projectId (#8432)", async () => {
      const mockRun = vi.fn().mockResolvedValue("ok");
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
      service.setContextProvider(() => ({}));

      const result = await service.dispatch("actions.list", undefined, {
        contextOverride: { projectId: "project-A" },
      });

      expect(result.ok).toBe(true);
      expect(mockRun).toHaveBeenCalled();
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
        description:
          "A safe action used for testing lastAction recording and repeat eligibility in ActionService.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      const restrictedAction: ActionDefinition = {
        id: "actions.restricted" as ActionId,
        title: "Restricted Action",
        description:
          "A restricted action used for testing that restricted danger actions cannot be dispatched.",
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

    it("should omit actions whose isVisible returns false", () => {
      const visibleAction: ActionDefinition = {
        id: "actions.visible" as ActionId,
        title: "Visible Action",
        description:
          "A visible action used for testing that isVisible: () => true keeps the entry in list() output.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isVisible: () => true,
        run: vi.fn().mockResolvedValue(undefined),
      };

      const hiddenAction: ActionDefinition = {
        id: "actions.hidden" as ActionId,
        title: "Hidden Action",
        description:
          "A hidden action used for testing that isVisible: () => false removes the entry from list() output.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isVisible: () => false,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(visibleAction);
      service.register(hiddenAction);

      const manifest = service.list();
      expect(manifest).toHaveLength(1);
      expect(manifest[0]!.id).toBe("actions.visible");
    });

    it("should default to visible when isVisible is undefined", () => {
      const action: ActionDefinition = {
        id: "actions.noVisible" as ActionId,
        title: "No Visible Action",
        description:
          "An action without isVisible used for testing that the default behavior keeps the entry in list() output.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest).toHaveLength(1);
      expect(manifest[0]!.id).toBe("actions.noVisible");
    });

    it("should still exclude restricted actions even when isVisible returns true", () => {
      const restrictedVisible: ActionDefinition = {
        id: "actions.restrictedVisible" as ActionId,
        title: "Restricted Visible Action",
        description:
          "A restricted action with isVisible: () => true used for testing that the restricted gate takes precedence.",
        category: "test",
        kind: "command",
        danger: "restricted",
        scope: "renderer",
        isVisible: () => true,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(restrictedVisible);
      const manifest = service.list();

      expect(manifest).toHaveLength(0);
    });

    it("should still return hidden actions from get()", () => {
      const hiddenAction: ActionDefinition = {
        id: "actions.hiddenButFetchable" as ActionId,
        title: "Hidden But Fetchable Action",
        description:
          "A hidden action used for testing that get() ignores isVisible and returns the manifest entry by id.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isVisible: () => false,
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(hiddenAction);
      const entry = service.get("actions.hiddenButFetchable" as ActionId);

      expect(entry).not.toBeNull();
      expect(entry!.id).toBe("actions.hiddenButFetchable");
    });

    it("should still dispatch hidden actions (isVisible is discovery-only)", async () => {
      const run = vi.fn().mockResolvedValue("ran");
      const hiddenAction: ActionDefinition = {
        id: "actions.hiddenButDispatchable" as ActionId,
        title: "Hidden But Dispatchable Action",
        description:
          "A hidden action used for testing that dispatch() ignores isVisible and still invokes run.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isVisible: () => false,
        run,
      };

      service.register(hiddenAction);
      const result = await service.dispatch("actions.hiddenButDispatchable" as ActionId);

      expect(result.ok).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("should forward the explicit ctx argument to isVisible", () => {
      const action: ActionDefinition = {
        id: "actions.ctxAware" as ActionId,
        title: "Context-Aware Action",
        description:
          "An action whose isVisible inspects the provided context to validate context forwarding through list().",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isVisible: (ctx) => ctx.projectId === "project-visible",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);

      const visibleManifest = service.list({ projectId: "project-visible" });
      const hiddenManifest = service.list({ projectId: "project-other" });

      expect(visibleManifest.map((e) => e.id)).toContain("actions.ctxAware");
      expect(hiddenManifest.map((e) => e.id)).not.toContain("actions.ctxAware");
    });

    it("should propagate keywords to manifest entries", () => {
      const action: ActionDefinition = {
        id: "actions.keyworded" as ActionId,
        title: "Keyworded Action",
        description:
          "An action with keywords used for testing keyword propagation in manifest entries.",
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
        description:
          "An action without keywords used for testing that keywords default to undefined in manifest entries.",
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

    it("should propagate mcpAnnotations to manifest entries", () => {
      const action: ActionDefinition = {
        id: "actions.annotated" as ActionId,
        title: "Annotated Action",
        description:
          "An action with explicit MCP overrides for testing mcpAnnotations propagation in manifest entries.",
        category: "test",
        kind: "query",
        danger: "confirm",
        scope: "renderer",
        mcpAnnotations: { destructiveHint: false, readOnlyHint: true, idempotentHint: false },
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest[0]!.mcpAnnotations).toEqual({
        destructiveHint: false,
        readOnlyHint: true,
        idempotentHint: false,
      });
    });

    it("should omit mcpAnnotations when not defined", () => {
      const action: ActionDefinition = {
        id: "actions.unannotated" as ActionId,
        title: "Unannotated Action",
        description:
          "An action without explicit MCP overrides for testing that mcpAnnotations defaults to undefined.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const manifest = service.list();

      expect(manifest[0]!.mcpAnnotations).toBeUndefined();
    });

    it("should isolate mcpAnnotations from caller mutations", () => {
      // Returned manifest entries must not share references with the
      // registered definition, so a caller that mutates entry.mcpAnnotations
      // can't poison subsequent list() reads.
      const action: ActionDefinition = {
        id: "actions.isolated" as ActionId,
        title: "Isolated Action",
        description:
          "Mutation-isolation guard used for testing that manifest entry schemas are defensive copies.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        mcpAnnotations: { destructiveHint: false },
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const first = service.list()[0]!;
      first.mcpAnnotations!.destructiveHint = true;

      const second = service.list()[0]!;
      expect(second.mcpAnnotations).toEqual({ destructiveHint: false });
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

    it("propagates examples and dangerRationale from definition to manifest entry", () => {
      const action: ActionDefinition = {
        id: "test.examples" as ActionId,
        title: "Test Examples Action",
        description: "An action with examples and danger rationale for propagation testing.",
        category: "test",
        kind: "command",
        danger: "confirm",
        scope: "renderer",
        examples: [{ args: { key: "value" }, description: "Example invocation" }],
        dangerRationale: "This action is destructive because it mutates shared state.",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const entry = service.get("test.examples" as ActionId);

      expect(entry).not.toBeNull();
      expect(entry!.examples).toEqual([
        { args: { key: "value" }, description: "Example invocation" },
      ]);
      expect(entry!.dangerRationale).toBe(
        "This action is destructive because it mutates shared state."
      );
    });

    it("isolates examples[].args from caller mutations", () => {
      const action: ActionDefinition = {
        id: "test.examples" as ActionId,
        title: "Test Examples Action",
        description: "An action with examples for nested mutation-isolation testing.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        examples: [{ args: { key: "value" }, description: "Example invocation" }],
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      // A shallow array copy ([...examples]) would leave examples[0].args aliased
      // to the static definition, so this nested write would leak (issue #9569).
      const first = service.get("test.examples" as ActionId)!;
      (first.examples![0]!.args as Record<string, unknown>).key = "mutated";
      const second = service.get("test.examples" as ActionId)!;
      expect((second.examples![0]!.args as Record<string, unknown>).key).toBe("value");
    });

    it("omits examples and dangerRationale from manifest entry when not defined", () => {
      const action: ActionDefinition = {
        id: "test.noexamples" as ActionId,
        title: "Test No Examples",
        description: "An action without examples or danger rationale for propagation testing.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const entry = service.get("test.noexamples" as ActionId);

      expect(entry).not.toBeNull();
      expect(entry!.examples).toBeUndefined();
      expect(entry!.dangerRationale).toBeUndefined();
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
        description:
          "A test action for validating ActionService dispatch, registration, and manifest entry generation.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
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

    it("includes confirmed in payload when agent dispatches confirm action with confirmed:true", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "worktree.delete" as ActionId,
          title: "T",
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
          category: "worktree",
          kind: "command",
          danger: "confirm",
          scope: "renderer",
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("worktree.delete" as ActionId, undefined, {
          source: "agent",
          confirmed: true,
        });
        await Promise.resolve();
        expect(emit).toHaveBeenCalledTimes(1);
        const payload = emit.mock.calls[0]![1] as Record<string, unknown>;
        expect(payload.confirmed).toBe(true);
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

    it("does not capture plugin-source dispatches", async () => {
      service.register(makeAction("test.user"));
      service.register(makeAction("test.plugin"));

      await service.dispatch("test.user" as ActionId, undefined, { source: "user" });
      expect(service.getLastAction()?.actionId).toBe("test.user");

      await service.dispatch("test.plugin" as ActionId, undefined, { source: "plugin" });
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

    it("nonRepeatable outer action that dispatches an inner primary yields lastAction = inner primary", async () => {
      // A nonRepeatable outer action never overwrites lastAction, so when it
      // dispatches an inner primary the primary is what action.repeatLast replays.
      service.register(makeAction("test.primary"));
      service.register(
        makeAction("test.forwarder", {
          nonRepeatable: true,
          run: async () => {
            await service.dispatch("test.primary" as ActionId, undefined, { source: "user" });
          },
        })
      );

      await service.dispatch(
        "test.forwarder" as ActionId,
        { marker: "forwarder" },
        { source: "user" }
      );

      expect(service.getLastAction()).toEqual({
        actionId: "test.primary",
        args: undefined,
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

    it("does not emit hint when the action opts out via suppressShortcutHint", async () => {
      mockGetEffectiveCombo.mockReturnValue("Cmd+K");
      mockGetDisplayCombo.mockReturnValue("⌘K");
      mockShow.mockReturnValue(true);

      service.register({ ...makeAction("test.suppressed"), suppressShortcutHint: true });
      await service.dispatch("test.suppressed" as ActionId, undefined, { source: "user" });

      expect(mockShow).not.toHaveBeenCalled();
      expect(mockIncrementCount).not.toHaveBeenCalled();
    });

    describe("overlay-opening actions", () => {
      /**
       * Builds an action whose run() crosses a real macrotask before it
       * mutates the overlay stack, so the dispatch continuation resumes
       * *after* the mutation — the ordering a React passive effect produces
       * in production. A bare `Promise.resolve()` leaves no gap and would
       * pass whether or not the ordering logic is correct.
       */
      const makeOverlayAction = (id: string, mutateOverlays: () => void): ActionDefinition => ({
        ...makeAction(id),
        run: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              mutateOverlays();
              resolve();
            }, 0);
          });
        },
      });

      const { addOverlayClaim, removeOverlayClaim } = useUIStore.getState();

      beforeEach(() => {
        useUIStore.setState({ overlayStack: [] });
        mockGetEffectiveCombo.mockReturnValue("Cmd+K");
        mockGetDisplayCombo.mockReturnValue("⌘K");
        mockShow.mockReturnValue(true);
      });

      // uiStore is a module-scope singleton — leave it clean so a test added
      // after this block doesn't inherit claims from here.
      afterEach(() => {
        useUIStore.setState({ overlayStack: [] });
      });

      it("suppresses the hint when the action opens an overlay", async () => {
        service.register(
          makeOverlayAction("test.opensDialog", () => addOverlayClaim("dialog-opened"))
        );

        const result = await service.dispatch("test.opensDialog" as ActionId, undefined, {
          source: "user",
        });

        // A rejected dispatch also emits no hint, so pin the success path —
        // otherwise a broken fixture would satisfy the assertions below.
        expect(result.ok).toBe(true);
        expect(mockShow).not.toHaveBeenCalled();
        expect(mockIncrementCount).not.toHaveBeenCalled();
      });

      it("suppresses the hint when an overlay opens on top of an existing one", async () => {
        addOverlayClaim("dialog-base");
        service.register(
          makeOverlayAction("test.nestsDialog", () => addOverlayClaim("dialog-nested"))
        );

        const result = await service.dispatch("test.nestsDialog" as ActionId, undefined, {
          source: "user",
        });

        expect(result.ok).toBe(true);
        expect(mockShow).not.toHaveBeenCalled();
        expect(mockIncrementCount).not.toHaveBeenCalled();
      });

      it("still emits the hint when a pre-existing overlay is left untouched", async () => {
        addOverlayClaim("dialog-already-open");
        service.register(makeOverlayAction("test.insideDialog", () => {}));

        await service.dispatch("test.insideDialog" as ActionId, undefined, { source: "user" });

        expect(mockIncrementCount).toHaveBeenCalledWith("test.insideDialog");
        expect(mockShow).toHaveBeenCalledWith("test.insideDialog", "⌘K");
      });

      it("suppresses the hint when one overlay replaces another at the same depth", async () => {
        addOverlayClaim("dialog-a");
        service.register(
          makeOverlayAction("test.swapsDialog", () => {
            removeOverlayClaim("dialog-a");
            addOverlayClaim("dialog-b");
          })
        );

        const result = await service.dispatch("test.swapsDialog" as ActionId, undefined, {
          source: "user",
        });

        expect(result.ok).toBe(true);
        expect(mockShow).not.toHaveBeenCalled();
        expect(mockIncrementCount).not.toHaveBeenCalled();
      });

      it("still emits the hint when an overlay opened during the run has closed again", async () => {
        service.register(
          makeOverlayAction("test.transientDialog", () => {
            addOverlayClaim("dialog-transient");
            removeOverlayClaim("dialog-transient");
          })
        );

        await service.dispatch("test.transientDialog" as ActionId, undefined, { source: "user" });

        expect(mockIncrementCount).toHaveBeenCalledWith("test.transientDialog");
        expect(mockShow).toHaveBeenCalledWith("test.transientDialog", "⌘K");
      });

      it("suppresses the hint when a claim id is released and re-registered", async () => {
        // A dialog reopening at the same tree position keeps its useId(), so
        // the stack reads identically before and after — only the epoch shows
        // that an overlay opened during the dispatch.
        addOverlayClaim("dialog-reused-id");
        service.register(
          makeOverlayAction("test.reopensDialog", () => {
            removeOverlayClaim("dialog-reused-id");
            addOverlayClaim("dialog-reused-id");
          })
        );

        const result = await service.dispatch("test.reopensDialog" as ActionId, undefined, {
          source: "user",
        });

        expect(result.ok).toBe(true);
        expect(mockShow).not.toHaveBeenCalled();
        expect(mockIncrementCount).not.toHaveBeenCalled();
      });

      it("still emits the hint when the action closes the open overlay", async () => {
        addOverlayClaim("dialog-being-closed");
        service.register(
          makeOverlayAction("test.closesDialog", () => removeOverlayClaim("dialog-being-closed"))
        );

        await service.dispatch("test.closesDialog" as ActionId, undefined, { source: "user" });

        expect(mockIncrementCount).toHaveBeenCalledWith("test.closesDialog");
        expect(mockShow).toHaveBeenCalledWith("test.closesDialog", "⌘K");
      });
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
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
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
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
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
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
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
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
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
        description:
          "Test action one for validating ActionService definition invariant warnings with multiple offending actions.",
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
        description:
          "Test action two for validating ActionService definition invariant warnings with multiple offending actions.",
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
        description:
          "Test action three for validating ActionService definition invariant warnings with multiple offending actions.",
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
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
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

  describe("manifest partial cache (issue #7284)", () => {
    it("returns deeply-equal inputSchema across list() calls", () => {
      const argsSchema = z.object({ count: z.number() });
      service.register({
        id: "actions.list" as ActionId,
        title: "Test",
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema,
        run: vi.fn().mockResolvedValue(undefined),
      });

      const first = service.list()[0]!.inputSchema;
      const second = service.list()[0]!.inputSchema;
      expect(first).toEqual(second);
    });

    it("isolates inputSchema from caller mutations", () => {
      const argsSchema = z.object({ count: z.number() });
      service.register({
        id: "actions.list" as ActionId,
        title: "Test",
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema,
        run: vi.fn().mockResolvedValue(undefined),
      });

      const first = service.list()[0]!.inputSchema as Record<string, unknown>;
      first.poisoned = "x";
      // Nested mutation: a shallow copy would leave `properties` aliased to the
      // cache, so this write would leak across reads (issue #9569).
      (first.properties as Record<string, unknown>).poisoned = "x";
      const second = service.list()[0]!.inputSchema as Record<string, unknown>;
      expect(second.poisoned).toBeUndefined();
      expect((second.properties as Record<string, unknown>).poisoned).toBeUndefined();
    });

    it("isolates outputSchema from caller mutations", () => {
      const argsSchema = z.object({ count: z.number() });
      const resultSchema = z.object({ total: z.number() });
      service.register({
        id: "actions.list" as ActionId,
        title: "Test",
        description:
          "Test action for validating ActionService definition invariant warnings and registration behavior.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema,
        resultSchema,
        mcpOutputSchema: true,
        run: vi.fn().mockResolvedValue({ total: 1 }),
      });

      const first = service.list()[0]!.outputSchema as Record<string, unknown>;
      (first.properties as Record<string, unknown>).poisoned = "x";
      const second = service.list()[0]!.outputSchema as Record<string, unknown>;
      expect((second.properties as Record<string, unknown>).poisoned).toBeUndefined();
    });

    it("isolates a raw plugin inputSchema from source-object mutation", () => {
      const rawInputSchema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const action = {
        id: "acme.plugin.raw" as ActionId,
        title: "Raw",
        description:
          "Plugin action with a raw input schema for mutation-isolation testing of the cache.",
        category: "plugin",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        rawInputSchema,
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action as unknown as ActionDefinition);

      // Trigger schema compilation, then mutate the plugin's own source object.
      service.get("acme.plugin.raw" as ActionId);
      (rawInputSchema.properties as Record<string, unknown>).poisoned = { type: "string" };

      const entry = service.get("acme.plugin.raw" as ActionId);
      expect(
        (entry!.inputSchema as { properties: Record<string, unknown> }).properties.poisoned
      ).toBeUndefined();
    });

    it("does not freeze a plugin's own raw schema object (clones before DEV freeze)", () => {
      const rawInputSchema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const action = {
        id: "acme.plugin.raw" as ActionId,
        title: "Raw",
        description:
          "Plugin action with a raw input schema, verifying the source object stays writable.",
        category: "plugin",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        rawInputSchema,
        run: vi.fn().mockResolvedValue(undefined),
      };
      service.register(action as unknown as ActionDefinition);

      // Compilation must clone before the DEV freeze, leaving the source writable.
      service.get("acme.plugin.raw" as ActionId);
      expect(() => {
        (rawInputSchema.properties as Record<string, unknown>).extra = { type: "number" };
      }).not.toThrow();
    });

    it("evicts cache entry on unregister so re-register picks up new schema", () => {
      const schemaA = z.object({ a: z.string() });
      service.register({
        id: "actions.list" as ActionId,
        title: "T",
        description: "T",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: schemaA,
        run: vi.fn().mockResolvedValue(undefined),
      });

      const before = service.list()[0]!.inputSchema as { properties?: Record<string, unknown> };
      expect(before.properties).toHaveProperty("a");

      service.unregister("actions.list" as ActionId);

      const schemaB = z.object({ b: z.number() });
      service.register({
        id: "actions.list" as ActionId,
        title: "T",
        description: "T",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: schemaB,
        run: vi.fn().mockResolvedValue(undefined),
      });

      const after = service.list()[0]!.inputSchema as { properties?: Record<string, unknown> };
      expect(after.properties).toHaveProperty("b");
      expect(after.properties).not.toHaveProperty("a");
    });

    it("populates requiresArgs from cache (no per-call safeParse)", () => {
      const safeParseSpy = vi.fn();
      const requiredSchema = z.object({ name: z.string() });
      const proxy = new Proxy(requiredSchema, {
        get(target, prop, receiver) {
          if (prop === "safeParse") {
            return (...args: unknown[]) => {
              safeParseSpy(...args);
              return (target.safeParse as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      service.register({
        id: "actions.list" as ActionId,
        title: "T",
        description: "T",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: proxy as unknown as typeof requiredSchema,
        run: vi.fn().mockResolvedValue(undefined),
      });
      const callsAfterRegister = safeParseSpy.mock.calls.length;

      service.list();
      service.list();
      service.list();

      // No additional safeParse calls beyond the two performed at register-time
      expect(safeParseSpy.mock.calls.length).toBe(callsAfterRegister);
      expect(service.list()[0]!.requiresArgs).toBe(true);
    });
  });

  describe("lazy schema compilation (issue #8614)", () => {
    /**
     * The schemaCache is private; we read it via the same-file `unknown` cast
     * because ESM module-namespace freezing prevents `vi.spyOn(z, "toJSONSchema")`.
     * Cache state is the most direct observable signal that compilation has or
     * has not run.
     */
    function getSchemaCache(s: ActionService): Map<string, unknown> {
      return (s as unknown as { schemaCache: Map<string, unknown> }).schemaCache;
    }

    function getRequiresArgsCache(s: ActionService): Map<string, boolean> {
      return (s as unknown as { requiresArgsCache: Map<string, boolean> }).requiresArgsCache;
    }

    function registerSchemaAction(id = "actions.list" as ActionId): void {
      service.register({
        id,
        title: "Test",
        description:
          "Test action for validating ActionService lazy JSON schema compilation behavior under issue #8614.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        argsSchema: z.object({ name: z.string() }),
        run: vi.fn().mockResolvedValue(undefined),
      });
    }

    it("does not populate schemaCache during register()", () => {
      registerSchemaAction();
      expect(getSchemaCache(service).size).toBe(0);
    });

    it("populates requiresArgsCache eagerly during register()", () => {
      registerSchemaAction();
      expect(getRequiresArgsCache(service).get("actions.list" as ActionId)).toBe(true);
    });

    it("listIds() returns registered ids without populating schemaCache", () => {
      registerSchemaAction("actions.list" as ActionId);
      service.register({
        id: "actions.get" as ActionId,
        title: "T",
        description:
          "Test action for validating ActionService lazy JSON schema compilation behavior under issue #8614.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      });

      const ids = Array.from(service.listIds());
      expect(ids).toEqual(["actions.list", "actions.get"]);
      expect(getSchemaCache(service).size).toBe(0);
    });

    it("populates schemaCache on first list() call", () => {
      registerSchemaAction();
      expect(getSchemaCache(service).size).toBe(0);
      service.list();
      expect(getSchemaCache(service).size).toBe(1);
    });

    it("populates schemaCache on first get() call", () => {
      registerSchemaAction();
      expect(getSchemaCache(service).size).toBe(0);
      service.get("actions.list" as ActionId);
      expect(getSchemaCache(service).size).toBe(1);
    });

    it("caches no-argsSchema actions on first read so repeated calls do not recompute", () => {
      service.register({
        id: "actions.list" as ActionId,
        title: "T",
        description:
          "Test action for validating ActionService lazy JSON schema compilation behavior under issue #8614.",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      });

      service.list();
      const cache = getSchemaCache(service);
      // Without argsSchema, inputSchema is undefined — but the entry must exist
      // in the cache so .has() short-circuits subsequent recomputation.
      expect(cache.has("actions.list" as ActionId)).toBe(true);
      const cachedAfterFirst = cache.get("actions.list" as ActionId);
      service.list();
      service.get("actions.list" as ActionId);
      expect(cache.get("actions.list" as ActionId)).toBe(cachedAfterFirst);
    });

    it("unregister() clears both requiresArgsCache and schemaCache", () => {
      registerSchemaAction();
      service.list();
      expect(getSchemaCache(service).size).toBe(1);
      expect(getRequiresArgsCache(service).size).toBe(1);

      service.unregister("actions.list" as ActionId);
      expect(getSchemaCache(service).size).toBe(0);
      expect(getRequiresArgsCache(service).size).toBe(0);
    });

    it("list({ includeSchemas: false }) skips compilation and returns schema-free entries", () => {
      registerSchemaAction();
      const entries = service.list(undefined, { includeSchemas: false });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.inputSchema).toBeUndefined();
      expect(entries[0]!.outputSchema).toBeUndefined();
      expect(getSchemaCache(service).size).toBe(0);

      const full = service.list();
      expect(full[0]!.inputSchema).toBeDefined();
      expect(getSchemaCache(service).size).toBe(1);
    });

    it("getDispatchMeta() returns danger/title/description without populating schemaCache", () => {
      registerSchemaAction();
      const meta = service.getDispatchMeta("actions.list" as ActionId);
      expect(meta).toEqual({
        danger: "safe",
        title: "Test",
        description: expect.stringContaining("lazy JSON schema compilation"),
      });
      // A safe action carries no rationale — the conditional spread must omit
      // the property, not surface it as `dangerRationale: undefined`.
      expect(meta).not.toHaveProperty("dangerRationale");
      expect(getSchemaCache(service).size).toBe(0);
      expect(service.getDispatchMeta("actions.unknown" as ActionId)).toBeNull();
    });

    it("getDispatchMeta() surfaces dangerRationale for gated actions so the confirm dialog can show it (#11342)", () => {
      service.register({
        id: "worktree.delete" as ActionId,
        title: "Delete Worktree",
        description:
          "Test action for validating ActionService dangerRationale threading into the MCP confirm dialog.",
        category: "worktree",
        kind: "command",
        danger: "confirm",
        dangerRationale: "Permanently removes the worktree directory and any uncommitted changes.",
        scope: "renderer",
        run: vi.fn().mockResolvedValue(undefined),
      });

      const meta = service.getDispatchMeta("worktree.delete" as ActionId);
      expect(meta).toEqual({
        danger: "confirm",
        title: "Delete Worktree",
        description: expect.stringContaining("dangerRationale threading"),
        dangerRationale: "Permanently removes the worktree directory and any uncommitted changes.",
      });
    });
  });

  describe("dispatch error boundaries (issue #7284)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterAll(() => {
      warnSpy?.mockRestore();
    });

    it("returns DISABLED when isEnabled throws, does not crash dispatch", async () => {
      const run = vi.fn().mockResolvedValue("never");
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test",
        description: "T",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => {
          throw new Error("predicate broken");
        },
        run,
      };

      service.register(action);
      const result = await service.dispatch("actions.list" as ActionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DISABLED");
        expect(result.error.message).toBe("Action is currently disabled");
      }
      expect(run).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Action isEnabled threw during dispatch"),
        expect.objectContaining({ actionId: "actions.list" })
      );
    });

    it("returns DISABLED when disabledReason throws, falls back to default message", async () => {
      const action: ActionDefinition = {
        id: "actions.list" as ActionId,
        title: "Test",
        description: "T",
        category: "test",
        kind: "command",
        danger: "safe",
        scope: "renderer",
        isEnabled: () => false,
        disabledReason: () => {
          throw new Error("reason broken");
        },
        run: vi.fn().mockResolvedValue(undefined),
      };

      service.register(action);
      const result = await service.dispatch("actions.list" as ActionId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("DISABLED");
        expect(result.error.message).toBe("Action is currently disabled");
      }
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Action disabledReason threw during dispatch"),
        expect.objectContaining({ actionId: "actions.list" })
      );
    });

    it("includes actionId in error context when events.emit rejects", async () => {
      const originalWindow = (globalThis as { window?: unknown }).window;
      const existing = (globalThis as unknown as { window?: Record<string, unknown> }).window;
      Object.defineProperty(globalThis, "window", {
        value: {
          ...existing,
          electron: { events: { emit: vi.fn().mockRejectedValue(new Error("emit failed")) } },
        },
        writable: true,
        configurable: true,
      });
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: vi.fn().mockResolvedValue(undefined),
        });

        await service.dispatch("actions.list" as ActionId);
        // Flush microtasks so the awaited rejection inside emitActionDispatchedEvent settles
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Failed to emit action:dispatched event"),
          expect.objectContaining({ actionId: "actions.list" })
        );
      } finally {
        Object.defineProperty(globalThis, "window", {
          value: originalWindow,
          writable: true,
          configurable: true,
        });
      }
    });
  });

  describe("redaction substring matching (issue #7284)", () => {
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

    it("redacts substring matches at any nesting depth", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("actions.list" as ActionId, {
          apiKey: "k1",
          nested: { authHeader: "h1", refreshToken: "t1" },
          deep: { deeper: { credentialPath: "/secret" } },
          plainValue: "ok",
        });
        await Promise.resolve();

        const payload = emit.mock.calls[0]![1] as { args: Record<string, unknown> };
        const nested = payload.args.nested as Record<string, unknown>;
        const deep = (payload.args.deep as Record<string, unknown>).deeper as Record<
          string,
          unknown
        >;
        expect(payload.args.apiKey).toBe("[REDACTED]");
        expect(nested.authHeader).toBe("[REDACTED]");
        expect(nested.refreshToken).toBe("[REDACTED]");
        expect(deep.credentialPath).toBe("[REDACTED]");
        expect(payload.args.plainValue).toBe("ok");
      } finally {
        restore();
      }
    });

    it("matches case-insensitively (UPPERCASE field names)", async () => {
      const emit = vi.fn().mockResolvedValue(undefined);
      const restore = installEmit(emit);
      try {
        service.register({
          id: "actions.list" as ActionId,
          title: "T",
          description:
            "Test action with a short title for verifying title/description field propagation in manifest entries.",
          category: "test",
          kind: "command",
          danger: "safe",
          scope: "renderer",
          run: vi.fn().mockResolvedValue(undefined),
        });
        await service.dispatch("actions.list" as ActionId, {
          API_KEY: "k1",
          AuthHeader: "h1",
        });
        await Promise.resolve();

        const payload = emit.mock.calls[0]![1] as { args: Record<string, unknown> };
        expect(payload.args.API_KEY).toBe("[REDACTED]");
        expect(payload.args.AuthHeader).toBe("[REDACTED]");
      } finally {
        restore();
      }
    });
  });

  describe("cloneArgsForReplay fallback (issue #7284)", () => {
    const makeAction = (id: string): ActionDefinition => ({
      id: id as ActionId,
      title: "T",
      description: "T",
      category: "test",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      run: vi.fn().mockResolvedValue(undefined),
    });

    it("falls through JSON path when structuredClone fails (function arg dropped)", async () => {
      service.register(makeAction("test.fnArg"));
      // structuredClone throws DataCloneError on functions; JSON.stringify silently drops them.
      const args = { fn: () => "secret", x: 5 };
      await service.dispatch("test.fnArg" as ActionId, args, { source: "user" });

      const captured = service.getLastAction();
      expect(captured?.args).not.toBe(args);
      expect(captured?.args).toEqual({ x: 5 });
    });

    it("returns undefined (not the live reference) when both clone strategies fail", async () => {
      service.register(makeAction("test.bothFail"));
      // structuredClone fails on the function; JSON.stringify fails on BigInt.
      const args = { fn: () => "x", b: 1n };
      await service.dispatch("test.bothFail" as ActionId, args, { source: "user" });

      const captured = service.getLastAction();
      expect(captured?.actionId).toBe("test.bothFail");
      // Must NOT be the live reference — that would silently defeat replay isolation.
      expect(captured?.args).not.toBe(args);
      expect(captured?.args).toBeUndefined();
    });
  });

  describe("result validation (#11539)", () => {
    function makeAction(
      id: string,
      resultSchema: z.ZodType | undefined,
      result: unknown
    ): ActionDefinition<undefined, unknown> {
      return {
        id: id as ActionId,
        title: "Result Validation Test",
        description:
          "A test action used to verify that dispatch parses run() output against the declared resultSchema.",
        category: "test",
        kind: "query",
        danger: "safe",
        scope: "renderer",
        resultSchema,
        run: vi.fn().mockResolvedValue(result),
      };
    }

    it("strips keys the resultSchema does not declare", async () => {
      service.register(
        makeAction("test.strip", z.object({ id: z.string() }), {
          id: "abc",
          insertText: "/compact",
          aliases: ["a", "b"],
        })
      );

      const res = await service.dispatch("test.strip" as ActionId);

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result).toEqual({ id: "abc" });
    });

    it("strips undeclared keys from array rows, not just the root", async () => {
      service.register(
        makeAction("test.stripRows", z.object({ items: z.array(z.object({ id: z.string() })) }), {
          items: [
            { id: "1", processIds: [4711] },
            { id: "2", processIds: [4712] },
          ],
        })
      );

      const res = await service.dispatch("test.stripRows" as ActionId);

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result).toEqual({ items: [{ id: "1" }, { id: "2" }] });
    });

    it("strips for agent dispatch too — the MCP surface is not a special case", async () => {
      service.register(
        makeAction("test.stripAgent", z.object({ id: z.string() }), { id: "abc", secret: "leak" })
      );

      const res = await service.dispatch("test.stripAgent" as ActionId, undefined, {
        source: "agent",
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result).toEqual({ id: "abc" });
    });

    it("returns RESULT_VALIDATION_ERROR when the result violates its own schema", async () => {
      service.register(makeAction("test.violate", z.object({ id: z.string() }), { id: 42 }));

      const res = await service.dispatch("test.violate" as ActionId);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("RESULT_VALIDATION_ERROR");
    });

    it("never echoes the rejected value back in error details", async () => {
      // details crosses IPC to the MCP client, and a rejected result can hold
      // secrets. Only issue codes and structural depth may travel.
      service.register(
        makeAction("test.noEcho", z.object({ token: z.string() }), {
          token: { nested: "sk-live-SUPERSECRET" },
        })
      );

      const res = await service.dispatch("test.noEcho" as ActionId);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(JSON.stringify(res.error.details)).not.toContain("sk-live-SUPERSECRET");
    });

    it("never echoes a record KEY back in error details", async () => {
      // Under z.record the issue path segment IS data, not a schema-declared
      // field name — so a secret used as a key would ride out on the path.
      service.register(
        makeAction("test.recordKey", z.record(z.string(), z.string()), {
          "sk-live-SUPERSECRET": 42,
        })
      );

      const res = await service.dispatch("test.recordKey" as ActionId);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("RESULT_VALIDATION_ERROR");
      expect(JSON.stringify(res.error.details)).not.toContain("sk-live-SUPERSECRET");
    });

    it("does not record a rejected dispatch as repeatable or emit a completion event", async () => {
      // action:dispatched is a completion event and lastAction feeds
      // action.repeatLast — a dispatch that returned an error is neither.
      service.register(makeAction("test.notRepeatable", z.object({ id: z.string() }), { id: 1 }));

      const before = service.getLastAction();
      const res = await service.dispatch("test.notRepeatable" as ActionId, undefined, {
        source: "user",
      });

      expect(res.ok).toBe(false);
      expect(service.getLastAction()).toBe(before);
    });

    it("leaves the result untouched when no resultSchema is declared", async () => {
      const raw = { anything: "goes", n: 1 };
      service.register(makeAction("test.noSchema", undefined, raw));

      const res = await service.dispatch("test.noSchema" as ActionId);

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result).toBe(raw);
    });

    it("does not strip through a z.unknown() arm — the documented escape still works", async () => {
      service.register(
        makeAction("test.unknownArm", z.object({ items: z.array(z.unknown()) }), {
          items: [{ id: "1", providerNode: { raw: true } }],
        })
      );

      const res = await service.dispatch("test.unknownArm" as ActionId);

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result).toEqual({ items: [{ id: "1", providerNode: { raw: true } }] });
    });
  });
});
