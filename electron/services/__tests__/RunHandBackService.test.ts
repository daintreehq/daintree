import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eventEmitter = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    on: (event: string, cb: (payload?: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    emitted,
    _reset: () => {
      listeners.clear();
      emitted.length = 0;
    },
  };
});

vi.mock("../events.js", () => ({ events: eventEmitter }));

import { RunHandBackService } from "../RunHandBackService.js";
import {
  HAND_BACK_LOOK_LEASE_MS,
  HAND_BACK_MIN_WORK_MS,
  HAND_BACK_SEEN_DWELL_MS,
  isHandBackUnseen,
} from "../../../shared/utils/runHandBack.js";

const START = 1_900_000_000_000;

let services: RunHandBackService[] = [];

function makeService(deps: { isQuitting?: () => boolean } = {}) {
  const service = new RunHandBackService({ now: () => Date.now(), ...deps });
  services.push(service);
  return service;
}

function transition(
  runId: string,
  previousState: string,
  state: string,
  extra: { waitingReason?: string; timestamp?: number; agentIncarnation?: number } = {}
) {
  eventEmitter.emit("agent:state-changed", {
    terminalId: runId,
    previousState,
    state,
    trigger: "output",
    timestamp: extra.timestamp ?? Date.now(),
    ...(extra.waitingReason !== undefined ? { waitingReason: extra.waitingReason } : {}),
    ...(extra.agentIncarnation !== undefined ? { agentIncarnation: extra.agentIncarnation } : {}),
  });
}

/** A stint of watched work long enough to count, ending in `state`. */
function workThenStop(runId: string, state = "completed", waitingReason?: string) {
  transition(runId, "idle", "working");
  vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS);
  transition(runId, "working", state, waitingReason ? { waitingReason } : {});
}

function changes() {
  return eventEmitter.emitted
    .filter((e) => e.event === "terminal:hand-back-changed")
    .map((e) => e.payload as { id: string; unseen: boolean });
}

beforeEach(() => {
  eventEmitter._reset();
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  for (const service of services) service.dispose();
  services = [];
  vi.useRealTimers();
});

