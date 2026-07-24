import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RecentDictationTarget } from "../voiceRecordingStore";

/**
 * Cross-view write-merge coverage for the shared localStorage partition
 * (issue #11351). `recentTargets` is one global MRU list (cap 3) that any view
 * appends to; the store's high-frequency transient setters trigger debounced
 * persist writes of it, so a stale view's flush must not drop a sibling's
 * just-recorded target. The merge unions by logical identity, keeps the
 * more-recently-used entry, and caps to the three most-recent.
 */
describe("voiceRecordingStore cross-view write merge (#11351)", () => {
  const STORAGE_KEY = "daintree-voice-recording";
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  type PersistedBlob = { version: number; state: { recentTargets: RecentDictationTarget[] } };

  function installLocalStorage(initial: Record<string, string>): Map<string, string> {
    const backing = new Map<string, string>(Object.entries(initial));
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => {
          backing.set(key, value);
        },
        removeItem: (key: string) => {
          backing.delete(key);
        },
      },
      configurable: true,
      writable: true,
    });
    return backing;
  }

  function restoreLocalStorage(): void {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "localStorage", originalDescriptor);
      return;
    }
    delete (globalThis as Partial<typeof globalThis>).localStorage;
  }

  function readTargets(backing: Map<string, string>): RecentDictationTarget[] {
    const blob: PersistedBlob = JSON.parse(backing.get(STORAGE_KEY)!);
    return blob.state.recentTargets;
  }

  function writeDisk(backing: Map<string, string>, targets: RecentDictationTarget[]): void {
    backing.set(STORAGE_KEY, JSON.stringify({ version: 0, state: { recentTargets: targets } }));
  }

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreLocalStorage();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("a fresh view's recorded target preserves a sibling's recent target", async () => {
    const backing = installLocalStorage({});
    const { useVoiceRecordingStore: store } = await import("../voiceRecordingStore");
    vi.advanceTimersByTime(400); // drain any hydration-triggered write

    vi.setSystemTime(5000);
    writeDisk(backing, [{ panelTitle: "Sib", worktreeId: "wt-sib", lastUsedAt: 1000 }]);

    store
      .getState()
      .recordRecentTarget({ panelId: "p1", panelTitle: "Mine", worktreeId: "wt-mine" });
    vi.advanceTimersByTime(400);

    const written = readTargets(backing);
    const titles = written.map((t) => t.panelTitle).sort();
    expect(titles).toEqual(["Mine", "Sib"]);
  });

  it("merges the writer's and sibling's targets in MRU order without dropping the sibling", async () => {
    const backing = installLocalStorage({});
    const { useVoiceRecordingStore: store } = await import("../voiceRecordingStore");
    vi.advanceTimersByTime(400);

    // This view records an OLDER target; a sibling has a NEWER one on disk.
    vi.setSystemTime(2000);
    writeDisk(backing, [{ panelTitle: "Sib", worktreeId: "wt-sib", lastUsedAt: 8000 }]);

    store
      .getState()
      .recordRecentTarget({ panelId: "p1", panelTitle: "Mine", worktreeId: "wt-mine" });
    vi.advanceTimersByTime(400);

    const written = readTargets(backing);
    expect(written.map((t) => t.panelTitle)).toEqual(["Sib", "Mine"]); // newest first
  });

  it("a stale view's transient flush preserves a sibling's recorded target", async () => {
    const backing = installLocalStorage({});
    const { useVoiceRecordingStore: store } = await import("../voiceRecordingStore");
    vi.advanceTimersByTime(400);

    // This view records its own target and lets it settle into a durable baseline.
    vi.setSystemTime(3000);
    store
      .getState()
      .recordRecentTarget({ panelId: "p1", panelTitle: "Mine", worktreeId: "wt-mine" });
    vi.advanceTimersByTime(400);

    // A sibling records a newer target directly to disk.
    writeDisk(backing, [
      ...readTargets(backing),
      { panelTitle: "Sib", worktreeId: "wt-sib", lastUsedAt: 9000 },
    ]);

    // A transient, non-persisted change (audio level) triggers a debounced flush
    // of this stale view's unchanged recentTargets.
    store.getState().setAudioLevel(0.5);
    vi.advanceTimersByTime(400);

    const titles = readTargets(backing)
      .map((t) => t.panelTitle)
      .sort();
    expect(titles).toEqual(["Mine", "Sib"]); // sibling target not clobbered
  });

  it("dedupes a same-identity target to the newer entry and keeps other sibling targets", async () => {
    const backing = installLocalStorage({});
    const { useVoiceRecordingStore: store } = await import("../voiceRecordingStore");
    vi.advanceTimersByTime(400);

    vi.setSystemTime(5000);
    writeDisk(backing, [
      { panelTitle: "Shared", worktreeId: "wt-1", lastUsedAt: 1000 },
      { panelTitle: "Other", worktreeId: "wt-2", lastUsedAt: 2000 },
    ]);

    // Re-record the same logical target (wt-1 / "Shared") — newer than the disk copy.
    store
      .getState()
      .recordRecentTarget({ panelId: "p1", panelTitle: "Shared", worktreeId: "wt-1" });
    vi.advanceTimersByTime(400);

    const written = readTargets(backing);
    const shared = written.find((t) => t.worktreeId === "wt-1");
    const other = written.find((t) => t.worktreeId === "wt-2");
    expect(shared?.lastUsedAt).toBe(5000); // newer entry won the collision
    expect(other).toBeDefined(); // the other sibling target survived
    expect(written).toHaveLength(2);
  });
});
