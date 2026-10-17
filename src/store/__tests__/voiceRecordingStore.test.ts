import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  isVoiceMicPending,
  useVoiceRecordingStore,
  type RecentDictationTarget,
} from "../voiceRecordingStore";

const PANEL_ID = "panel-1";
const TARGET = { panelId: PANEL_ID };

function reset() {
  useVoiceRecordingStore.setState({
    isConfigured: false,
    correctionEnabled: false,
    status: "idle",
    lastError: null,
    activeTarget: null,
    lockedTarget: null,
    recentTargets: [],
    elapsedSeconds: 0,
    audioLevel: 0,
    micSignal: "pending",
    panelBuffers: {},
    announcement: null,
  });
}

describe("voiceRecordingStore — setArming", () => {
  beforeEach(reset);

  it("atomically sets status='arming' and activeTarget in a single update", () => {
    let intermediateStatus: string | null = null;
    let intermediateTarget: typeof TARGET | null | undefined = undefined;
    const unsub = useVoiceRecordingStore.subscribe((state) => {
      // The first subscriber notification reads the new state. If status and
      // activeTarget were written separately, one snapshot would observe
      // status=arming with activeTarget=null (or vice versa).
      if (intermediateStatus === null) {
        intermediateStatus = state.status;
        intermediateTarget = state.activeTarget;
      }
    });
    try {
      useVoiceRecordingStore.getState().setArming(TARGET);
    } finally {
      unsub();
    }

    expect(intermediateStatus).toBe("arming");
    expect(intermediateTarget).toEqual(TARGET);
    const final = useVoiceRecordingStore.getState();
    expect(final.status).toBe("arming");
    expect(final.activeTarget).toEqual(TARGET);
  });

  it("clears any prior error so a fresh arming flow doesn't show stale text", () => {
    useVoiceRecordingStore.setState({
      lastError: { severity: "fatal", code: "server_error", message: "Previous failure" },
    });
    useVoiceRecordingStore.getState().setArming(TARGET);
    expect(useVoiceRecordingStore.getState().lastError).toBeNull();
  });

  it("transitions cleanly to connecting when beginSession runs after arming", () => {
    useVoiceRecordingStore.getState().setArming(TARGET);
    useVoiceRecordingStore.getState().beginSession(TARGET);
    const state = useVoiceRecordingStore.getState();
    expect(state.status).toBe("connecting");
    expect(state.activeTarget).toEqual(TARGET);
  });
});

describe("voiceRecordingStore — micSignal (#13105)", () => {
  beforeEach(reset);

  it("resets to pending at every session boundary", () => {
    for (const enter of [
      () => useVoiceRecordingStore.getState().setArming(TARGET),
      () => useVoiceRecordingStore.getState().beginSession(TARGET),
      () => useVoiceRecordingStore.getState().finishSession(),
    ]) {
      useVoiceRecordingStore.getState().setMicSignal("live");
      enter();
      expect(useVoiceRecordingStore.getState().micSignal).toBe("pending");
    }
  });

  it("stays latched across backend status changes such as a reconnect", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().setMicSignal("live");
    useVoiceRecordingStore.getState().setStatus("reconnecting");
    useVoiceRecordingStore.getState().setStatus("recording");
    expect(useVoiceRecordingStore.getState().micSignal).toBe("live");
  });

  it("isVoiceMicPending covers an open session whose mic isn't live, whatever the backend says", () => {
    for (const status of ["connecting", "recording", "reconnecting"] as const) {
      expect(isVoiceMicPending({ status, micSignal: "pending" })).toBe(true);
      expect(isVoiceMicPending({ status, micSignal: "silent" })).toBe(true);
      expect(isVoiceMicPending({ status, micSignal: "live" })).toBe(false);
    }
    for (const status of ["idle", "arming", "paused", "finishing", "error"] as const) {
      expect(isVoiceMicPending({ status, micSignal: "pending" })).toBe(false);
    }
  });
});

describe("voiceRecordingStore — clearPanelBuffer", () => {
  beforeEach(reset);

  it("removes the buffer entry for the given panelId", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("test");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]).toBeDefined();

    useVoiceRecordingStore.getState().clearPanelBuffer(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]).toBeUndefined();
  });

  it("is a no-op for panelIds that have no buffer", () => {
    const before = useVoiceRecordingStore.getState().panelBuffers;
    useVoiceRecordingStore.getState().clearPanelBuffer("nonexistent");
    expect(useVoiceRecordingStore.getState().panelBuffers).toBe(before);
  });
});