describe("RunHandBackService", () => {
  it("records an unseen hand-back when watched work stops", () => {
    const service = makeService();
    workThenStop("t1");

    const record = service.getRecord("t1");
    expect(record?.stoppedAt).toBe(START + HAND_BACK_MIN_WORK_MS);
    expect(isHandBackUnseen(record)).toBe(true);
    expect(changes()).toEqual([{ id: "t1", unseen: true, timestamp: expect.any(Number) }]);
  });

  it("keeps the same hand-back through the completed → waiting slide", () => {
    const service = makeService();
    workThenStop("t1");
    const before = service.getRecord("t1");
    vi.advanceTimersByTime(500);
    transition("t1", "completed", "waiting");

    expect(service.getRecord("t1")).toBe(before);
    expect(changes()).toHaveLength(1);
  });

  it("counts a stop straight into a prompt wait as a hand-back", () => {
    const service = makeService();
    workThenStop("t1", "waiting", "prompt");
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
  });

  it.each(["approval", "question", "error"])("never treats a %s wait as a hand-back", (reason) => {
    const service = makeService();
    workThenStop("t1", "waiting", reason);
    expect(service.getRecord("t1")).toBeUndefined();
  });

  it("puts back the earlier hand-back when a completion turns out to be an ask", () => {
    const service = makeService();
    workThenStop("t1");
    service.markRead("t1");
    const earlier = service.getRecord("t1");

    workThenStop("t1");
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
    transition("t1", "completed", "waiting", { waitingReason: "approval" });

    expect(service.getRecord("t1")).toBe(earlier);
  });

  it("does not count a run first seen already stopped", () => {
    const service = makeService();
    transition("t1", "working", "completed");
    transition("t1", "completed", "waiting");
    expect(service.getRecord("t1")).toBeUndefined();
  });

  it("does not count a stint shorter than the work threshold", () => {
    const service = makeService();
    transition("t1", "idle", "working");
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS - 1);
    transition("t1", "working", "completed");
    expect(service.getRecord("t1")).toBeUndefined();
  });

  it("does not count exits or kills", () => {
    const service = makeService();
    transition("t1", "idle", "working");
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS);
    transition("t1", "working", "exited");
    transition("t2", "idle", "working");
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS);
    transition("t2", "working", "idle");

    expect(service.getRecord("t1")).toBeUndefined();
    expect(service.getRecord("t2")).toBeUndefined();
  });

  it("records nothing while the app is shutting down", () => {
    let quitting = false;
    const service = makeService({ isQuitting: () => quitting });
    transition("t1", "idle", "working");
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS);
    quitting = true;
    transition("t1", "working", "completed");
    expect(service.getRecord("t1")).toBeUndefined();
  });

  it("reads a hand-back once a look has lasted the dwell after the stop", () => {
    const service = makeService();
    workThenStop("t1");
    service.noteLook("t1", "view-1", true);

    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS - 1);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(false);
    expect(changes().at(-1)).toMatchObject({ id: "t1", unseen: false });
  });

  it("makes a look already going when the run stops last the dwell past the stop", () => {
    const service = makeService();
    transition("t1", "idle", "working");
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS * 10);
    transition("t1", "working", "completed");

    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(false);
  });

  it("reads nothing from a look that ends before the dwell", () => {
    const service = makeService();
    workThenStop("t1");
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS - 100);
    service.noteLook("t1", "view-1", false);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 4);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
  });

  it("drops a look its view stops renewing", () => {
    const service = makeService();
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_LOOK_LEASE_MS + 1);
    workThenStop("t1");
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 4);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
  });

  it("drops a forgotten view's looks", () => {
    const service = makeService();
    workThenStop("t1");
    service.noteLook("t1", "view-1", true);
    service.forgetViewer("view-1");
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 4);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
  });

  it("holds a mark unread against the look it was made from", () => {
    const service = makeService();
    workThenStop("t1");
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(false);

    expect(service.markUnread("t1")).toBe(true);
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 4);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);

    // A fresh look, begun after the mark, reads it again.
    service.noteLook("t1", "view-1", false);
    vi.advanceTimersByTime(1);
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(false);
  });

  it("marks read by hand, and refuses runs with nothing to read", () => {
    const service = makeService();
    expect(service.markRead("t1")).toBe(false);
    expect(service.markUnread("t1")).toBe(false);
    workThenStop("t1");
    expect(service.markRead("t1")).toBe(true);
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(false);
    expect(service.markRead("t1")).toBe(false);
  });

  it("drops a hand-back from before the terminal last spawned", () => {
    const service = makeService();
    workThenStop("t1");
    expect(service.getRecord("t1", START)).toBeDefined();
    expect(service.getRecord("t1", Date.now() + 1)).toBeUndefined();
    expect(service.getRecord("t1")).toBeUndefined();
  });

  it("forgets runs a complete inventory no longer has", () => {
    const service = makeService();
    workThenStop("t1");
    workThenStop("t2");
    service.retain(new Set(["t2"]), Date.now() + 1);
    expect(service.getRecord("t1")).toBeUndefined();
    expect(service.getRecord("t2")).toBeDefined();
  });

  it("keeps a run observed after the inventory read began", () => {
    const service = makeService();
    const readStartedAt = Date.now();
    transition("t1", "idle", "working");
    service.retain(new Set(), readStartedAt);
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS);
    transition("t1", "working", "completed");
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
  });

  it("starts afresh when another agent starts in the same terminal", () => {
    const service = makeService();
    transition("t1", "idle", "working", { agentIncarnation: 1 });
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS);
    transition("t1", "working", "completed", { agentIncarnation: 1 });
    expect(service.getRecord("t1")).toBeDefined();

    transition("t1", "completed", "idle", { agentIncarnation: 2 });
    expect(service.getRecord("t1")).toBeUndefined();
    expect(changes().at(-1)).toMatchObject({ id: "t1", unseen: false });
    transition("t1", "idle", "working", { agentIncarnation: 2 });
    transition("t1", "working", "waiting", { agentIncarnation: 2 });
    expect(service.getRecord("t1")).toBeUndefined();
  });

  it("says when the user marked it from the hand-back's own surfaces", () => {
    const service = makeService();
    workThenStop("t1");
    service.markRead("t1", true);
    expect(changes().at(-1)).toMatchObject({ unseen: false, fromUser: true });
    service.markUnread("t1");
    expect(changes().at(-1)).not.toHaveProperty("fromUser");
  });

  it("leaves no timers armed after dispose", () => {
    const service = makeService();
    workThenStop("t1");
    service.noteLook("t1", "view-1", true);
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
