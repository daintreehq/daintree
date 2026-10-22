import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../../../../shared/types/pty-host.js";
import type { TerminalLifecycleObservation } from "../../../../shared/utils/pluginTerminalLifecycle.js";
import { events } from "../../events.js";
import {
  TerminalLifecycleObserver,
  startTerminalLifecycleObserver,
  type TerminalLaunchAttribution,
  type TerminalLifecycleSource,
} from "../TerminalLifecycleObserver.js";

function harness(maxRetainedExited?: number) {
  const live = new Map<string, TerminalLaunchAttribution>();
  const emitted: TerminalLifecycleObservation[] = [];
  let clock = 1000;
  const observer = new TerminalLifecycleObserver({
    getAttribution: (id) => live.get(id) ?? null,
    emit: (observation) => emitted.push(observation),
    now: () => clock++,
    maxRetainedExited,
  });
  return { live, emitted, observer };
}

const ok = (id: string, launchGeneration?: number): SpawnResult => ({
  success: true,
  id,
  launchGeneration,
});

describe("TerminalLifecycleObserver", () => {
  it("reports a terminal's life with the metadata it launched with", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", {
      projectId: "p1",
      worktreeId: "wt-1",
      kind: "terminal",
      launchAgentId: "claude",
      launchGeneration: 1,
    });
    observer.handleSpawnResult("t1", ok("t1", 1));
    // A natural exit drops the client's record before the event reaches us.
    live.delete("t1");
    observer.handleExit("t1", 2, 15);

    expect(emitted).toEqual([
      {
        type: "spawned",
        terminalId: "t1",
        projectId: "p1",
        worktreeId: "wt-1",
        kind: "agent",
        agentId: "claude",
        timestamp: 1000,
      },
      {
        type: "exited",
        terminalId: "t1",
        projectId: "p1",
        worktreeId: "wt-1",
        kind: "agent",
        agentId: "claude",
        exitCode: 2,
        signal: 15,
        timestamp: 1001,
      },
    ]);
  });

  it("classifies plugin panels ahead of agents, and everything else as a shell", () => {
    const { live, emitted, observer } = harness();
    live.set("plugin", {
      projectId: "p1",
      kind: "terminal",
      pluginPanelKindId: "acme.build",
      launchAgentId: "claude",
    });
    live.set("dev", { projectId: "p1", kind: "dev-preview" });
    live.set("shell", { projectId: "p1", kind: "terminal" });
    for (const id of ["plugin", "dev", "shell"]) observer.handleSpawnResult(id, ok(id));
    expect(emitted.map((e) => [e.terminalId, e.kind, e.agentId])).toEqual([
      ["plugin", "plugin", undefined],
      ["dev", "shell", undefined],
      ["shell", "shell", undefined],
    ]);
  });

  it("ignores failed spawns, unknown terminals and the assistant's own PTY", () => {
    const { live, emitted, observer } = harness();
    live.set("assistant", { projectId: "p1", launchAgentId: "claude", isAssistantTerminal: true });
    live.set("failed", { projectId: "p1" });
    observer.handleSpawnResult("failed", { success: false, id: "failed" });
    observer.handleSpawnResult("gone", ok("gone"));
    observer.handleSpawnResult("assistant", ok("assistant"));
    observer.handleExit("assistant", 0);
    observer.handleExit("never-spawned", 0);
    observer.handleTrashed("never-spawned");
    expect(emitted).toEqual([]);
  });

  it("reports a deferred-start replay of the same launch once", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1", launchGeneration: 4 });
    observer.handleSpawnResult("t1", ok("t1", 4));
    observer.handleSpawnResult("t1", ok("t1", 4));
    expect(emitted.map((e) => e.type)).toEqual(["spawned"]);
  });

  it("drops a stale spawn result from a killed predecessor under the same id", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1", launchGeneration: 5 });
    observer.handleSpawnResult("t1", ok("t1", 4));
    expect(emitted).toEqual([]);
    observer.handleSpawnResult("t1", ok("t1", 5));
    expect(emitted.map((e) => e.type)).toEqual(["spawned"]);
  });

  it("reports a restart as a fresh spawn, with the old exit when it lands first", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1", launchGeneration: 1 });
    observer.handleSpawnResult("t1", ok("t1", 1));
    // kill(): the client forgets the record before the exit arrives.
    live.delete("t1");
    observer.handleExit("t1", 0);
    live.set("t1", { projectId: "p1", launchGeneration: 2 });
    observer.handleSpawnResult("t1", ok("t1", 2));
    expect(emitted.map((e) => e.type)).toEqual(["spawned", "exited", "spawned"]);
  });

  it("reports a host-crash respawn as another spawn with no exit between", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1", launchGeneration: 1 });
    observer.handleSpawnResult("t1", ok("t1", 1));
    live.set("t1", { projectId: "p1", launchGeneration: 2 });
    observer.handleSpawnResult("t1", ok("t1", 2));
    expect(emitted.map((e) => e.type)).toEqual(["spawned", "spawned"]);
  });

  it("reports one exit per launch", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1" });
    observer.handleSpawnResult("t1", ok("t1"));
    observer.handleExit("t1", 0);
    observer.handleExit("t1", 0);
    expect(emitted.map((e) => e.type)).toEqual(["spawned", "exited"]);
  });

  it("still attributes trash and restore after the terminal exited", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1", worktreeId: "wt-1" });
    observer.handleSpawnResult("t1", ok("t1"));
    live.delete("t1");
    observer.handleExit("t1", 1);
    observer.handleTrashed("t1");
    observer.handleRestored("t1");
    expect(emitted.map((e) => [e.type, e.projectId, e.worktreeId])).toEqual([
      ["spawned", "p1", "wt-1"],
      ["exited", "p1", "wt-1"],
      ["trashed", "p1", "wt-1"],
      ["restored", "p1", "wt-1"],
    ]);
  });

  it("follows a worktree move into later events, the exit included", () => {
    const { live, emitted, observer } = harness();
    live.set("t1", { projectId: "p1", worktreeId: "wt-1", launchGeneration: 1 });
    observer.handleSpawnResult("t1", ok("t1", 1));
    live.set("t1", { projectId: "p1", launchGeneration: 1 });
    observer.handleWorktreeChanged("t1");
    live.set("t1", { projectId: "p1", worktreeId: "wt-2", launchGeneration: 1 });
    observer.handleRateLimitObserved("t1", 77);
    live.delete("t1");
    observer.handleExit("t1", 0);
    expect(emitted.map((e) => [e.type, e.worktreeId])).toEqual([
      ["spawned", "wt-1"],
      ["rate-limit-observed", "wt-2"],
      ["exited", "wt-2"],
    ]);
    expect(emitted[1]).toMatchObject({ observedAt: 77 });
    const moved = harness();
    moved.live.set("t2", { projectId: "p1", worktreeId: "wt-1" });
    moved.observer.handleSpawnResult("t2", ok("t2"));
    moved.live.set("t2", { projectId: "p1" });
    moved.observer.handleWorktreeChanged("t2");
    moved.live.delete("t2");
    moved.observer.handleExit("t2", 0);
    expect("worktreeId" in moved.emitted[1]).toBe(false);
  });

  it("forgets the oldest exited terminals past the cap, never a live one", () => {
    const { live, emitted, observer } = harness(2);
    for (const id of ["live", "a", "b", "c"]) {
      live.set(id, { projectId: "p1" });
      observer.handleSpawnResult(id, ok(id));
    }
    for (const id of ["a", "b", "c"]) observer.handleExit(id, 0);
    emitted.length = 0;
    for (const id of ["live", "a", "b", "c"]) observer.handleTrashed(id);
    expect(emitted.map((e) => e.terminalId)).toEqual(["live", "b", "c"]);
  });

  it("keeps the client's other listeners running when a subscriber throws", () => {
    const observer = new TerminalLifecycleObserver({
      getAttribution: () => ({ projectId: "p1" }),
      emit: () => {
        throw new Error("subscriber blew up");
      },
    });
    expect(() => observer.handleSpawnResult("t1", ok("t1"))).not.toThrow();
  });
});

