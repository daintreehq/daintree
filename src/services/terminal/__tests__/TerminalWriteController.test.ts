// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWriteController, WriteControllerDeps } from "../TerminalWriteController";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import type { ManagedTerminal } from "../types";

vi.mock("@/utils/performance", () => ({
  markRendererPerformance: vi.fn(),
}));

vi.mock("@shared/perf/marks", () => ({
  PERF_MARKS: {
    TERMINAL_DATA_PARSED: "terminal_data_parsed",
    TERMINAL_DATA_RENDERED: "terminal_data_rendered",
    TERMINAL_FIRST_WRITE: "terminal_first_write",
  },
}));

type MockTerminal = {
  write: ReturnType<typeof vi.fn>;
  registerMarker: ReturnType<typeof vi.fn>;
};

function makeMockTerminal(): MockTerminal {
  return {
    write: vi.fn((_data: string | Uint8Array, cb?: () => void) => {
      cb?.();
    }),
    registerMarker: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    terminal: makeMockTerminal() as unknown as ManagedTerminal["terminal"],
    kind: "terminal",
    fitAddon: { fit: vi.fn() } as unknown as ManagedTerminal["fitAddon"],
    serializeAddon: { serialize: vi.fn() } as unknown as ManagedTerminal["serializeAddon"],
    imageAddon: null,
    searchAddon: {} as ManagedTerminal["searchAddon"],
    fileLinksDisposable: null,
    webLinksAddon: null,
    hoveredLink: null,
    hostElement: document.createElement("div"),
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    lastAttachAt: 0,
    lastDetachAt: 0,
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    listeners: [],
    exitSubscribers: new Set(),
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    deferredOutput: [],
    scrollbackRestoreState: "none",
    attachGeneration: 0,
    attachRevealToken: 0,
    keyHandlerInstalled: false,
    ipcListenerCount: 0,
    getRefreshTier: () => 0 as unknown as ManagedTerminal["lastAppliedTier"] as never,
    ...overrides,
  } as ManagedTerminal;
}

function makeDeps(
  store: Map<string, ManagedTerminal>,
  overrides: Partial<WriteControllerDeps> = {}
): WriteControllerDeps {
  return {
    getInstance: (id) => store.get(id),
    acknowledgePortData: vi.fn(),
    acknowledgeData: vi.fn(),
    notifyWriteComplete: vi.fn(),
    incrementUnseen: vi.fn(),
    ...overrides,
  };
}

