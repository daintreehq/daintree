import { describe, expect, it } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";

describe("createWorktreeStore — topologyWatcherDark (#9908)", () => {
  it("defaults to false", () => {
    const store = createWorktreeStore();
    expect(store.getState().topologyWatcherDark).toBe(false);
  });

  it("setTopologyWatcherDark toggles the flag", () => {
    const store = createWorktreeStore();
    store.getState().setTopologyWatcherDark(true);
    expect(store.getState().topologyWatcherDark).toBe(true);
    store.getState().setTopologyWatcherDark(false);
    expect(store.getState().topologyWatcherDark).toBe(false);
  });

  it("is a no-op (same state reference) when the value is unchanged", () => {
    const store = createWorktreeStore();
    const before = store.getState();
    store.getState().setTopologyWatcherDark(false);
    // Functional updater returns the previous state object when unchanged, so a
    // redundant set must not produce a new reference (no needless re-render).
    expect(store.getState()).toBe(before);
  });

  it("is independent of watcherDegraded", () => {
    const store = createWorktreeStore();
    store.getState().setTopologyWatcherDark(true);
    expect(store.getState().watcherDegraded).toBe(false);
    expect(store.getState().topologyWatcherDark).toBe(true);
  });
});
