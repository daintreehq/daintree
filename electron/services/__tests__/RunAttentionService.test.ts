import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  MAX_PARK_NOTE_LENGTH,
  MAX_PARKED_RUNS,
  MAX_SNOOZED_RUNS,
  RunAttentionService,
} from "../RunAttentionService.js";
import type { RunParkRecord, RunSnoozeRecord } from "../../../shared/types/ipc/fleet.js";

const NOW = 1_900_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makePersistence(initial: Record<string, RunParkRecord> = {}) {
  return {
    load: vi.fn(() => initial),
    save: vi.fn<(records: Record<string, RunParkRecord>) => void>(),
  };
}

function makeService(
  persistence = makePersistence(),
  deps: { now?: () => number; isQuitting?: () => boolean } = {}
) {
  return new RunAttentionService(persistence, { now: () => NOW, ...deps });
}

function emittedOf(event: string) {
  return eventEmitter.emitted.filter((e) => e.event === event).map((e) => e.payload);
}

/** A gate edge that postdates every park created at NOW, unless overridden. */
function gateBecomesReady(
  gateId: string,
  state = "waiting",
  previousState = "working",
  timestamp = NOW + 1_000
) {
  eventEmitter.emit("agent:state-changed", {
    terminalId: gateId,
    state,
    previousState,
    timestamp,
  });
}

beforeEach(() => {
  eventEmitter._reset();
});