describe("TerminalWriteController.write", () => {
  let store: Map<string, ManagedTerminal>;
  let deps: WriteControllerDeps;
  let controller: TerminalWriteController;
  let managed: ManagedTerminal;

  beforeEach(() => {
    store = new Map<string, ManagedTerminal>();
    managed = makeManaged();
    store.set("t1", managed);
    deps = makeDeps(store);
    controller = new TerminalWriteController(deps);
  });

  afterEach(() => {
    // The constructor subscribes to the view-lifecycle singleton, so an
    // undisposed controller stays reachable from it (along with its deps and
    // managed terminals) for the rest of the file.
    controller.dispose();
    __resetProjectViewCacheStateForTests();
  });

  it("no-ops when the terminal id is unknown", () => {
    controller.write("unknown", "abc");
    expect(deps.acknowledgePortData).not.toHaveBeenCalled();
    expect(deps.notifyWriteComplete).not.toHaveBeenCalled();
  });

  it("serialized-restore path: defers output without settling ANY ledger", () => {
    managed.isSerializedRestoreInProgress = true;
    controller.write("t1", "abc");
    controller.write("t1", new Uint8Array([0x61, 0x62]), 3);

    // The batch's chunkCount travels with the deferred entry so the replay
    // write can settle exactly the FIFO entries the batch owns.
    expect(managed.deferredOutput).toEqual([
      { data: "abc", chunkCount: 1 },
      { data: new Uint8Array([0x61, 0x62]), chunkCount: 3 },
    ]);
    // No ledger moves at defer time. Deferred chunks are replayed through the
    // normal path once restore finishes, and ALL bookkeeping (port-ack FIFO,
    // IPC ledger, ingest inFlightBytes) happens on the replay write's
    // completion. Acking here AND at replay double-debited the port-ack FIFO:
    // each replayed chunk stole an entry belonging to a chunk that arrived
    // after the restore, permanently inflating the host's queued-byte ledger
    // (every later pause then degrades to its 10s safety timeout). Holding the
    // charge also keeps the host's watermarks pacing the PTY while the restore
    // runs, bounding mid-restore buffering without dropping bytes.
    expect(deps.acknowledgePortData).not.toHaveBeenCalled();
    expect(deps.acknowledgeData).not.toHaveBeenCalled();
    expect(deps.notifyWriteComplete).not.toHaveBeenCalled();
    expect((managed.terminal as unknown as MockTerminal).write).not.toHaveBeenCalled();
  });

  it("replaying a deferred batch settles its own FIFO entries exactly once", () => {
    // End-to-end defer→replay: the ONLY acknowledgement for a deferred batch
    // is the one its replay write produces, with the original chunkCount.
    managed.isSerializedRestoreInProgress = true;
    controller.write("t1", new Uint8Array([1, 2, 3]), 2);
    expect(deps.acknowledgePortData).not.toHaveBeenCalled();

    managed.isSerializedRestoreInProgress = false;
    const [entry] = managed.deferredOutput;
    managed.deferredOutput = [];
    controller.write("t1", entry!.data, entry!.chunkCount);

    expect(deps.acknowledgePortData).toHaveBeenCalledTimes(1);
    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 3, 2);
    expect(deps.notifyWriteComplete).toHaveBeenCalledTimes(1);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 3);
  });

  it("normal path: writes to terminal, acks both data and port data, increments unseen", () => {
    controller.write("t1", "hello");

    expect(vi.mocked(managed.terminal.write)).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(deps.incrementUnseen).toHaveBeenCalledWith("t1", false);
    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 5, 1);
    expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 5);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 5);
  });

  describe("IPC flow-control ledger byte accounting (#9893)", () => {
    it("acks the IPC ledger in UTF-8 bytes for non-ASCII strings, not UTF-16 code units", () => {
      // U+2502 (box-drawing │) is 3 UTF-8 bytes but 1 UTF-16 code unit. The
      // host charged the ledger in UTF-8 bytes, so the ack must match (9), or
      // the queue drifts toward its high watermark (#9893).
      controller.write("t1", "│".repeat(3));

      expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 9);
      // The renderer-side ingest ledger (acknowledgePortData / notifyWriteComplete)
      // stays in UTF-16 code units to match how inFlightBytes was incremented.
      expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 3, 1);
      expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 3);
    });

    it("counts surrogate-pair emoji as 4 UTF-8 bytes for the IPC ack", () => {
      // U+1F600 (😀) is 4 UTF-8 bytes and 2 UTF-16 code units.
      controller.write("t1", "😀");

      expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 4);
      expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 2, 1);
      expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 2);
    });

    it("does not send an IPC ack for port-delivered Uint8Array chunks", () => {
      // Uint8Array chunks arrive via MessagePort, not IPC — sending an IPC ack
      // would spuriously drain the host's IPC ledger.
      controller.write("t1", new Uint8Array([0xe2, 0x94, 0x82]));

      expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 3, 1);
      expect(deps.acknowledgeData).not.toHaveBeenCalled();
      expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 3);
    });

    it("deferred-restore path: never acks the IPC ledger even for non-ASCII strings", () => {
      // The IPC ledger is drained when the deferred chunk replays through the
      // normal path after restore. Acking here would double-drain it. The
      // port-ack FIFO is equally untouched (settled by the replay write).
      managed.isSerializedRestoreInProgress = true;
      controller.write("t1", "│");

      expect(deps.acknowledgePortData).not.toHaveBeenCalled();
      expect(deps.acknowledgeData).not.toHaveBeenCalled();
    });
  });

  describe("coalesced-batch chunk accounting", () => {
    it("settles all merged port-ack FIFO entries for a coalesced write", () => {
      controller.write("t1", new Uint8Array([1, 2, 3, 4]), 3);
      expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 4, 3);
      expect(deps.acknowledgeData).not.toHaveBeenCalled();
    });

    it("deferred-restore path: preserves the chunk count on the held batch", () => {
      managed.isSerializedRestoreInProgress = true;
      controller.write("t1", new Uint8Array([1, 2]), 2);
      expect(deps.acknowledgePortData).not.toHaveBeenCalled();
      expect(managed.deferredOutput).toEqual([{ data: new Uint8Array([1, 2]), chunkCount: 2 }]);
    });
  });

  describe("lastActivityMarker refresh (rAF-coalesced)", () => {
    let rafCallbacks: FrameRequestCallback[];

    beforeEach(() => {
      rafCallbacks = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const flushFrame = () => {
      const cbs = rafCallbacks;
      rafCallbacks = [];
      for (const cb of cbs) cb(0);
    };

    it("registers a new lastActivityMarker on the next frame after a write", () => {
      const oldMarker = { dispose: vi.fn() };
      managed.lastActivityMarker = oldMarker as unknown as ManagedTerminal["lastActivityMarker"];

      controller.write("t1", "x");
      expect((managed.terminal as unknown as MockTerminal).registerMarker).not.toHaveBeenCalled();

      flushFrame();
      expect(oldMarker.dispose).toHaveBeenCalled();
      expect((managed.terminal as unknown as MockTerminal).registerMarker).toHaveBeenCalledWith(0);
    });

    it("coalesces a burst of writes into a single marker refresh per frame", () => {
      for (let i = 0; i < 25; i++) controller.write("t1", "x");
      flushFrame();

      const term = managed.terminal as unknown as MockTerminal;
      expect(term.registerMarker).toHaveBeenCalledTimes(1);
    });

    it("does not register a marker while alt-buffer is active", () => {
      managed.isAltBuffer = true;
      controller.write("t1", "x");
      flushFrame();
      expect((managed.terminal as unknown as MockTerminal).registerMarker).not.toHaveBeenCalled();
    });

    it("skips the refresh when the instance was replaced before the frame", () => {
      controller.write("t1", "x");
      const replacement = makeManaged();
      store.set("t1", replacement);
      flushFrame();

      expect((managed.terminal as unknown as MockTerminal).registerMarker).not.toHaveBeenCalled();
      expect(
        (replacement.terminal as unknown as MockTerminal).registerMarker
      ).not.toHaveBeenCalled();
    });
  });

  it("identity-guards the write callback against a replaced managed instance", () => {
    // Capture the callback synchronously, then swap the managed instance
    // before the callback runs to simulate a concurrent re-attach at the
    // same id.
    const term = managed.terminal as unknown as MockTerminal;
    let captured: (() => void) | undefined;
    term.write = vi.fn((_data: string | Uint8Array, cb?: () => void) => {
      captured = cb;
    });

    controller.write("t1", "abc");

    // Replace the instance: same id, different identity.
    store.set("t1", makeManaged());
    captured?.();

    // The acknowledgement guard short-circuits — only the pre-write
    // bookkeeping (incrementUnseen) was called, not the post-write acks.
    expect(deps.incrementUnseen).toHaveBeenCalledWith("t1", false);
    expect(deps.acknowledgeData).not.toHaveBeenCalled();
    expect(deps.notifyWriteComplete).not.toHaveBeenCalled();

    // pendingWrites was incremented synchronously in `write()` and is
    // intentionally NOT decremented on the stale-callback path. The
    // replaced instance owns its own pendingWrites counter; the old
    // managed object is being torn down, so leaving its counter at 1 is
    // harmless. This mirrors the pre-extraction behavior in TIS.
    expect(managed.pendingWrites).toBe(1);

    // The stale-identity guard returns before the lastWriteAt stamp, so the
    // torn-down instance never gets burst protection it no longer needs.
    expect(managed.lastWriteAt).toBeUndefined();
  });

  it("posts ack/notify only after terminal.write resolves, not synchronously", () => {
    // Defer the callback to prove the async contract: bookkeeping runs in
    // the callback, not at write() time.
    const term = managed.terminal as unknown as MockTerminal;
    let captured: (() => void) | undefined;
    term.write = vi.fn((_data: string | Uint8Array, cb?: () => void) => {
      captured = cb;
    });

    controller.write("t1", "abc");

    expect(managed.pendingWrites).toBe(1);
    expect(managed.lastWriteAt).toBeUndefined();
    expect(deps.acknowledgePortData).not.toHaveBeenCalled();
    expect(deps.acknowledgeData).not.toHaveBeenCalled();
    expect(deps.notifyWriteComplete).not.toHaveBeenCalled();

    captured?.();

    expect(managed.pendingWrites).toBe(0);
    expect(managed.lastWriteAt).toBeTypeOf("number");
    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 3, 1);
    expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 3);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 3);
  });

  it("samples once every 64 writes", async () => {
    const { markRendererPerformance } = await import("@/utils/performance");
    const markMock = markRendererPerformance as unknown as ReturnType<typeof vi.fn>;
    markMock.mockClear();

    for (let i = 0; i < 63; i++) controller.write("t1", "x");
    // Only the one-time first-write mark fires across the first 63 writes; the
    // 1-in-64 sampling marks have not fired yet.
    expect(markMock).toHaveBeenCalledTimes(1);
    expect(markMock).toHaveBeenCalledWith(
      "terminal_first_write",
      expect.objectContaining({ terminalId: "t1" })
    );

    controller.write("t1", "x");
    // 64th write fires three perf marks: parsed, write_duration_sample, rendered.
    expect(markMock).toHaveBeenCalledWith(
      "terminal_data_parsed",
      expect.objectContaining({ terminalId: "t1", bytes: 1 })
    );
    expect(markMock).toHaveBeenCalledWith(
      "terminal_data_rendered",
      expect.objectContaining({ terminalId: "t1", bytes: 1 })
    );
  });

  it("emits the first-write mark once per terminal with the open→first-byte delta (#9809)", async () => {
    const { markRendererPerformance } = await import("@/utils/performance");
    const markMock = markRendererPerformance as unknown as ReturnType<typeof vi.fn>;
    markMock.mockClear();

    managed.terminalOpenStartedAt = 100;
    controller.write("t1", "first");
    controller.write("t1", "second");

    const firstWriteCalls = markMock.mock.calls.filter(
      (call: unknown[]) => call[0] === "terminal_first_write"
    );
    expect(firstWriteCalls).toHaveLength(1);
    expect(firstWriteCalls[0]?.[1]).toMatchObject({ terminalId: "t1" });
    expect(firstWriteCalls[0]?.[1].elapsedSinceOpenMs).toBeTypeOf("number");
    expect(managed.hasEmittedFirstWriteMark).toBe(true);
  });

  it("decrements pendingWrites when the callback fires", () => {
    controller.write("t1", "abc");
    expect(managed.pendingWrites ?? 0).toBe(0);
  });

  describe("onWrite hook (write-driven BURST signal)", () => {
    it("fires synchronously before terminal.write() is called on the normal path", () => {
      const callOrder: string[] = [];
      const onWrite = vi.fn(() => {
        callOrder.push("onWrite");
      });
      const localDeps = makeDeps(store, { onWrite });
      const localController = new TerminalWriteController(localDeps);

      // Capture the moment terminal.write is invoked relative to onWrite.
      const term = managed.terminal as unknown as MockTerminal;
      term.write = vi.fn((_data: string | Uint8Array, _cb?: () => void) => {
        callOrder.push("terminal.write");
      });

      localController.write("t1", "abc");

      expect(onWrite).toHaveBeenCalledTimes(1);
      expect(onWrite).toHaveBeenCalledWith("t1");
      // Load-bearing: onWrite must run BEFORE terminal.write so the tier
      // is BURST at paint time, not one frame late.
      expect(callOrder).toEqual(["onWrite", "terminal.write"]);
    });

    it("does NOT fire on the deferred-restore path", () => {
      managed.isSerializedRestoreInProgress = true;
      const onWrite = vi.fn();
      const localDeps = makeDeps(store, { onWrite });
      const localController = new TerminalWriteController(localDeps);

      localController.write("t1", "abc");

      expect(onWrite).not.toHaveBeenCalled();
    });

    it("does NOT fire when the terminal id is unknown", () => {
      const onWrite = vi.fn();
      const localDeps = makeDeps(store, { onWrite });
      const localController = new TerminalWriteController(localDeps);

      localController.write("nope", "abc");

      expect(onWrite).not.toHaveBeenCalled();
    });
  });

  // A single xterm write entry parses atomically (the WriteBuffer's 12ms
  // budget only applies between entries), so large coalesced batches must be
  // fed as multiple bounded entries — while acks/bookkeeping stay batch-scoped
  // on the final entry's callback.
  describe("write slicing", () => {
    const WRITE_SLICE_BYTES = 32 * 1024;

    it("feeds a large string batch as bounded entries with one batch-scoped ack", () => {
      const data = "x".repeat(WRITE_SLICE_BYTES * 2 + 500);
      controller.write("t1", data, 7);

      const term = managed.terminal as unknown as MockTerminal;
      const calls = term.write.mock.calls;
      // Invariants: more than one entry, every entry within the slice bound,
      // reassembly is byte-identical, callback ONLY on the final entry.
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect((call[0] as string).length).toBeLessThanOrEqual(WRITE_SLICE_BYTES);
      }
      expect(calls.map((c) => c[0]).join("")).toBe(data);
      for (let i = 0; i < calls.length - 1; i++) {
        expect(calls[i]![1]).toBeUndefined();
      }
      expect(typeof calls[calls.length - 1]![1]).toBe("function");
      // Acks fire once, for the whole batch, with the original chunkCount.
      expect(deps.acknowledgePortData).toHaveBeenCalledTimes(1);
      expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", data.length, 7);
      expect(deps.notifyWriteComplete).toHaveBeenCalledTimes(1);
      expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", data.length);
    });

    it("feeds a large Uint8Array batch as zero-copy subarray entries", () => {
      const data = new Uint8Array(WRITE_SLICE_BYTES + 10).fill(0x61);
      controller.write("t1", data);

      const term = managed.terminal as unknown as MockTerminal;
      expect(term.write).toHaveBeenCalledTimes(2);
      const first = term.write.mock.calls[0]![0] as Uint8Array;
      const second = term.write.mock.calls[1]![0] as Uint8Array;
      expect(first.byteLength).toBe(WRITE_SLICE_BYTES);
      expect(second.byteLength).toBe(10);
      expect(first.buffer).toBe(data.buffer);
      expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", data.byteLength, 1);
    });

    it("does not split a surrogate pair at a slice boundary", () => {
      const data = "a".repeat(WRITE_SLICE_BYTES - 1) + "\u{1F600}" + "b".repeat(8);
      controller.write("t1", data);

      const term = managed.terminal as unknown as MockTerminal;
      const first = term.write.mock.calls[0]![0] as string;
      expect(first.length).toBe(WRITE_SLICE_BYTES - 1);
      const second = term.write.mock.calls[1]![0] as string;
      expect(second.codePointAt(0)).toBe(0x1f600);
    });

    it("does not split mid-UTF-8-sequence in a binary batch", () => {
      // 0xF0 0x9F 0x98 0x80 = 😀; place it straddling the slice boundary.
      const data = new Uint8Array(WRITE_SLICE_BYTES + 2);
      data.fill(0x61);
      data.set([0xf0, 0x9f, 0x98, 0x80], WRITE_SLICE_BYTES - 2);

      controller.write("t1", data);

      const term = managed.terminal as unknown as MockTerminal;
      const first = term.write.mock.calls[0]![0] as Uint8Array;
      // Boundary backed off so the 4-byte sequence starts the next slice.
      expect(first.byteLength).toBe(WRITE_SLICE_BYTES - 2);
      const second = term.write.mock.calls[1]![0] as Uint8Array;
      expect(second[0]).toBe(0xf0);
    });

    it("writes small batches as a single entry (fast path unchanged)", () => {
      controller.write("t1", "hello");
      const term = managed.terminal as unknown as MockTerminal;
      expect(term.write).toHaveBeenCalledTimes(1);
      expect(typeof term.write.mock.calls[0]![1]).toBe("function");
    });
  });
});