describe("voiceRecordingStore — transcript phase transitions", () => {
  beforeEach(reset);

  it("completeSegment with empty text transitions to idle", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta(" ");
    useVoiceRecordingStore.getState().completeSegment("");
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("resetParagraphState resets liveText to empty string", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("interim text");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("interim text");

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);

    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.liveText).toBe("");
  });

  it("after resetParagraphState, setDraftLengthAtSegmentStart can set a new anchor", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 20);
    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    useVoiceRecordingStore.getState().setDraftLengthAtSegmentStart(PANEL_ID, 21);

    expect(
      useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.draftLengthAtSegmentStart
    ).toBe(21);
  });

  it("finishSession resets transcriptPhase to idle regardless of prior phase", () => {
    useVoiceRecordingStore.getState().beginSession(TARGET);
    useVoiceRecordingStore.getState().appendDelta("unfinished");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "interim"
    );
    useVoiceRecordingStore.getState().finishSession();
    const buffer = useVoiceRecordingStore.getState().panelBuffers[PANEL_ID];
    expect(buffer?.transcriptPhase).toBe("idle");
  });

  it("full lifecycle: idle → interim → utterance_final → idle (after reset)", () => {
    const store = useVoiceRecordingStore.getState();

    store.beginSession(TARGET);
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe("idle");

    useVoiceRecordingStore.getState().appendDelta("hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "interim"
    );

    useVoiceRecordingStore.getState().completeSegment("hello world");
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe(
      "utterance_final"
    );

    useVoiceRecordingStore.getState().resetParagraphState(PANEL_ID);
    expect(useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.transcriptPhase).toBe("idle");
  });
});

describe("voiceRecordingStore — lockedTarget", () => {
  beforeEach(reset);

  it("clearLockedTarget(matchingId) clears the lock", () => {
    useVoiceRecordingStore.getState().lockTarget({ panelId: PANEL_ID });
    useVoiceRecordingStore.getState().clearLockedTarget(PANEL_ID);
    expect(useVoiceRecordingStore.getState().lockedTarget).toBeNull();
  });

  it("clearLockedTarget(nonMatchingId) is a no-op when lock points elsewhere", () => {
    useVoiceRecordingStore.getState().lockTarget({ panelId: PANEL_ID });
    const before = useVoiceRecordingStore.getState().lockedTarget;
    useVoiceRecordingStore.getState().clearLockedTarget("other-panel");
    expect(useVoiceRecordingStore.getState().lockedTarget).toBe(before);
  });
});

describe("voiceRecordingStore — recentTargets", () => {
  beforeEach(reset);

  it("recordRecentTarget deduplicates by panelId, hoisting the existing entry to the front", () => {
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "a", panelTitle: "A" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "b", panelTitle: "B" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "a", panelTitle: "A renamed" });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents.map((t) => t.panelId)).toEqual(["a", "b"]);
    expect(recents[0]?.panelTitle).toBe("A renamed");
  });

  it("recordRecentTarget caps the list at 3 entries (MRU)", () => {
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "a" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "b" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "c" });
    useVoiceRecordingStore.getState().recordRecentTarget({ panelId: "d" });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents.map((t) => t.panelId)).toEqual(["d", "c", "b"]);
  });

  it("recordRecentTarget dedups a live entry against a rehydrated (no panelId) entry with same worktree+title", () => {
    useVoiceRecordingStore.setState({
      recentTargets: [{ panelTitle: "Editor", worktreeId: "wt-1", lastUsedAt: 1 }],
    });
    useVoiceRecordingStore.getState().recordRecentTarget({
      panelId: "p1",
      panelTitle: "Editor",
      worktreeId: "wt-1",
    });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents).toHaveLength(1);
    expect(recents[0]?.panelId).toBe("p1");
  });

  it("recordRecentTarget keeps rehydrated entry with different worktreeId", () => {
    useVoiceRecordingStore.setState({
      recentTargets: [{ panelTitle: "Editor", worktreeId: "wt-other", lastUsedAt: 1 }],
    });
    useVoiceRecordingStore.getState().recordRecentTarget({
      panelId: "p1",
      panelTitle: "Editor",
      worktreeId: "wt-1",
    });
    const recents = useVoiceRecordingStore.getState().recentTargets;
    expect(recents).toHaveLength(2);
  });
});