describe("RunAttentionService", () => {
  it("parks a run, persists it and announces the change", () => {
    const persistence = makePersistence();
    const service = makeService(persistence);

    const record = service.park("t1", { note: "start after the refactor lands" });

    expect(record).toEqual({ parkedAt: NOW, note: "start after the refactor lands" });
    expect(service.getParkRecord("t1")).toEqual(record);
    expect(persistence.save).toHaveBeenCalledWith({ t1: record });
    expect(emittedOf("terminal:park-changed")).toEqual([
      { id: "t1", parked: true, timestamp: NOW },
    ]);
    service.dispose();
  });

  it("trims the note, caps its length, and drops a blank one entirely", () => {
    const service = makeService();

    expect(service.park("a", { note: "  padded  " }).note).toBe("padded");
    expect(service.park("b", { note: "x".repeat(MAX_PARK_NOTE_LENGTH + 50) }).note).toHaveLength(
      MAX_PARK_NOTE_LENGTH
    );
    expect(service.park("c", { note: "   " }).note).toBeUndefined();
    service.dispose();
  });

  it("never caps a note in the middle of a surrogate pair", () => {
    const service = makeService();
    // 249 chars then emoji: the astral pair straddles the 500-unit boundary,
    // so a naive slice would keep a lone high surrogate as the last unit.
    const note = "x".repeat(MAX_PARK_NOTE_LENGTH - 1) + "🚀";
    const stored = service.park("a", { note }).note!;
    expect(stored).toHaveLength(MAX_PARK_NOTE_LENGTH - 1);
    const lastCode = stored.charCodeAt(stored.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    service.dispose();
  });

  it("rejects a park with no run id and a run gating on itself", () => {
    const service = makeService();

    expect(() => service.park("")).toThrow();
    expect(() => service.park("t1", { gateRunId: "t1" })).toThrow();
    expect(service.getParkRecord("t1")).toBeUndefined();
    service.dispose();
  });

  it("bounds the park set, while re-parking never counts against the cap", () => {
    const service = makeService();
    for (let i = 0; i < MAX_PARKED_RUNS; i++) service.park(`run-${i}`);

    expect(() => service.park("one-too-many")).toThrow();
    // An existing park may still be replaced at the cap — it is not growth.
    expect(() => service.park("run-0", { note: "updated" })).not.toThrow();
    expect(service.getParkRecord("run-0")?.note).toBe("updated");
    service.dispose();
  });

  it("re-parking replaces the record wholesale, restarting the clock", () => {
    let now = NOW;
    const service = new RunAttentionService(makePersistence(), { now: () => now });

    service.park("t1", { note: "first", gateRunId: "g1" });
    now = NOW + 60_000;
    const second = service.park("t1", { note: "second" });

    expect(second).toEqual({ parkedAt: NOW + 60_000, note: "second" });
    expect(service.getParkRecord("t1")?.gateRunId).toBeUndefined();
    // The old gate no longer owns this park: its edge must not release it.
    gateBecomesReady("g1", "waiting", "working", now + 1_000);
    expect(service.getParkRecord("t1")).toBeDefined();
    service.dispose();
  });

  it("unparks by hand and reports whether anything was lifted", () => {
    const persistence = makePersistence();
    const service = makeService(persistence);
    service.park("t1");

    expect(service.unpark("t1")).toBe(true);
    expect(service.getParkRecord("t1")).toBeUndefined();
    expect(persistence.save).toHaveBeenLastCalledWith({});
    expect(service.unpark("t1")).toBe(false);
    expect(emittedOf("terminal:park-changed")).toEqual([
      { id: "t1", parked: true, timestamp: NOW },
      { id: "t1", parked: false, timestamp: NOW },
    ]);
    service.dispose();
  });

  it("rolls a park back when persistence fails, and reports the failure", () => {
    const persistence = makePersistence();
    persistence.save.mockImplementation(() => {
      throw new Error("disk full");
    });
    const service = makeService(persistence);

    expect(() => service.park("t1", { note: "will not survive" })).toThrow("disk full");
    // A park that would not survive a restart must not exist now either, and
    // no surface may be told about it.
    expect(service.getParkRecord("t1")).toBeUndefined();
    expect(emittedOf("terminal:park-changed")).toEqual([]);
    service.dispose();
  });

  it("restores the record when an unpark fails to persist", () => {
    const persistence = makePersistence();
    const service = makeService(persistence);
    service.park("t1", { note: "keep me" });
    persistence.save.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => service.unpark("t1")).toThrow("disk full");
    expect(service.getParkRecord("t1")?.note).toBe("keep me");
    service.dispose();
  });

  it("releases a gated park when the gate transitions busy → ready", () => {
    const persistence = makePersistence();
    const service = makeService(persistence);
    service.park("t1", { note: "kick off once the migration agent is done", gateRunId: "gate" });

    gateBecomesReady("gate");

    expect(service.getParkRecord("t1")).toBeUndefined();
    expect(persistence.save).toHaveBeenLastCalledWith({});
    expect(emittedOf("terminal:park-released")).toEqual([
      {
        id: "t1",
        gateRunId: "gate",
        note: "kick off once the migration agent is done",
        reason: "gate-ready",
        timestamp: NOW,
      },
    ]);
    // The snapshot refresh path rides park-changed, so the release must also
    // announce the park going away.
    expect(emittedOf("terminal:park-changed")).toEqual([
      { id: "t1", parked: true, timestamp: NOW },
      { id: "t1", parked: false, timestamp: NOW },
    ]);
    service.dispose();
  });

  it("requires the busy → ready EDGE: ready → ready and idle → busy release nothing", () => {
    const service = makeService();
    service.park("t1", { gateRunId: "gate" });

    // The gate flapping between ready states (waiting → idle) is not it
    // finishing a stint of work, and the gate STARTING work must never fire.
    gateBecomesReady("gate", "idle", "waiting");
    gateBecomesReady("gate", "working", "idle");
    expect(service.getParkRecord("t1")).toBeDefined();

    // A different terminal reaching ready is someone else's news.
    gateBecomesReady("other");
    expect(service.getParkRecord("t1")).toBeDefined();
    service.dispose();
  });

  it("ignores an edge that predates the park — stale events cannot release it", () => {
    const service = makeService();
    service.park("t1", { gateRunId: "gate" });

    // An edge generated before the park but delivered after (pty-host → main
    // is async), and the ambiguous same-millisecond edge, both hold.
    gateBecomesReady("gate", "waiting", "working", NOW - 5);
    gateBecomesReady("gate", "waiting", "working", NOW);
    expect(service.getParkRecord("t1")).toBeDefined();

    // A malformed timestamp is not evidence the edge is new.
    gateBecomesReady("gate", "waiting", "working", Number.NaN);
    expect(service.getParkRecord("t1")).toBeDefined();

    gateBecomesReady("gate", "waiting", "working", NOW + 1);
    expect(service.getParkRecord("t1")).toBeUndefined();
    service.dispose();
  });

  it("releases on every ready-family state, from either busy state", () => {
    const service = makeService();
    for (const state of ["idle", "waiting", "completed", "exited"]) {
      service.park(`run-${state}`, { gateRunId: `gate-${state}` });
      gateBecomesReady(`gate-${state}`, state);
      expect(service.getParkRecord(`run-${state}`)).toBeUndefined();
    }
    service.park("t-directing", { gateRunId: "gate-d" });
    gateBecomesReady("gate-d", "waiting", "directing");
    expect(service.getParkRecord("t-directing")).toBeUndefined();
    service.dispose();
  });

  it("releases as gate-closed when the gate terminal is trashed", () => {
    const service = makeService();
    service.park("t1", { gateRunId: "gate" });

    eventEmitter.emit("terminal:trashed", { id: "gate", expiresAt: NOW + 1000 });

    expect(service.getParkRecord("t1")).toBeUndefined();
    expect(emittedOf("terminal:park-released")).toEqual([
      { id: "t1", gateRunId: "gate", reason: "gate-closed", timestamp: NOW },
    ]);
    service.dispose();
  });

  it("keeps the park when the parked run ITSELF is trashed — trash is restorable", () => {
    const service = makeService();
    service.park("t1", { note: "keep me" });

    eventEmitter.emit("terminal:trashed", { id: "t1", expiresAt: NOW + 1000 });

    expect(service.getParkRecord("t1")?.note).toBe("keep me");
    service.dispose();
  });

  it("releases every run sharing the gate in one pass", () => {
    const persistence = makePersistence();
    const service = makeService(persistence);
    service.park("t1", { gateRunId: "gate" });
    service.park("t2", { gateRunId: "gate" });
    service.park("t3", { gateRunId: "elsewhere" });

    gateBecomesReady("gate");

    expect(service.getParkRecord("t1")).toBeUndefined();
    expect(service.getParkRecord("t2")).toBeUndefined();
    expect(service.getParkRecord("t3")).toBeDefined();
    expect(persistence.save).toHaveBeenLastCalledWith({
      t3: { parkedAt: NOW, gateRunId: "elsewhere" },
    });
    service.dispose();
  });

  it("keeps every park when a gate release cannot be persisted", () => {
    const persistence = makePersistence();
    const service = makeService(persistence);
    service.park("t1", { gateRunId: "gate" });
    persistence.save.mockImplementation(() => {
      throw new Error("disk full");
    });

    gateBecomesReady("gate");

    // Announcing a release that resurrects after restart is worse than
    // releasing late, so the park stays and nothing is emitted.
    expect(service.getParkRecord("t1")).toBeDefined();
    expect(emittedOf("terminal:park-released")).toEqual([]);
    service.dispose();
  });

  it("does not re-visit a park created by a release listener on the same gate", () => {
    const service = makeService();
    service.park("t1", { gateRunId: "gate" });
    eventEmitter.on("terminal:park-released", () => {
      // A listener that immediately re-parks on the same gate must need a NEW
      // edge — the pass that released t1 already snapshotted its batch.
      if (service.getParkRecord("t2") === undefined) {
        service.park("t2", { gateRunId: "gate" });
      }
    });

    gateBecomesReady("gate");

    expect(service.getParkRecord("t1")).toBeUndefined();
    expect(service.getParkRecord("t2")).toBeDefined();
    service.dispose();
  });

  it("freezes entirely while the app is shutting down", () => {
    let quitting = false;
    const persistence = makePersistence();
    const service = makeService(persistence, { isQuitting: () => quitting });
    service.park("t1", { gateRunId: "gate" });
    quitting = true;

    // The shutdown chain kills every terminal, which lands as busy→ready
    // edges and trashes — none of it may touch the parks being carried
    // across the restart, and no new intent can be recorded mid-teardown.
    gateBecomesReady("gate");
    eventEmitter.emit("terminal:trashed", { id: "gate", expiresAt: NOW + 1000 });
    expect(service.getParkRecord("t1")).toBeDefined();
    expect(() => service.park("t2")).toThrow();
    expect(() => service.unpark("t1")).toThrow();
    expect(service.getParkRecord("t1")).toBeDefined();
    service.dispose();
  });

  it("hydrates from persistence, pruning stale and malformed records", () => {
    const fresh: RunParkRecord = { parkedAt: NOW - DAY_MS, note: "fresh" };
    const persistence = makePersistence({
      fresh,
      stale: { parkedAt: NOW - 20 * DAY_MS },
      malformed: { parkedAt: Number.NaN },
      fromTheFuture: { parkedAt: NOW + DAY_MS },
      broken: undefined as unknown as RunParkRecord,
    });
    const service = makeService(persistence);

    expect(service.getParkRecord("fresh")).toEqual(fresh);
    expect(service.getParkRecord("stale")).toBeUndefined();
    expect(service.getParkRecord("malformed")).toBeUndefined();
    expect(service.getParkRecord("fromTheFuture")).toBeUndefined();
    // Pruning rewrote the store so the dead records don't reload forever.
    expect(persistence.save).toHaveBeenCalledWith({ fresh });
    service.dispose();
  });

  it("rebuilds loaded records field-by-field, dropping what fails validation", () => {
    const persistence = makePersistence({
      t1: {
        parkedAt: NOW - DAY_MS,
        note: 42,
        gateRunId: "t1",
        smuggled: "extra",
      } as unknown as RunParkRecord,
      t2: { parkedAt: NOW - DAY_MS, note: "  ok  ", gateRunId: "" } as RunParkRecord,
    });
    const service = makeService(persistence);

    // Non-string note dropped, self-gate dropped, unknown fields not copied.
    expect(service.getParkRecord("t1")).toEqual({ parkedAt: NOW - DAY_MS });
    // Note re-normalized on the way in; empty gate treated as no gate.
    expect(service.getParkRecord("t2")).toEqual({ parkedAt: NOW - DAY_MS, note: "ok" });
    service.dispose();
  });

  it("releases a park hydrated from disk when its gate comes free", () => {
    const service = makeService(
      makePersistence({ t1: { parkedAt: NOW - DAY_MS, gateRunId: "gate" } })
    );

    gateBecomesReady("gate");

    expect(service.getParkRecord("t1")).toBeUndefined();
    service.dispose();
  });

  it("starts empty when persistence itself fails", () => {
    const persistence = {
      load: vi.fn(() => {
        throw new Error("corrupt store");
      }),
      save: vi.fn(),
    };
    const service = new RunAttentionService(persistence, { now: () => NOW });
    expect([...service.getAll()]).toEqual([]);
    service.dispose();
  });

  it("stops listening after dispose", () => {
    const service = makeService();
    service.park("t1", { gateRunId: "gate" });
    const before = service.getParkRecord("t1");
    service.dispose();

    gateBecomesReady("gate");

    // Dispose cleared the map; the point is no release event fired afterwards.
    expect(before).toBeDefined();
    expect(emittedOf("terminal:park-released")).toEqual([]);
  });
});

