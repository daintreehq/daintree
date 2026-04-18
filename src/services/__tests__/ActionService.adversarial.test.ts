import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  shortcutHintStore: { getState: hintMocks.mockGetState },
}));

vi.mock("../KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: hintMocks.mockGetEffectiveCombo,
    getDisplayCombo: hintMocks.mockGetDisplayCombo,
  },
}));

import { ActionService } from "../ActionService";
import type { ActionDefinition, ActionId } from "@shared/types/actions";

type EmitFn = (channel: string, payload: unknown) => Promise<void>;

function installEmit(emit: EmitFn | null) {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const existingWindow = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  const value = emit ? { ...existingWindow, electron: { events: { emit } } } : undefined;
  Object.defineProperty(globalThis, "window", {
    value,
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

function safeAction(id: string, overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: id as ActionId,
    title: "Test",
    description: "Test",
    category: "test",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ActionService adversarial", () => {
  let service: ActionService;
  let restoreWindow: (() => void) | null = null;

  beforeEach(() => {
    service = new ActionService();
    hintMocks.mockShow.mockReset();
    hintMocks.mockIncrementCount.mockReset();
    hintMocks.mockGetEffectiveCombo.mockReset().mockReturnValue(null);
    hintMocks.mockGetDisplayCombo.mockReset().mockReturnValue("");
    hintMocks.mockGetState.mockReturnValue({
      hydrated: true,
      counts: {},
      show: hintMocks.mockShow,
      incrementCount: hintMocks.mockIncrementCount,
    });
  });

  afterEach(() => {
    restoreWindow?.();
    restoreWindow = null;
  });

  it("concurrent dispatches of missing action both return NOT_FOUND with no side effects", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    restoreWindow = installEmit(emit);

    const [a, b] = await Promise.all([
      service.dispatch("app.settings" as ActionId),
      service.dispatch("app.settings" as ActionId),
    ]);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("NOT_FOUND");
    if (!b.ok) expect(b.error.code).toBe("NOT_FOUND");
    expect(emit).not.toHaveBeenCalled();
    expect(hintMocks.mockShow).not.toHaveBeenCalled();
    expect(hintMocks.mockIncrementCount).not.toHaveBeenCalled();
  });

  it("contextProvider throwing falls back to empty context for the handler", async () => {
    service.setContextProvider(() => {
      throw new Error("shutdown");
    });
    let observed: unknown = "unset";
    service.register(
      safeAction("actions.list", {
        run: vi.fn(async (_args, ctx) => {
          observed = ctx;
          return "ok";
        }),
      })
    );

    const result = await service.dispatch("actions.list" as ActionId);

    expect(result.ok).toBe(true);
    expect(observed).toEqual({});
  });

  it("events.emit throwing during teardown does not block handler execution", async () => {
    const emit = vi.fn(() => {
      throw new Error("WebContents destroyed");
    });
    restoreWindow = installEmit(emit);

    const run = vi.fn().mockResolvedValue("ran");
    service.register(safeAction("actions.list", { run }));

    const result = await service.dispatch("actions.list" as ActionId);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("events.emit rejecting does not block handler execution", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("WebContents destroyed"));
    restoreWindow = installEmit(emit);

    const run = vi.fn().mockResolvedValue("ran");
    service.register(safeAction("actions.list", { run }));

    const result = await service.dispatch("actions.list" as ActionId);

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("concurrent dispatches of a restricted action never invoke run", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    service.register(safeAction("actions.list", { danger: "restricted", run }));

    const results = await Promise.all([
      service.dispatch("actions.list" as ActionId),
      service.dispatch("actions.list" as ActionId),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("RESTRICTED");
    }
    expect(run).not.toHaveBeenCalled();
    expect(hintMocks.mockShow).not.toHaveBeenCalled();
  });

  it("circular args are redacted in emitted payload while handler receives the original reference", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    restoreWindow = installEmit(emit);

    const run = vi.fn().mockResolvedValue(undefined);
    service.register(safeAction("actions.list", { run }));

    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const result = await service.dispatch("actions.list" as ActionId, circular);

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe(circular);
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![1] as { args: unknown };
    expect(payload.args).toEqual({ _redacted: "unserializable" });
  });

  it("sensitive arg fields are redacted even when payload size is under limit", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    restoreWindow = installEmit(emit);

    service.register(safeAction("actions.list"));
    await service.dispatch("actions.list" as ActionId, {
      username: "alice",
      password: "hunter2",
      nested: { apiKey: "sk-xyz" },
    });

    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![1] as { args: Record<string, unknown> };
    expect(payload.args.username).toBe("alice");
    expect(payload.args.password).toBe("[REDACTED]");
    expect((payload.args.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });

  it("oversized args are replaced with a payload_too_large marker in the emitted payload", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    restoreWindow = installEmit(emit);

    service.register(safeAction("actions.list"));
    const big = { blob: "x".repeat(2048) };
    const result = await service.dispatch("actions.list" as ActionId, big);

    expect(result.ok).toBe(true);
    await Promise.resolve();
    const payload = emit.mock.calls[0]![1] as { args: { _redacted: string; size: number } };
    expect(payload.args._redacted).toBe("payload_too_large");
    expect(payload.args.size).toBeGreaterThan(1024);
  });

  it("synchronous throw and async reject both normalize to EXECUTION_ERROR with the original message", async () => {
    service.register(
      safeAction("actions.sync", {
        run: () => {
          throw new Error("sync boom");
        },
      })
    );
    service.register(
      safeAction("actions.async", {
        run: () => Promise.reject(new Error("async boom")),
      })
    );

    const [sync, async] = await Promise.all([
      service.dispatch("actions.sync" as ActionId),
      service.dispatch("actions.async" as ActionId),
    ]);

    expect(sync.ok).toBe(false);
    expect(async.ok).toBe(false);
    if (!sync.ok) {
      expect(sync.error.code).toBe("EXECUTION_ERROR");
      expect(sync.error.message).toContain("sync boom");
    }
    if (!async.ok) {
      expect(async.error.code).toBe("EXECUTION_ERROR");
      expect(async.error.message).toContain("async boom");
    }
  });

  it("shortcut hint failures never break dispatch flow", async () => {
    hintMocks.mockGetEffectiveCombo.mockImplementation(() => {
      throw new Error("keybinding service exploded");
    });
    const run = vi.fn().mockResolvedValue("ok");
    service.register(safeAction("actions.list", { run }));

    const result = await service.dispatch("actions.list" as ActionId, undefined, {
      source: "user",
    });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
