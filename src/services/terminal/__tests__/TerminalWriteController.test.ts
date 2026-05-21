// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalWriteController, WriteControllerDeps } from "../TerminalWriteController";
import type { ManagedTerminal } from "../types";

vi.mock("@/utils/performance", () => ({
  markRendererPerformance: vi.fn(),
}));

vi.mock("@shared/perf/marks", () => ({
  PERF_MARKS: {
    TERMINAL_DATA_PARSED: "terminal_data_parsed",
    TERMINAL_DATA_RENDERED: "terminal_data_rendered",
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
    isHibernated: false,
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

  it("no-ops when the terminal id is unknown", () => {
    controller.write("unknown", "abc");
    expect(deps.acknowledgePortData).not.toHaveBeenCalled();
    expect(deps.notifyWriteComplete).not.toHaveBeenCalled();
  });

  it("hibernated path: ack + notify but does not touch the xterm instance", () => {
    managed.isHibernated = true;
    controller.write("t1", "hello");

    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 5);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 5);
    expect((managed.terminal as unknown as MockTerminal).write).not.toHaveBeenCalled();
  });

  it("serialized-restore path: defers output and acks port data", () => {
    managed.isSerializedRestoreInProgress = true;
    controller.write("t1", "abc");
    controller.write("t1", new Uint8Array([0x61, 0x62]));

    expect(managed.deferredOutput).toEqual(["abc", new Uint8Array([0x61, 0x62])]);
    expect(deps.acknowledgePortData).toHaveBeenNthCalledWith(1, "t1", 3);
    expect(deps.acknowledgePortData).toHaveBeenNthCalledWith(2, "t1", 2);
    expect((managed.terminal as unknown as MockTerminal).write).not.toHaveBeenCalled();
  });

  it("normal path: writes to terminal, acks both data and port data, increments unseen", () => {
    controller.write("t1", "hello");

    const term = managed.terminal as unknown as MockTerminal;
    expect(term.write).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(deps.incrementUnseen).toHaveBeenCalledWith("t1", false);
    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 5);
    expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 5);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 5);
  });

  it("registers a new lastActivityMarker on each write in the normal buffer", () => {
    const oldMarker = { dispose: vi.fn() };
    managed.lastActivityMarker = oldMarker as unknown as ManagedTerminal["lastActivityMarker"];

    controller.write("t1", "x");

    expect(oldMarker.dispose).toHaveBeenCalled();
    expect((managed.terminal as unknown as MockTerminal).registerMarker).toHaveBeenCalledWith(0);
  });

  it("does not register a marker while alt-buffer is active", () => {
    managed.isAltBuffer = true;
    controller.write("t1", "x");
    expect((managed.terminal as unknown as MockTerminal).registerMarker).not.toHaveBeenCalled();
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
    expect(deps.acknowledgePortData).toHaveBeenCalledWith("t1", 3);
    expect(deps.acknowledgeData).toHaveBeenCalledWith("t1", 3);
    expect(deps.notifyWriteComplete).toHaveBeenCalledWith("t1", 3);
  });

  it("samples once every 64 writes", async () => {
    const { markRendererPerformance } = await import("@/utils/performance");
    const markMock = markRendererPerformance as unknown as ReturnType<typeof vi.fn>;
    markMock.mockClear();

    for (let i = 0; i < 63; i++) controller.write("t1", "x");
    expect(markMock).not.toHaveBeenCalled();

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

    it("does NOT fire on the hibernated path (ack-only)", () => {
      managed.isHibernated = true;
      const onWrite = vi.fn();
      const localDeps = makeDeps(store, { onWrite });
      const localController = new TerminalWriteController(localDeps);

      localController.write("t1", "hello");

      expect(onWrite).not.toHaveBeenCalled();
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
});
