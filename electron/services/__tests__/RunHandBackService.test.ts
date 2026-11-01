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

describe("RunHandBackService ask waits", () => {
  function waitChanges(service: RunHandBackService) {
    const heard = { count: 0 };
    service.onWaitChanged(() => heard.count++);
    return heard;
  }

  it("begins an unseen wait on an approval or question wait, with no work watched", () => {
    for (const waitingReason of ["approval", "question"]) {
      const service = makeService();
      const heard = waitChanges(service);
      transition("t1", "idle", "waiting", { waitingReason });
      expect(service.getWait("t1")).toEqual({ stoppedAt: START });
      expect(heard.count).toBe(1);
      // A wait is never a hand-back, and says nothing on the hand-back's event.
      expect(service.getRecord("t1")).toBeUndefined();
      expect(changes()).toEqual([]);
      service.dispose();
    }
  });

  it("begins no wait at a prompt, a finish or an error", () => {
    const service = makeService();
    transition("t1", "idle", "waiting", { waitingReason: "prompt" });
    transition("t2", "idle", "completed");
    transition("t3", "idle", "waiting", { waitingReason: "error" });
    workThenStop("t4");
    for (const id of ["t1", "t2", "t3", "t4"]) expect(service.getWait(id)).toBeUndefined();
  });

  it("is seen once a look has lasted the dwell past the wait's start", () => {
    const service = makeService();
    const heard = waitChanges(service);
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 4);
    transition("t1", "working", "waiting", { waitingReason: "approval" });
    const stoppedAt = Date.now();

    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS - 1);
    expect(service.getWait("t1")?.seenAt).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(service.getWait("t1")).toEqual({ stoppedAt, seenAt: Date.now() });
    expect(heard.count).toBe(2);
    expect(changes()).toEqual([]);
  });

  it("reads nothing from a look that ends before the dwell, or one its view forgot", () => {
    const service = makeService();
    transition("t1", "idle", "waiting", { waitingReason: "question" });
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS - 100);
    service.noteLook("t1", "view-1", false);
    service.noteLook("t1", "view-2", true);
    service.forgetViewer("view-2");
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS * 4);
    expect(service.getWait("t1")?.seenAt).toBeUndefined();
  });

  it("reads a look that lasted the dwell as it ends, before its timer fires", () => {
    let now = START;
    const service = new RunHandBackService({ now: () => now });
    services.push(service);
    transition("t1", "idle", "waiting", { waitingReason: "approval", timestamp: START });
    service.noteLook("t1", "view-1", true);
    now = START + HAND_BACK_SEEN_DWELL_MS;
    service.noteLook("t1", "view-1", false);
    expect(service.getWait("t1")?.seenAt).toBe(now);
  });

  it("keeps its seen mark through the stop's slides, and through a flicker of work", () => {
    const service = makeService();
    transition("t1", "idle", "waiting", { waitingReason: "approval" });
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    service.noteLook("t1", "view-1", false);
    const seen = service.getWait("t1");
    expect(seen?.seenAt).toBeDefined();

    transition("t1", "waiting", "waiting", { waitingReason: "question" });
    transition("t1", "waiting", "completed");
    transition("t1", "completed", "waiting", { waitingReason: "prompt" });
    transition("t1", "waiting", "working");
    vi.advanceTimersByTime(HAND_BACK_MIN_WORK_MS - 1);
    transition("t1", "working", "waiting", { waitingReason: "approval" });
    expect(service.getWait("t1")).toEqual(seen);
  });

  it("ends with work watched past the flicker bar, so the next wait is unseen again", () => {
    const service = makeService();
    const heard = waitChanges(service);
    transition("t1", "idle", "waiting", { waitingReason: "approval" });
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    service.noteLook("t1", "view-1", false);
    expect(service.getWait("t1")?.seenAt).toBeDefined();

    workThenStop("t1", "waiting", "approval");
    expect(service.getWait("t1")).toEqual({ stoppedAt: Date.now() });
    expect(heard.count).toBe(3);

    // Work ending in a finish ends the wait with nothing in its place.
    workThenStop("t1");
    expect(service.getWait("t1")).toBeUndefined();
  });

  it("ends on an error, an exit or idling", () => {
    const service = makeService();
    for (const [id, state, waitingReason] of [
      ["t1", "waiting", "error"],
      ["t2", "exited", undefined],
      ["t3", "idle", undefined],
    ] as const) {
      transition(id, "idle", "waiting", { waitingReason: "question" });
      expect(service.getWait(id)).toBeDefined();
      transition(id, "waiting", state, waitingReason ? { waitingReason } : {});
      expect(service.getWait(id)).toBeUndefined();
    }
  });

  it("ends when another agent starts in the same terminal, or the terminal spawns again", () => {
    const service = makeService();
    transition("t1", "idle", "waiting", { waitingReason: "approval", agentIncarnation: 1 });
    transition("t1", "waiting", "idle", { agentIncarnation: 2 });
    expect(service.getWait("t1")).toBeUndefined();

    transition("t2", "idle", "waiting", { waitingReason: "approval" });
    expect(service.getWait("t2", START)).toBeDefined();
    expect(service.getWait("t2", Date.now() + 1)).toBeUndefined();
    expect(service.getWait("t2")).toBeUndefined();
  });

  it("begins a wait a complete inventory shows that no state was heard for", () => {
    const service = makeService();
    service.noteInventoryWait("t1", START - 60_000, START);
    expect(service.getWait("t1")).toEqual({ stoppedAt: START - 60_000 });
    // The inventory telling it again changes nothing.
    service.noteInventoryWait("t1", START - 10_000, START);
    expect(service.getWait("t1")).toEqual({ stoppedAt: START - 60_000 });

    // Looked at like any other.
    service.noteLook("t1", "view-1", true);
    vi.advanceTimersByTime(HAND_BACK_SEEN_DWELL_MS);
    expect(service.getWait("t1")?.seenAt).toBe(Date.now());
  });

  it("never lets an inventory read begun before a state overrule it", () => {
    const service = makeService();
    const readStartedAt = Date.now();
    vi.advanceTimersByTime(10);
    transition("t1", "idle", "working");
    service.noteInventoryWait("t1", readStartedAt - 1_000, readStartedAt);
    expect(service.getWait("t1")).toBeUndefined();
    // One read after it stands.
    vi.advanceTimersByTime(10);
    service.noteInventoryWait("t1", readStartedAt - 1_000, Date.now());
    expect(service.getWait("t1")).toBeDefined();
  });

  it("forgets waits a complete inventory no longer has, and leaves no timers after dispose", () => {
    const service = makeService();
    transition("t1", "idle", "waiting", { waitingReason: "approval" });
    transition("t2", "idle", "waiting", { waitingReason: "approval" });
    service.noteLook("t1", "view-1", true);
    service.noteLook("t2", "view-1", true);
    vi.advanceTimersByTime(1);
    service.retain(new Set(["t2"]), Date.now() + 1);
    expect(service.getWait("t1")).toBeUndefined();
    expect(service.getWait("t2")).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the hand-back's own seen mark alone, and is not read by marking it", () => {
    const service = makeService();
    workThenStop("t1", "waiting", "prompt");
    transition("t1", "waiting", "waiting", { waitingReason: "question" });
    expect(isHandBackUnseen(service.getRecord("t1"))).toBe(true);
    expect(service.markRead("t1")).toBe(true);
    expect(service.getWait("t1")?.seenAt).toBeUndefined();
  });

  it("begins nothing while the app is shutting down", () => {
    const service = makeService({ isQuitting: () => true });
    transition("t1", "idle", "waiting", { waitingReason: "approval" });
    service.noteInventoryWait("t1", START, START);
    expect(service.getWait("t1")).toBeUndefined();
  });
});
