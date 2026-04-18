import { describe, expect, it, vi } from "vitest";
import { migration015 } from "../015-activation-funnel-and-checklist-rename.js";

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
    _data: data,
  } as unknown as Parameters<typeof migration015.up>[0] & {
    _data: Record<string, unknown>;
  };
}

describe("migration015 — activation funnel + checklist rename", () => {
  it("has version 15", () => {
    expect(migration015.version).toBe(15);
  });

  it("initializes activationFunnel to {} when missing", () => {
    const store = makeStoreMock({});
    migration015.up(store);
    expect(store.set).toHaveBeenCalledWith("activationFunnel", {});
  });

  it("leaves an existing activationFunnel object untouched", () => {
    const store = makeStoreMock({
      activationFunnel: { firstAgentTaskStartedAt: 12345, timeToFirstAgentTaskMs: 5000 },
    });
    migration015.up(store);
    // set should NOT be called for activationFunnel since it's already a non-null object
    const setSpy = store.set as unknown as ReturnType<typeof vi.fn>;
    expect(setSpy.mock.calls.filter((c: unknown[]) => c[0] === "activationFunnel")).toHaveLength(0);
  });

  it("renames checklist.items.subscribedNewsletter to ranSecondParallelAgent (reset to false regardless)", () => {
    const store = makeStoreMock({
      onboarding: {
        completed: false,
        checklist: {
          dismissed: false,
          celebrationShown: false,
          items: {
            openedProject: true,
            launchedAgent: true,
            createdWorktree: false,
            subscribedNewsletter: true,
          },
        },
      },
    });
    migration015.up(store);
    const onboarding = store._data.onboarding as {
      checklist: { items: Record<string, unknown> };
    };
    expect(onboarding.checklist.items.subscribedNewsletter).toBeUndefined();
    expect(onboarding.checklist.items.ranSecondParallelAgent).toBe(false);
    expect(onboarding.checklist.items.openedProject).toBe(true);
    expect(onboarding.checklist.items.launchedAgent).toBe(true);
    expect(onboarding.checklist.items.createdWorktree).toBe(false);
  });

  it("adds ranSecondParallelAgent: false when no subscribedNewsletter existed", () => {
    const store = makeStoreMock({
      onboarding: {
        completed: false,
        checklist: {
          dismissed: false,
          celebrationShown: false,
          items: { openedProject: true },
        },
      },
    });
    migration015.up(store);
    const onboarding = store._data.onboarding as {
      checklist: { items: Record<string, unknown> };
    };
    expect(onboarding.checklist.items.ranSecondParallelAgent).toBe(false);
  });

  it("is idempotent — no change on a second run", () => {
    const data: Record<string, unknown> = {
      onboarding: {
        completed: false,
        checklist: {
          dismissed: false,
          celebrationShown: false,
          items: {
            openedProject: true,
            launchedAgent: true,
            createdWorktree: true,
            subscribedNewsletter: true,
          },
        },
      },
    };
    const store = makeStoreMock(data);
    migration015.up(store);
    const afterFirst = JSON.stringify(data.onboarding);
    migration015.up(store);
    expect(JSON.stringify(data.onboarding)).toBe(afterFirst);
  });

  it("does not throw on missing onboarding state", () => {
    const store = makeStoreMock({});
    expect(() => migration015.up(store)).not.toThrow();
    expect(store._data.activationFunnel).toEqual({});
    expect(store._data.onboarding).toBeUndefined();
  });

  it("does not throw on onboarding without checklist", () => {
    const store = makeStoreMock({
      onboarding: { completed: false },
    });
    expect(() => migration015.up(store)).not.toThrow();
  });
});