describe("startTerminalLifecycleObserver", () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  function fakeClient(attribution: Record<string, TerminalLaunchAttribution>) {
    const emitter = new EventEmitter();
    const source = Object.assign(emitter, {
      getTerminalLaunchAttribution: (id: string) => attribution[id] ?? null,
    }) as unknown as TerminalLifecycleSource & EventEmitter;
    return source;
  }

  it("publishes the client's stream and the bus events on terminal:lifecycle", () => {
    const client = fakeClient({ t1: { projectId: "p1", kind: "terminal" } });
    const seen: TerminalLifecycleObservation[] = [];
    const unsub = events.on("terminal:lifecycle", (o) => seen.push(o));
    stop = startTerminalLifecycleObserver(client);

    client.emit("spawn-result", "t1", ok("t1"));
    events.emit("agent:rate-limit-observed", { terminalId: "t1", observedAt: 9, timestamp: 9 });
    events.emit("terminal:trashed", { id: "t1", expiresAt: 0 });
    events.emit("terminal:restored", { id: "t1" });
    client.emit("exit", "t1", 130, undefined, true);
    unsub();

    expect(seen.map((o) => o.type)).toEqual([
      "spawned",
      "rate-limit-observed",
      "trashed",
      "restored",
      "exited",
    ]);
    expect(seen[4]).toMatchObject({ exitCode: 130, projectId: "p1" });
  });

  it("detaches every listener when stopped", () => {
    const client = fakeClient({ t1: { projectId: "p1" } });
    const listener = vi.fn();
    const unsub = events.on("terminal:lifecycle", listener);
    startTerminalLifecycleObserver(client)();

    client.emit("spawn-result", "t1", ok("t1"));
    events.emit("terminal:trashed", { id: "t1", expiresAt: 0 });
    unsub();

    expect(listener).not.toHaveBeenCalled();
    expect(client.listenerCount("spawn-result")).toBe(0);
    expect(client.listenerCount("exit")).toBe(0);
  });
});
