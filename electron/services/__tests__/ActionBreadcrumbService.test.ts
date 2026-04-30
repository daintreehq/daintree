import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addBreadcrumbMock = vi.hoisted(() => vi.fn());

vi.mock("../TelemetryService.js", () => ({
  addActionBreadcrumb: addBreadcrumbMock,
}));

import { events, type DaintreeEventMap } from "../events.js";
import {
  ActionBreadcrumbService,
  _resetActionBreadcrumbServiceForTest,
  getActionBreadcrumbService,
} from "../ActionBreadcrumbService.js";

function emit(
  overrides: Partial<DaintreeEventMap["action:dispatched"]> = {}
): DaintreeEventMap["action:dispatched"] {
  const payload: DaintreeEventMap["action:dispatched"] = {
    actionId: "test.action",
    source: "user",
    context: {},
    timestamp: Date.now(),
    category: "test",
    durationMs: 1,
    ...overrides,
  };
  events.emit("action:dispatched", payload);
  return payload;
}

describe("ActionBreadcrumbService", () => {
  let service: ActionBreadcrumbService;

  beforeEach(() => {
    addBreadcrumbMock.mockReset();
    _resetActionBreadcrumbServiceForTest();
    service = getActionBreadcrumbService();
    service.initialize();
  });

  afterEach(() => {
    _resetActionBreadcrumbServiceForTest();
  });

  describe("ring buffer", () => {
    it("starts empty", () => {
      expect(service.getRecentActions()).toEqual([]);
    });

    it("records a dispatched event", () => {
      emit({ actionId: "foo", category: "bar", durationMs: 5 });
      const recent = service.getRecentActions();
      expect(recent).toHaveLength(1);
      expect(recent[0]!.actionId).toBe("foo");
      expect(recent[0]!.category).toBe("bar");
      expect(recent[0]!.durationMs).toBe(5);
      expect(recent[0]!.count).toBe(1);
    });

    it("caps the ring at 50 entries and evicts the oldest", () => {
      for (let i = 0; i < 60; i++) {
        emit({ actionId: `action.${i}`, timestamp: Date.now() + i * 1000 });
      }
      const recent = service.getRecentActions();
      expect(recent).toHaveLength(50);
      expect(recent[0]!.actionId).toBe("action.10");
      expect(recent[recent.length - 1]!.actionId).toBe("action.59");
    });

    it("returns a defensive copy — mutating it does not affect internal state", () => {
      emit({ actionId: "foo" });
      const recent = service.getRecentActions();
      recent[0]!.count = 999;
      recent.push({
        id: "evil",
        actionId: "injected",
        category: "x",
        source: "user",
        durationMs: 0,
        timestamp: 0,
        count: 1,
      });
      const fresh = service.getRecentActions();
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.count).toBe(1);
    });

    it("subscribes only once across repeated initialize() calls", () => {
      service.initialize();
      service.initialize();
      emit({ actionId: "foo" });
      expect(service.getRecentActions()).toHaveLength(1);
    });
  });

  describe("deduplication", () => {
    it("merges repeats of the same action within 250ms by incrementing count", () => {
      const t = 10_000;
      emit({ actionId: "scroll", timestamp: t, durationMs: 1 });
      emit({ actionId: "scroll", timestamp: t + 100, durationMs: 2 });
      emit({ actionId: "scroll", timestamp: t + 200, durationMs: 3 });

      const recent = service.getRecentActions();
      expect(recent).toHaveLength(1);
      expect(recent[0]!.count).toBe(3);
      expect(recent[0]!.durationMs).toBe(3);
      expect(recent[0]!.timestamp).toBe(t + 200);
    });

    it("treats a 251ms gap as a new entry", () => {
      const t = 10_000;
      emit({ actionId: "scroll", timestamp: t });
      emit({ actionId: "scroll", timestamp: t + 251 });
      const recent = service.getRecentActions();
      expect(recent).toHaveLength(2);
      expect(recent.every((e) => e.count === 1)).toBe(true);
    });

    it("does not dedup across different actionIds even within 250ms", () => {
      const t = 10_000;
      emit({ actionId: "foo", timestamp: t });
      emit({ actionId: "bar", timestamp: t + 50 });
      const recent = service.getRecentActions();
      expect(recent).toHaveLength(2);
    });

    it("does not dedup when the newer payload has an earlier timestamp (out-of-order completion)", () => {
      // Scenario: two concurrent dispatches of the same action. Call A starts at t=0
      // and finishes after 5000ms; call B starts at t=1000 and finishes instantly.
      // B emits first with timestamp=1000. A emits second with timestamp=0. Dedup
      // must treat A as a distinct entry, not merge it into B.
      emit({ actionId: "slow.op", timestamp: 1000 });
      emit({ actionId: "slow.op", timestamp: 0 });
      const recent = service.getRecentActions();
      expect(recent).toHaveLength(2);
      expect(recent.every((e) => e.count === 1)).toBe(true);
    });
  });

  describe("lifecycle", () => {
    it("dispose() clears ring and lastEntry so a post-reinit dispatch creates a fresh entry", () => {
      const t = 10_000;
      emit({ actionId: "foo", timestamp: t });
      expect(service.getRecentActions()).toHaveLength(1);

      service.dispose();
      expect(service.getRecentActions()).toHaveLength(0);

      service.initialize();
      emit({ actionId: "foo", timestamp: t + 50 });
      const recent = service.getRecentActions();
      expect(recent).toHaveLength(1);
      expect(recent[0]!.count).toBe(1);
    });
  });

  describe("defensive copies", () => {
    it("mutating getRecentActions()[i].args does not mutate the internal ring", () => {
      emit({ actionId: "foo", safeArgs: { show: true } });
      const recent = service.getRecentActions();
      (recent[0]!.args as Record<string, unknown>).show = false;
      const fresh = service.getRecentActions();
      expect((fresh[0]!.args as Record<string, unknown>).show).toBe(true);
    });
  });

  describe("Sentry breadcrumb emission", () => {
    it("calls addActionBreadcrumb once per new entry", () => {
      emit({ actionId: "foo" });
      expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
      const arg = addBreadcrumbMock.mock.calls[0]![0];
      expect(arg.actionId).toBe("foo");
      expect(arg.count).toBe(1);
    });

    it("emits a breadcrumb with the updated count on each dedup hit", () => {
      const t = 10_000;
      emit({ actionId: "scroll", timestamp: t });
      emit({ actionId: "scroll", timestamp: t + 50 });
      emit({ actionId: "scroll", timestamp: t + 100 });

      expect(addBreadcrumbMock).toHaveBeenCalledTimes(3);
      expect(addBreadcrumbMock.mock.calls[0]![0].count).toBe(1);
      expect(addBreadcrumbMock.mock.calls[1]![0].count).toBe(2);
      expect(addBreadcrumbMock.mock.calls[2]![0].count).toBe(3);
    });

    it("carries safeArgs through to the breadcrumb when present", () => {
      emit({ actionId: "preferences.showProjectPulse.set", safeArgs: { show: true } });
      const arg = addBreadcrumbMock.mock.calls[0]![0];
      expect(arg.args).toEqual({ show: true });
    });

    it("omits args field when safeArgs is absent", () => {
      emit({ actionId: "foo" });
      const arg = addBreadcrumbMock.mock.calls[0]![0];
      expect(arg.args).toBeUndefined();
    });
  });

  describe("resilience", () => {
    it("does not throw when addActionBreadcrumb throws", () => {
      addBreadcrumbMock.mockImplementationOnce(() => {
        throw new Error("sentry exploded");
      });
      expect(() => emit({ actionId: "foo" })).not.toThrow();
      expect(service.getRecentActions()).toHaveLength(1);
    });
  });
});