describe("voiceRecordingStore — identified items (#13109)", () => {
  beforeEach(() => {
    reset();
    useVoiceRecordingStore.getState().beginSession(TARGET);
  });

  const buffer = () => useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]!;

  it("keeps a later item's interim text when an earlier item completes", () => {
    const store = useVoiceRecordingStore.getState();
    store.appendDelta("hello", "item-a");
    store.appendDelta("next", "item-b");
    store.appendDelta(" there", "item-a");
    store.appendDelta(" words", "item-b");
    expect(buffer().liveText).toBe("hello there next words");

    store.completeSegment("Hello there.", "item-a");
    expect(buffer().liveText).toBe("next words");
    expect(buffer().transcriptPhase).toBe("interim");
    expect(buffer().completedSegments).toEqual(["Hello there."]);

    store.completeSegment("Next words.", "item-b");
    expect(buffer().liveText).toBe("");
    expect(buffer().liveItems).toEqual([]);
    expect(buffer().transcriptPhase).toBe("utterance_final");
    expect(buffer().completedSegments).toEqual(["Hello there.", "Next words."]);
  });

  it("renders a single item's deltas verbatim", () => {
    const store = useVoiceRecordingStore.getState();
    store.appendDelta(" hel", "item-a");
    store.appendDelta("lo ", "item-a");
    expect(buffer().liveText).toBe(" hello ");
  });

  it("treats an identified empty completion as authoritative", () => {
    const store = useVoiceRecordingStore.getState();
    store.appendDelta("um", "item-a");
    store.completeSegment("", "item-a");
    expect(buffer().liveText).toBe("");
    expect(buffer().completedSegments).toEqual([]);
    expect(buffer().transcriptPhase).toBe("idle");
  });

  it("consumes a legacy segment anchor so a later flush can't slice at it", () => {
    const store = useVoiceRecordingStore.getState();
    store.setDraftLengthAtSegmentStart(PANEL_ID, 5);
    store.appendDelta("hello", "item-a");
    store.completeSegment("Hello.", "item-a");
    expect(buffer().draftLengthAtSegmentStart).toBe(-1);
  });

  it("an unidentified completion clears identified item state", () => {
    const store = useVoiceRecordingStore.getState();
    store.appendDelta("stale", "item-a");
    store.completeSegment("Stale.");
    expect(buffer().liveItems).toEqual([]);
    store.appendDelta("fresh", "item-b");
    expect(buffer().liveText).toBe("fresh");
  });

  it("paragraph reset preserves other items' interim text", () => {
    const store = useVoiceRecordingStore.getState();
    store.appendDelta("first", "item-a");
    store.appendDelta("second", "item-b");
    store.completeSegment("First.", "item-a");
    store.resetParagraphState(PANEL_ID);
    expect(buffer().liveText).toBe("second");
    expect(buffer().transcriptPhase).toBe("interim");
  });

  it("finishSession clears item state and can preserve the joined preview", () => {
    const store = useVoiceRecordingStore.getState();
    store.appendDelta("first", "item-a");
    store.appendDelta("second", "item-b");
    store.finishSession({ preserveLiveText: true });
    expect(buffer().liveItems).toEqual([]);
    expect(buffer().liveText).toBe("");
    expect(buffer().completedSegments).toEqual(["first second"]);
  });

  it("beginSession clears items left from a previous session", () => {
    useVoiceRecordingStore.getState().appendDelta("stale", "item-a");
    useVoiceRecordingStore.getState().beginSession(TARGET);
    expect(buffer().liveItems).toEqual([]);
    expect(buffer().liveText).toBe("");
  });
});

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

  it("drops the superseded entry when the same panel is re-recorded under a new title", async () => {
    const backing = installLocalStorage({});
    const { useVoiceRecordingStore: store } = await import("../voiceRecordingStore");
    vi.advanceTimersByTime(400);

    // A genuinely distinct target the user should keep seeing after restart.
    vi.setSystemTime(1000);
    store
      .getState()
      .recordRecentTarget({ panelId: "p0", panelTitle: "Alpha", worktreeId: "wt-alpha" });
    vi.advanceTimersByTime(400);

    // The same panel is dictated into three times while its title changes (agent
    // task-title composition retitles panels mid-session). In memory each
    // re-record supersedes the previous one (dedup is by panelId), so disk must
    // follow — persisted identity is (worktreeId, panelTitle), which shifts.
    for (const [at, title] of [
      [2000, "Fix the parser"],
      [3000, "Fix the parser bug"],
      [4000, "Ship the parser fix"],
    ] as const) {
      vi.setSystemTime(at);
      store.getState().recordRecentTarget({ panelId: "p1", panelTitle: title, worktreeId: "wt-1" });
      vi.advanceTimersByTime(400);
    }

    expect(store.getState().recentTargets.map((t) => t.panelTitle)).toEqual([
      "Ship the parser fix",
      "Alpha",
    ]);
    // Disk mirrors memory: one entry per panel, and the older distinct target was
    // not evicted by stale duplicates of the retitled one.
    expect(readTargets(backing).map((t) => t.panelTitle)).toEqual(["Ship the parser fix", "Alpha"]);
  });
});
