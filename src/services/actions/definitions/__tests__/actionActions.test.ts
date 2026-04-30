import { describe, it, expect, vi, beforeEach } from "vitest";

const hintMocks = vi.hoisted(() => {
  const mockShow = vi.fn();
  const mockIncrementCount = vi.fn();
  const mockGetState = vi.fn(() => ({
    hydrated: true,
    counts: {} as Record<string, number>,
    show: mockShow,
    incrementCount: mockIncrementCount,
  }));
  return { mockShow, mockIncrementCount, mockGetState };
});

vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: hintMocks.mockGetState,
  },
}));

vi.mock("../../../KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(() => null),
    getDisplayCombo: vi.fn(() => ""),
  },
}));

import { actionService } from "../../../ActionService";
import { registerActionActions } from "../actionActions";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";

function registerIntoService(): void {
  const registry: ActionRegistry = new Map();
  registerActionActions(registry);
  for (const factory of registry.values()) {
    actionService.register(factory());
  }
}

function resetService() {
  // @ts-expect-error — private field reset for test isolation
  actionService.registry = new Map();
  // @ts-expect-error — private field reset for test isolation
  actionService.lastAction = null;
}

describe("action.repeatLast", () => {
  beforeEach(() => {
    resetService();
    registerIntoService();
  });

  const repeatableAction = (id: string, run: () => Promise<unknown>): ActionDefinition => ({
    id: id as ActionId,
    title: "Repeatable",
    description: "Repeatable test action",
    category: "test",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run,
  });

  it("re-dispatches the last action when invoked", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    actionService.register(repeatableAction("test.repeatable", run));

    await actionService.dispatch("test.repeatable" as ActionId, { foo: 1 }, { source: "user" });
    expect(run).toHaveBeenCalledTimes(1);

    const result = await actionService.dispatch("action.repeatLast" as ActionId, undefined, {
      source: "keybinding",
    });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toEqual({ foo: 1 });
  });

  it("returns an error when no action has been dispatched yet", async () => {
    const result = await actionService.dispatch("action.repeatLast" as ActionId, undefined, {
      source: "keybinding",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No action to repeat");
    }
  });

  it("does not overwrite lastAction when action.repeatLast itself is dispatched", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    actionService.register(repeatableAction("test.repeatable", run));

    await actionService.dispatch(
      "test.repeatable" as ActionId,
      { key: "value" },
      { source: "user" }
    );

    await actionService.dispatch("action.repeatLast" as ActionId, undefined, {
      source: "keybinding",
    });

    const last = actionService.getLastAction();
    expect(last?.actionId).toBe("test.repeatable");
    expect(last?.args).toEqual({ key: "value" });
  });

  it("surfaces errors from the inner action through the repeat dispatch", async () => {
    actionService.register(
      repeatableAction("test.fails", () => Promise.reject(new Error("inner boom")))
    );

    const first = await actionService.dispatch("test.fails" as ActionId, undefined, {
      source: "user",
    });
    expect(first.ok).toBe(false);

    await actionService
      .dispatch("test.repeatable" as ActionId, undefined, { source: "user" })
      .catch(() => {}); // not registered — ignored

    // Seed a successful capture, then replace with a now-failing action at the same id
    const successRun = vi.fn().mockResolvedValue("ok");
    actionService.register(repeatableAction("test.ok", successRun));
    await actionService.dispatch("test.ok" as ActionId, { a: 1 }, { source: "user" });

    // Re-register as failing by resetting and re-adding
    resetService();
    registerIntoService();
    actionService.register(
      repeatableAction("test.ok", () => Promise.reject(new Error("boom on repeat")))
    );
    // @ts-expect-error — seed lastAction directly (replay target exists but now throws)
    actionService.lastAction = { actionId: "test.ok", args: { a: 1 } };

    const result = await actionService.dispatch("action.repeatLast" as ActionId, undefined, {
      source: "keybinding",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXECUTION_ERROR");
      expect(result.error.message).toContain("boom on repeat");
    }
  });
});
