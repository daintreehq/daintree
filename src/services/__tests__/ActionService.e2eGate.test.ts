import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: () => ({
      hydrated: true,
      counts: {},
      show: vi.fn(),
      incrementCount: vi.fn(),
    }),
  },
}));

vi.mock("../KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: () => null,
    getDisplayCombo: () => "",
  },
}));

type WindowSlot = { window?: unknown };

function setWindow(value: unknown): () => void {
  const original = (globalThis as WindowSlot).window;
  Object.defineProperty(globalThis, "window", {
    value,
    writable: true,
    configurable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "window", {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

describe("ActionService window.__daintreeDispatchAction gate", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    vi.resetModules();
  });

  it("does not attach __daintreeDispatchAction when __DAINTREE_E2E_MODE__ is absent", async () => {
    const fakeWindow: Record<string, unknown> = {};
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(fakeWindow.__daintreeDispatchAction).toBeUndefined();
  });

  it("does not attach __daintreeDispatchAction when __DAINTREE_E2E_MODE__ is false", async () => {
    const fakeWindow: Record<string, unknown> = { __DAINTREE_E2E_MODE__: false };
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(fakeWindow.__daintreeDispatchAction).toBeUndefined();
  });

  it("rejects truthy-but-not-true values (e.g. string 'true')", async () => {
    const fakeWindow: Record<string, unknown> = { __DAINTREE_E2E_MODE__: "true" };
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(fakeWindow.__daintreeDispatchAction).toBeUndefined();
  });

  it("attaches __daintreeDispatchAction when __DAINTREE_E2E_MODE__ is true", async () => {
    const fakeWindow: Record<string, unknown> = { __DAINTREE_E2E_MODE__: true };
    restore = setWindow(fakeWindow);

    vi.resetModules();
    await import("../ActionService");

    expect(typeof fakeWindow.__daintreeDispatchAction).toBe("function");
  });

  it("forwards actionId, args, and options to actionService.dispatch", async () => {
    const fakeWindow: Record<string, unknown> = { __DAINTREE_E2E_MODE__: true };
    restore = setWindow(fakeWindow);

    vi.resetModules();
    const mod = await import("../ActionService");
    const spy = vi
      .spyOn(mod.actionService, "dispatch")
      .mockResolvedValue({ ok: true, result: undefined });

    const hook = fakeWindow.__daintreeDispatchAction as (
      actionId: string,
      args?: unknown,
      options?: { source?: string; confirmed?: boolean }
    ) => unknown;
    hook("actions.list", { foo: 1 }, { source: "agent", confirmed: true });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "actions.list",
      { foo: 1 },
      { source: "agent", confirmed: true }
    );
  });
});
