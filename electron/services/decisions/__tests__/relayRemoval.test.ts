import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  KEPT_RELAY_REMOVALS,
  RELAY_REMOVAL_LAUNCH_WINDOW_MS,
  RelayRemovals,
  type RelayRemovalFactSource,
  type RemovedRelayRecord,
} from "../relayRemoval.js";
import type { DecisionsRelayRemovalLocal } from "../../../../shared/types/decisions.js";

const ID = "daintree-decisions-remove-00000000-0000-4000-8000-000000000001";
const ORIGIN = "https://relay.example.workers.dev";
const RECORD: RemovedRelayRecord = {
  relayOrigin: ORIGIN,
  installationId: "inst_1",
  deviceId: "dev_1",
};

function setup(forgetResult: Promise<DecisionsRelayRemovalLocal> = Promise.resolve("forgotten")) {
  const source = Object.assign(new EventEmitter(), {
    getTerminalProjectId: vi.fn((): string | null => "project-a"),
  });
  const forget = vi.fn(() => forgetResult);
  const onChanged = vi.fn();
  // The removal launches the spawn handler sent, by id, as relayRemovalLaunches keeps them.
  const launches = new Set<string>();
  let shuttingDown = false;
  const removals = new RelayRemovals({
    source: source as unknown as RelayRemovalFactSource,
    takeLaunch: (id) => launches.delete(id),
    forget,
    isShuttingDown: () => shuttingDown,
    onChanged,
  });
  return {
    source,
    forget,
    onChanged,
    removals,
    launches,
    quit: () => {
      shuttingDown = true;
    },
    /** The spawn handler sending the removal under `id`. */
    launched: (id = ID) => launches.add(id),
    /** A spawn answer for the removal's own launch, unless `launch` is false. */
    spawned: (spawnedAt = 1_000, id = ID, launch = true) => {
      if (launch) launches.add(id);
      source.emit("spawn-result", id, { success: true, id, spawnedAt });
    },
    exited: (fact: Record<string, unknown>, id = ID) =>
      source.emit("incarnation-exit", { terminalId: id, signal: null, ...fact }),
    outcome: (id = ID) => removals.list().find((entry) => entry.terminalId === id)?.outcome,
  };
}