describe("TerminalWriteController — cached project view (#11212)", () => {
  let store: Map<string, ManagedTerminal>;
  let deps: WriteControllerDeps;
  let controller: TerminalWriteController;
  let managed: ManagedTerminal;
  let emitCached: () => void;
  let emitWarmActivated: () => void;
  let emitRevealed: () => void;
  let rafQueue: Map<number, FrameRequestCallback>;
  let rafSpy: ReturnType<typeof vi.fn>;
  let cancelRafSpy: ReturnType<typeof vi.fn>;

  /** Run every queued frame callback, as one real frame would. */
  function flushFrames(): void {
    const pending = [...rafQueue];
    rafQueue.clear();
    for (const [, cb] of pending) cb(0);
  }

  function markerCalls(m: ManagedTerminal): number {
    return vi.mocked(m.terminal.registerMarker).mock.calls.length;
  }

  beforeEach(() => {
    const cachedHandlers: Array<() => void> = [];
    const warmHandlers: Array<() => void> = [];
    const revealedHandlers: Array<() => void> = [];
    vi.stubGlobal("electron", {
      app: {
        onViewCached: (cb: () => void) => {
          cachedHandlers.push(cb);
          return vi.fn();
        },
        onViewWarmActivated: (cb: () => void) => {
          warmHandlers.push(cb);
          return vi.fn();
        },
        onViewRevealed: (cb: () => void) => {
          revealedHandlers.push(cb);
          return vi.fn();
        },
      },
    });
    emitCached = () => cachedHandlers.forEach((h) => h());
    emitWarmActivated = () => warmHandlers.forEach((h) => h());
    emitRevealed = () => revealedHandlers.forEach((h) => h());
    // viewCacheState arms on first use and persists for the module's life.
    // Earlier describes in this file construct controllers before the stub
    // exists, arming it against no bridge — reset so this suite's
    // subscriptions bind to the emitters above.
    __resetProjectViewCacheStateForTests();

    // Queue-backed rAF with real incrementing ids. Deliberately NOT synchronous:
    // a sync stub would run the callback before the id is assigned and defeat
    // the id-based cancel guard this suite exercises.
    rafQueue = new Map();
    let nextRafId = 1;
    rafSpy = vi.fn((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    });
    cancelRafSpy = vi.fn((id: number) => {
      rafQueue.delete(id);
    });
    vi.stubGlobal("requestAnimationFrame", rafSpy);
    vi.stubGlobal("cancelAnimationFrame", cancelRafSpy);

    store = new Map<string, ManagedTerminal>();
    managed = makeManaged();
    store.set("t1", managed);
    deps = makeDeps(store);
    controller = new TerminalWriteController(deps);
  });

  afterEach(() => {
    controller.dispose();
    __resetProjectViewCacheStateForTests();
    vi.unstubAllGlobals();
    vi.stubGlobal("electron", undefined);
  });

  it("keeps the byte stream and every ledger live while cached", () => {
    // The hard constraint from #10811/#4853: demoting a hidden view must never
    // hold bytes. Ingest stays live, so no backlog exists to detonate on reveal.
    emitCached();
    controller.write("t1", "hello");

    expect(vi.mocked(managed.terminal.write)).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 5, 1);
    expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 5);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 5);
    expect(deps.incrementUnseen).toHaveBeenCalledWith("t1", false);
  });

  it("schedules no frame and allocates no marker for writes while cached", () => {
    emitCached();
    for (let i = 0; i < 50; i++) controller.write("t1", `chunk-${i}`);

    expect(rafSpy).not.toHaveBeenCalled();
    expect(markerCalls(managed)).toBe(0);
  });

  it("still schedules a frame per write burst while active", () => {
    controller.write("t1", "a");
    expect(rafSpy).toHaveBeenCalledTimes(1);

    flushFrames();
    expect(markerCalls(managed)).toBe(1);
  });

  it("coalesces a whole cached burst into exactly one refresh on reveal", () => {
    emitCached();
    for (let i = 0; i < 25; i++) controller.write("t1", `chunk-${i}`);
    expect(markerCalls(managed)).toBe(0);

    emitWarmActivated();

    // registerMarker(0) marks the cursor as of the flush, so one settle on
    // return lands where the last hidden-frame refresh would have.
    expect(markerCalls(managed)).toBe(1);
  });

  it("flushes on warm-activated, so a superseded switch still settles", () => {
    // Main only sends revealed while the view is still the active project;
    // warm-activated is the signal that always arrives on reactivation.
    emitCached();
    controller.write("t1", "a");
    emitWarmActivated();

    expect(markerCalls(managed)).toBe(1);

    // The later revealed pass finds an empty dirty set.
    emitRevealed();
    expect(markerCalls(managed)).toBe(1);
  });

  it("refreshes each dirty terminal exactly once on reveal", () => {
    const second = makeManaged();
    store.set("t2", second);

    emitCached();
    controller.write("t1", "a");
    controller.write("t1", "b");
    controller.write("t2", "c");
    emitWarmActivated();

    expect(markerCalls(managed)).toBe(1);
    expect(markerCalls(second)).toBe(1);
  });

  it("settles a cached burst on a reveal that arrives without warm activation", () => {
    emitCached();
    controller.write("t1", "a");

    emitRevealed();

    expect(markerCalls(managed)).toBe(1);
  });

  it("does not lose or duplicate a write landing between warm activation and reveal", () => {
    emitCached();
    controller.write("t1", "a");
    emitWarmActivated();
    expect(markerCalls(managed)).toBe(1);

    // Active again: this write takes the ordinary frame-scheduled path.
    controller.write("t1", "b");
    emitRevealed();
    flushFrames();

    // The cached settle, then exactly one more for the post-activation write —
    // the reveal pass must not double-count it.
    expect(markerCalls(managed)).toBe(2);
  });

  it("does not refresh a terminal that saw no writes while cached", () => {
    emitCached();
    emitWarmActivated();

    expect(markerCalls(managed)).toBe(0);
  });

  it("cancels an in-flight frame when the view is cached mid-burst", () => {
    controller.write("t1", "a");
    expect(rafQueue.size).toBe(1);

    emitCached();

    expect(cancelRafSpy).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(0);
    expect(markerCalls(managed)).toBe(0);
  });

  it("a frame callback the loop already picked up cannot refresh once cached", () => {
    // cancelAnimationFrame can't retract a callback already dispatched, so the
    // gate has to be re-checked in the body.
    controller.write("t1", "a");
    const [, queued] = [...rafQueue][0]!;
    rafQueue.clear();

    emitCached();
    queued(0);

    expect(markerCalls(managed)).toBe(0);
  });

  it("re-arms frame scheduling after a cached window ends", () => {
    controller.write("t1", "a");
    emitCached();
    rafSpy.mockClear();

    emitWarmActivated();
    controller.write("t1", "b");

    expect(rafSpy).toHaveBeenCalledTimes(1);
    flushFrames();
    // One flush from the reveal settle, one from the post-reveal write.
    expect(markerCalls(managed)).toBe(2);
  });

  it("skips a terminal replaced at the same id while cached", () => {
    emitCached();
    controller.write("t1", "a");

    const replacement = makeManaged();
    store.set("t1", replacement);
    emitWarmActivated();

    // The stale-identity guard (#4850) still holds across the deferral.
    expect(markerCalls(managed)).toBe(0);
    expect(markerCalls(replacement)).toBe(0);
  });

  it("skips a terminal that entered the alt buffer while cached", () => {
    emitCached();
    controller.write("t1", "a");
    managed.isAltBuffer = true;
    emitWarmActivated();

    // Alt-buffer panes are excluded from markers by design; the next
    // normal-buffer write re-dirties them.
    expect(markerCalls(managed)).toBe(0);
  });

  it("forget() drops the pending obligation itself, not just via the identity guard", () => {
    // The instance deliberately STAYS in the store: removing it would let the
    // stale-identity guard produce this same result whether or not forget()
    // did anything, and the point is that the dirty set — now held for the
    // whole cached window rather than one frame — released the reference.
    emitCached();
    controller.write("t1", "a");

    controller.forget("t1");
    emitWarmActivated();

    expect(markerCalls(managed)).toBe(0);
  });

  it("forget() leaves other terminals' obligations intact", () => {
    const second = makeManaged();
    store.set("t2", second);

    emitCached();
    controller.write("t1", "a");
    controller.write("t2", "b");
    controller.forget("t1");
    emitWarmActivated();

    expect(markerCalls(managed)).toBe(0);
    expect(markerCalls(second)).toBe(1);
  });

  it("dispose() drops the pending set", () => {
    // Proven independently of unsubscription: hold a frame callback the loop
    // already picked up, dispose, then run it. If dispose only unsubscribed and
    // left the map populated, this would still register a marker.
    controller.write("t1", "a");
    const [, queued] = [...rafQueue][0]!;
    rafQueue.clear();

    controller.dispose();
    queued(0);

    expect(markerCalls(managed)).toBe(0);
  });

  it("dispose() unsubscribes from lifecycle events", () => {
    // Prove the subscription is gone, not just that the map was cleared: give a
    // disposed controller a fresh pending obligation, then fire the signal that
    // would flush it. A still-subscribed controller would register a marker.
    controller.dispose();
    emitCached();
    controller.write("t1", "a");

    emitWarmActivated();

    expect(markerCalls(managed)).toBe(0);
  });
});
