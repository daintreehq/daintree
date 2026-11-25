import { describe, expect, it, vi } from "vitest";
import { ContinuationStore, type SavedLimitStop } from "../ContinuationStore.js";

const NOW = Date.UTC(2026, 10, 25, 12, 0);
const DAY = 24 * 60 * 60_000;

function file(initial: string | null = null) {
  const backend = {
    data: initial,
    writes: 0,
    read: vi.fn(async () => backend.data),
    write: vi.fn(async (next: string) => {
      backend.writes++;
      backend.data = next;
    }),
  };
  return backend;
}

const stop = (resetsAt = NOW + 60 * 60_000): SavedLimitStop => ({
  agentId: "codex",
  sessionId: "session-1",
  resetsAt,
  identity: "digest",
  savedAt: NOW,
});

async function reopen(backend: ReturnType<typeof file>) {
  const store = new ContinuationStore(backend, () => NOW);
  await store.ready();
  return store;
}

describe("ContinuationStore (#18193)", () => {
  it("reads nothing into a run with no file, and writes nothing for reading", async () => {
    const backend = file();
    const store = await reopen(backend);
    expect(store.override("p", "t1")).toBeUndefined();
    expect(store.hasBootStop("p", "t1")).toBe(false);
    await store.flush();
    expect(backend.write).not.toHaveBeenCalled();
  });

  it("brings a pane's menu choice, saved stop and continued resets back in the next run", async () => {
    const backend = file();
    const first = await reopen(backend);
    first.setOverride("p", "t1", true);
    first.saveStop("p", "t1", stop());
    first.addFired("p", "t1", NOW - DAY);
    await first.close();

    const next = await reopen(backend);
    expect(next.override("p", "t1")).toBe(true);
    expect(next.fired("p", "t1")).toEqual([NOW - DAY]);
    expect(next.takeBootStop("p", "t1")).toEqual(stop());
    // Handed out once: a restart later in the run doesn't revive it.
    expect(next.takeBootStop("p", "t1")).toBeUndefined();
  });

  it("never hands out a stop this run saved or dropped as one the previous run left", async () => {
    const backend = file();
    const first = await reopen(backend);
    first.saveStop("p", "t1", stop());
    first.saveStop("p", "t2", stop());
    await first.close();

    const next = await reopen(backend);
    next.clearStop("p", "t1");
    next.saveStop("p", "t2", stop(NOW + 5 * 60 * 60_000));
    next.saveStop("p", "t3", stop());
    expect(next.takeBootStop("p", "t1")).toBeUndefined();
    expect(next.takeBootStop("p", "t2")).toBeUndefined();
    expect(next.takeBootStop("p", "t3")).toBeUndefined();
  });

  it("keeps panes of one id in two projects apart, and forgets them by pane or by project", async () => {
    const backend = file();
    const store = await reopen(backend);
    store.setOverride("p", "t1", true);
    store.setOverride("q", "t1", false);
    store.setOverride("q", "t2", true);
    expect(store.override("q", "t1")).toBe(false);

    store.forgetProject("q");
    expect(store.override("p", "t1")).toBe(true);
    expect(store.override("q", "t2")).toBeUndefined();
    store.forgetPane("t1");
    expect(store.override("p", "t1")).toBeUndefined();
    await store.close();
    expect(JSON.parse(backend.data!)).toEqual({ version: 1, panes: [] });
  });

  it("remembers the last eight continued resets of a pane, and none from long ago", async () => {
    const backend = file();
    const store = await reopen(backend);
    for (let i = 0; i < 10; i++) store.addFired("p", "t1", NOW - i * 60_000);
    store.addFired("p", "t1", NOW);
    expect(store.fired("p", "t1")).toHaveLength(8);
    store.addFired("p", "t2", NOW - 40 * DAY);
    await store.close();

    const next = await reopen(backend);
    expect(next.fired("p", "t1")).toEqual(store.fired("p", "t1"));
    expect(next.fired("p", "t2")).toEqual([]);
  });

  it("gives a reset back when it wasn't spent after all", async () => {
    const store = await reopen(file());
    store.addFired("p", "t1", NOW);
    store.removeFired("p", "t1", NOW);
    expect(store.fired("p", "t1")).toEqual([]);
  });

  it("drops what it can't read, and reads nothing from another version", async () => {
    const malformed = JSON.stringify({
      version: 1,
      panes: [
        { projectId: "p", terminalId: "t1", stop: { agentId: "codex", resetsAt: "soon" } },
        { projectId: "p", terminalId: "t2", override: "yes", fired: ["x"] },
        { projectId: "p", terminalId: "t3", override: false, stop: stop() },
        null,
      ],
    });
    const store = await reopen(file(malformed));
    expect(store.hasBootStop("p", "t1")).toBe(false);
    expect(store.override("p", "t2")).toBeUndefined();
    expect(store.override("p", "t3")).toBe(false);
    expect(store.hasBootStop("p", "t3")).toBe(true);

    const other = await reopen(file(JSON.stringify({ version: 2, panes: [{ projectId: "p" }] })));
    expect(other.override("p", "t3")).toBeUndefined();
    const garbage = await reopen(file("{not json"));
    expect(garbage.override("p", "t3")).toBeUndefined();
  });

  it("applies a change asked for before the file was read after it, never under it", async () => {
    const saved = JSON.stringify({
      version: 1,
      panes: [{ projectId: "p", terminalId: "t1", override: true }],
    });
    const backend = file(saved);
    const store = new ContinuationStore(backend, () => NOW);
    store.setOverride("p", "t2", true);
    store.forgetPane("t1");
    await store.ready();
    await store.flush();
    expect(store.override("p", "t1")).toBeUndefined();
    expect(store.override("p", "t2")).toBe(true);
  });

  it("writes a burst of changes once, and nothing after it closes", async () => {
    const backend = file();
    const store = await reopen(backend);
    store.setOverride("p", "t1", true);
    store.saveStop("p", "t1", stop());
    store.addFired("p", "t1", NOW);
    await store.close();
    expect(backend.writes).toBe(1);
    store.setOverride("p", "t2", true);
    await store.flush();
    expect(backend.writes).toBe(1);
  });
});