describe("RelayRemovals", () => {
  it("forgets the recorded relay when the removal's terminal exits 0 by itself", async () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });

    expect(t.outcome()).toEqual({ state: "exited", exitCode: 0, local: "pending" });
    expect(t.forget).toHaveBeenCalledExactlyOnceWith(RECORD, false);
    await vi.waitFor(() =>
      expect(t.outcome()).toEqual({ state: "exited", exitCode: 0, local: "forgotten" })
    );
    // Started, ended, forgotten: every change is pushed.
    expect(t.onChanged).toHaveBeenCalledTimes(3);
  });

  it("asks for the history to go too only when that was chosen", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, true);
    t.launched();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.forget).toHaveBeenCalledExactlyOnceWith(RECORD, true);
  });

  it("keeps the record on a non-zero exit, whatever the CLI printed", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, true);
    t.spawned();
    t.exited({ spawnedAt: 1_000, exitCode: 1 });

    expect(t.outcome()).toEqual({ state: "exited", exitCode: 1, local: "kept" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it.each([
    ["a kill or restart Daintree made", { stopped: true }],
    ["a signal", { signal: 1 }],
  ])("reads an exit 0 after %s as interrupted, never finished", (_label, extra) => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned();
    t.exited({ spawnedAt: 1_000, exitCode: 0, ...extra });

    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("forgets nothing for an exit while quitting", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned();
    t.quit();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("ends with a restart: a second incarnation can't finish the removal", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned(1_000);
    t.spawned(2_000, ID, false);
    expect(t.outcome()).toEqual({ state: "interrupted" });

    // The restarted pane is a plain shell; its own exit 0 changes nothing.
    t.exited({ spawnedAt: 2_000, exitCode: 0 });
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("stops trusting its incarnation once another spawn under the id is refused", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned(1_000);
    t.source.emit("spawn-result", ID, { success: false, id: ID });
    expect(t.outcome()).toEqual({ state: "interrupted" });

    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("ignores another incarnation's exit and settles on its own", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned(1_000);
    t.exited({ spawnedAt: 2_000, exitCode: 0 });
    expect(t.outcome()).toEqual({ state: "running" });
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.forget).toHaveBeenCalledOnce();
  });

  it("takes an exit that comes before its spawn answer as the launch's", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.launched();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    t.spawned(1_000);
    expect(t.forget).toHaveBeenCalledOnce();
  });

  it("can't confirm an exit no incarnation is named for", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.launched();
    t.exited({ exitCode: 0 });
    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("settles once: a repeated exit forgets nothing more", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.forget).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "a refused spawn",
      (t: ReturnType<typeof setup>) =>
        t.source.emit("spawn-result", ID, { success: false, id: ID }),
    ],
    ["a lost terminal", (t: ReturnType<typeof setup>) => t.source.emit("terminal-lost", ID)],
    [
      "a lost incarnation",
      (t: ReturnType<typeof setup>) =>
        t.source.emit("incarnation-lost", { terminalId: ID, launchGeneration: 1 }),
    ],
  ])("reads %s as interrupted", (_label, emit) => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    emit(t);
    expect(t.outcome()).toEqual({ state: "interrupted" });
  });

  it("forgets nothing for a relay that wasn't recorded here, and drops the history choice", () => {
    const t = setup();
    const view = t.removals.start(ID, ORIGIN, null, true);
    expect(view).toMatchObject({ recorded: false, deleteLocalHistory: false });
    t.spawned();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.outcome()).toEqual({ state: "exited", exitCode: 0, local: "none" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("reports a forget that threw as failed", async () => {
    const t = setup(Promise.reject(new Error("keychain")));
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned();
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    await vi.waitFor(() =>
      expect(t.outcome()).toEqual({ state: "exited", exitCode: 0, local: "failed" })
    );
  });

  it("never takes a spawn the removal wasn't launched in, a restart's plain shell included", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    // The removal's own spawn was refused before it reached the pty-host; a
    // restart then opens a plain shell under the id, which the person exits.
    t.spawned(2_000, ID, false);
    t.exited({ spawnedAt: 2_000, exitCode: 0 });

    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("never takes an exit no launch came before", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("reads its project closing, sleeping or restarting as interrupted, and no other's", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.spawned();

    t.source.emit("project-kill-requested", "project-b");
    expect(t.outcome()).toEqual({ state: "running" });
    t.source.emit("project-kill-requested", "project-a");
    expect(t.outcome()).toEqual({ state: "interrupted" });

    // The kill's exit, whatever its status, changes nothing.
    t.exited({ spawnedAt: 1_000, exitCode: 0 });
    expect(t.forget).not.toHaveBeenCalled();
  });

  it("lets go of a launch it was told of once it has settled", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    t.launched();
    t.source.emit("terminal-lost", ID);
    expect(t.outcome()).toEqual({ state: "interrupted" });
    expect(t.launches.has(ID)).toBe(false);
  });

  it("stops waiting for a terminal that never started, and a late one changes nothing", () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.removals.start(ID, ORIGIN, RECORD, false);
      vi.advanceTimersByTime(RELAY_REMOVAL_LAUNCH_WINDOW_MS - 1);
      expect(t.outcome()).toEqual({ state: "running" });

      vi.advanceTimersByTime(1);
      expect(t.outcome()).toEqual({ state: "interrupted" });

      t.spawned();
      t.exited({ spawnedAt: 1_000, exitCode: 0 });
      expect(t.forget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting once its terminal has started", () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.removals.start(ID, ORIGIN, RECORD, false);
      t.spawned();
      vi.advanceTimersByTime(RELAY_REMOVAL_LAUNCH_WINDOW_MS * 2);
      expect(t.outcome()).toEqual({ state: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a terminal id it already watches", () => {
    const t = setup();
    t.removals.start(ID, ORIGIN, RECORD, false);
    expect(() => t.removals.start(ID, ORIGIN, RECORD, false)).toThrow(/already watched/);
  });

  it("keeps a bounded list of ended removals, never dropping a running one", () => {
    const t = setup();
    const ids = Array.from(
      { length: KEPT_RELAY_REMOVALS + 3 },
      (_, index) => `daintree-decisions-remove-${String(index).padStart(36, "0")}`
    );
    t.removals.start(ids[0]!, ORIGIN, null, false);
    for (const id of ids.slice(1)) {
      t.removals.start(id, ORIGIN, null, false);
      t.spawned(1_000, id);
      t.exited({ spawnedAt: 1_000, exitCode: 1 }, id);
    }
    const listed = t.removals.list().map((entry) => entry.terminalId);
    expect(listed).toHaveLength(KEPT_RELAY_REMOVALS);
    expect(listed[0]).toBe(ids[0]);
    expect(listed.at(-1)).toBe(ids.at(-1));
  });

  it("subscribes on the first removal and lets go of every fact on dispose", () => {
    const t = setup();
    expect(t.source.listenerCount("incarnation-exit")).toBe(0);
    t.removals.start(ID, ORIGIN, RECORD, false);
    const facts = [
      "spawn-result",
      "incarnation-exit",
      "incarnation-lost",
      "terminal-lost",
      "project-kill-requested",
    ];
    for (const event of facts) expect(t.source.listenerCount(event)).toBe(1);
    t.removals.dispose();
    for (const event of facts) expect(t.source.listenerCount(event)).toBe(0);
    expect(() => t.removals.start(`${ID.slice(0, -1)}2`, ORIGIN, null, false)).toThrow();
  });
});