describe("snooze", () => {
  function makeSnoozePersistence(
    parks: Record<string, RunParkRecord> = {},
    snoozes: Record<string, RunSnoozeRecord> = {}
  ) {
    return {
      load: vi.fn(() => parks),
      save: vi.fn<(records: Record<string, RunParkRecord>) => void>(),
      loadSnoozes: vi.fn(() => snoozes),
      saveSnoozes: vi.fn<(records: Record<string, RunSnoozeRecord>) => void>(),
    };
  }

  function typedInput(terminalId: string, state = "working", previousState = "waiting") {
    eventEmitter.emit("agent:state-changed", {
      terminalId,
      state,
      previousState,
      trigger: "input",
      timestamp: NOW + 1_000,
    });
  }

  /**
   * What the pty-host emits when input lands on a run that is ALREADY working:
   * the FSM produces no transition, so the change event never fires and only
   * the dropped-transition event carries the signal.
   */
  function typedInputWhileWorking(terminalId: string) {
    eventEmitter.emit("agent:state-transition-dropped", {
      terminalId,
      outcome: "no-op",
      currentState: "working",
      attemptedState: "working",
      trigger: "input",
      timestamp: NOW + 1_000,
    });
  }

  it("resolves a timed option to a wake time in the future", () => {
    const service = makeService(makeSnoozePersistence());
    const record = service.snooze("run-1", "15m");

    expect(record.snoozedAt).toBe(NOW);
    expect(record.snoozedUntil).toBeGreaterThan(NOW);
    expect(service.isSnoozed("run-1", NOW)).toBe(true);
  });

  it("gives the unlimited option no wake time, so no clock can end it", () => {
    const service = makeService(makeSnoozePersistence());
    const record = service.snooze("run-1", "unlimited");

    expect(record.snoozedUntil).toBeUndefined();
    // Far beyond any ladder entry: still snoozed, because only input ends it.
    expect(service.isSnoozed("run-1", NOW + 400 * DAY_MS)).toBe(true);
  });

  it("stops reporting a timed snooze once its wake time passes", () => {
    const service = makeService(makeSnoozePersistence());
    const record = service.snooze("run-1", "15m");

    expect(service.isSnoozed("run-1", record.snoozedUntil! - 1)).toBe(true);
    expect(service.isSnoozed("run-1", record.snoozedUntil!)).toBe(false);
    expect(service.getActiveSnoozes(record.snoozedUntil!).has("run-1")).toBe(false);
  });

  it("expires without emitting anything — expiry is resolved at read, not announced", () => {
    const service = makeService(makeSnoozePersistence());
    const record = service.snooze("run-1", "15m");
    const before = emittedOf("terminal:snooze-changed").length;

    service.getActiveSnoozes(record.snoozedUntil! + 1);

    expect(emittedOf("terminal:snooze-changed").length).toBe(before);
  });

  it("clears the snooze when the user types at a waiting run", () => {
    const service = makeService(makeSnoozePersistence());
    service.snooze("run-1", "6h");

    typedInput("run-1");

    expect(service.isSnoozed("run-1", NOW)).toBe(false);
  });

  it("clears the snooze when the user types at a run that is already working", () => {
    // The gap the dropped-transition subscription exists to close: no state
    // change means no `agent:state-changed`, so this is the only signal.
    const service = makeService(makeSnoozePersistence());
    service.snooze("run-1", "6h");

    typedInputWhileWorking("run-1");

    expect(service.isSnoozed("run-1", NOW)).toBe(false);
  });

  it("clears an unlimited snooze on input, like every other duration", () => {
    const service = makeService(makeSnoozePersistence());
    service.snooze("run-1", "unlimited");

    typedInput("run-1");

    expect(service.isSnoozed("run-1", NOW)).toBe(false);
  });

  it("does NOT clear the snooze on a non-input transition", () => {
    // Output, heuristics and activity all move agent state without the user
    // being present. Only deliberate typing ends a snooze.
    const service = makeService(makeSnoozePersistence());
    service.snooze("run-1", "6h");

    for (const trigger of ["output", "heuristic", "activity", "timeout", "title"]) {
      eventEmitter.emit("agent:state-changed", {
        terminalId: "run-1",
        state: "waiting",
        previousState: "working",
        trigger,
        timestamp: NOW + 1_000,
      });
    }

    expect(service.isSnoozed("run-1", NOW)).toBe(true);
  });

  it("only clears the run that was typed at", () => {
    const service = makeService(makeSnoozePersistence());
    service.snooze("run-1", "6h");
    service.snooze("run-2", "6h");

    typedInput("run-1");

    expect(service.isSnoozed("run-1", NOW)).toBe(false);
    expect(service.isSnoozed("run-2", NOW)).toBe(true);
  });

  it("persists a snooze so it survives a restart", () => {
    const persistence = makeSnoozePersistence();
    const service = makeService(persistence);
    service.snooze("run-1", "6h");

    const saved = persistence.saveSnoozes.mock.calls.at(-1)![0];
    const revived = makeService(makeSnoozePersistence({}, saved));

    expect(revived.isSnoozed("run-1", NOW)).toBe(true);
  });

  it("drops an already-lapsed snooze at load rather than carrying it forward", () => {
    const stale: Record<string, RunSnoozeRecord> = {
      "run-1": { snoozedAt: NOW - 60_000, snoozedUntil: NOW - 1 },
    };
    const service = makeService(makeSnoozePersistence({}, stale));

    expect(service.getSnoozeRecord("run-1")).toBeUndefined();
  });

  it("drops a snooze older than the stale TTL even when it never expires", () => {
    // An unlimited snooze on a run that never came back would otherwise be held
    // forever, honouring a decision the user no longer remembers making.
    const ancient: Record<string, RunSnoozeRecord> = {
      "run-1": { snoozedAt: NOW - 20 * DAY_MS },
    };
    const service = makeService(makeSnoozePersistence({}, ancient));

    expect(service.getSnoozeRecord("run-1")).toBeUndefined();
  });

  it("rejects a malformed stored record rather than repairing it", () => {
    const corrupt = {
      "run-1": { snoozedAt: "soon" },
      "run-2": { snoozedAt: NOW + 10 * 60_000 },
      "run-3": null,
    } as unknown as Record<string, RunSnoozeRecord>;
    const service = makeService(makeSnoozePersistence({}, corrupt));

    // run-2's timestamp is far enough in the future to be corrupt, not early.
    expect(service.getSnoozeRecord("run-1")).toBeUndefined();
    expect(service.getSnoozeRecord("run-2")).toBeUndefined();
    expect(service.getSnoozeRecord("run-3")).toBeUndefined();
  });

  it("rolls back and reports when the snooze cannot be persisted", () => {
    const persistence = makeSnoozePersistence();
    persistence.saveSnoozes.mockImplementation(() => {
      throw new Error("disk full");
    });
    const service = makeService(persistence);

    expect(() => service.snooze("run-1", "6h")).toThrow("disk full");
    // A snooze that would not survive a restart must not exist now either.
    expect(service.isSnoozed("run-1", NOW)).toBe(false);
    expect(emittedOf("terminal:snooze-changed")).toEqual([]);
  });

  it("keeps the snooze when an input-driven clear cannot be persisted", () => {
    const persistence = makeSnoozePersistence();
    const service = makeService(persistence);
    service.snooze("run-1", "6h");
    persistence.saveSnoozes.mockImplementation(() => {
      throw new Error("disk full");
    });

    // Driven by an event, so it must not throw at the listener.
    expect(() => typedInput("run-1")).not.toThrow();
    expect(service.isSnoozed("run-1", NOW)).toBe(true);
  });

  it("re-snoozing replaces the record wholesale", () => {
    const service = makeService(makeSnoozePersistence());
    const first = service.snooze("run-1", "15m");
    const second = service.snooze("run-1", "6h");

    expect(second.snoozedUntil).toBeGreaterThan(first.snoozedUntil!);
  });

  it("unsnooze reports whether there was anything to lift", () => {
    const service = makeService(makeSnoozePersistence());
    expect(service.unsnooze("run-1")).toBe(false);

    service.snooze("run-1", "6h");
    expect(service.unsnooze("run-1")).toBe(true);
    expect(service.isSnoozed("run-1", NOW)).toBe(false);
  });

  it("rejects a duration outside the ladder", () => {
    const service = makeService(makeSnoozePersistence());
    expect(() => service.snooze("run-1", "1h" as never)).toThrow(/Invalid snooze duration/);
  });

  it("refuses to mutate snoozes while the app is shutting down", () => {
    const service = makeService(makeSnoozePersistence(), { isQuitting: () => true });
    expect(() => service.snooze("run-1", "6h")).toThrow(/shutting down/);
    expect(() => service.unsnooze("run-1")).toThrow(/shutting down/);
  });

  it("leaves a park untouched when the run is snoozed, and vice versa", () => {
    // Independent intents: snoozing must not destroy the note a park carries.
    const service = makeService(makeSnoozePersistence());
    service.park("run-1", { note: "waiting on review" });
    service.snooze("run-1", "6h");

    expect(service.getParkRecord("run-1")?.note).toBe("waiting on review");
    expect(service.isSnoozed("run-1", NOW)).toBe(true);

    service.unsnooze("run-1");
    expect(service.getParkRecord("run-1")).toBeDefined();
  });

  it("bounds the snooze set, but never counts lapsed records against the cap", () => {
    let clock = NOW;
    const service = makeService(makeSnoozePersistence(), { now: () => clock });
    for (let i = 0; i < MAX_SNOOZED_RUNS; i++) service.snooze(`run-${i}`, "15m");

    expect(() => service.snooze("overflow", "15m")).toThrow(/more than/);

    // Once the first batch lapses, the slots come back.
    clock = NOW + 60 * 60_000;
    expect(() => service.snooze("overflow", "15m")).not.toThrow();
  });

  it("clears its snoozes on dispose", () => {
    const service = makeService(makeSnoozePersistence());
    service.snooze("run-1", "6h");
    service.dispose();

    expect(service.isSnoozed("run-1", NOW)).toBe(false);
  });
});
