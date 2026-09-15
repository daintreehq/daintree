// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRefreshTier } from "@/types";
import type { ManagedTerminal } from "../types";
import type { LiveWorkerIngestDeps } from "../workerParse/LiveWorkerIngest";
import { applySnapshotToMirror } from "../workerParse/mirrorApply";
import { TerminalWorkerIngestController } from "../TerminalWorkerIngestController";

const capturedIngestDeps = vi.hoisted(() => [] as LiveWorkerIngestDeps[]);

vi.mock("../workerParse/LiveWorkerIngest", () => ({
  LiveWorkerIngest: class {
    constructor(deps: LiveWorkerIngestDeps) {
      capturedIngestDeps.push(deps);
    }
    setDesired = vi.fn();
    handleEngaged = vi.fn();
    resize = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("../workerParse/createParseWorkerTransport", () => ({
  createParseWorkerTransport: vi.fn(),
}));
vi.mock("../paintFabric/paintFabricConfig", () => ({
  isPaintFabricWorkerIngestEnabled: () => true,
}));
vi.mock("@/clients", () => ({
  terminalClient: {
    onWorkerIngestEngaged: vi.fn(() => () => {}),
    requestWorkerIngestPort: vi.fn(),
    releaseWorkerIngestPort: vi.fn(),
    sendWorkerIngestEngage: vi.fn(),
    sendWorkerIngestRelease: vi.fn(),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
  },
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));
vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

type QueuedWrite = { data: string | Uint8Array; callback?: () => void };

/**
 * The mirror adapter is the only real `MirrorTarget`, and the only place a
 * Daintree-written ESC[3J is flagged for the viewport anchor (#12398): the
 * flag must outlive `write()` returning — that means queued, not parsed — and
 * must never be left set by a write xterm rejected.
 */
describe("TerminalWorkerIngestController mirror writes", () => {
  let writes: QueuedWrite[];
  let managed: ManagedTerminal;
  let incrementUnseen: ReturnType<typeof vi.fn<(id: string, scrolledBack: boolean) => void>>;
  let mirror: LiveWorkerIngestDeps["mirror"];

  beforeEach(() => {
    capturedIngestDeps.length = 0;
    writes = [];
    managed = {
      id: "t1",
      isUserScrolledBack: true,
      pendingOwnClearWrites: 0,
      listeners: [],
      terminal: {
        cols: 80,
        rows: 24,
        options: { scrollback: 1000 },
        write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
          writes.push({ data, callback });
        }),
        onResize: vi.fn(() => ({ dispose: vi.fn() })),
      },
      serializeAddon: { serialize: vi.fn(() => "") },
    } as unknown as ManagedTerminal;
    incrementUnseen = vi.fn<(id: string, scrolledBack: boolean) => void>();
    const controller = new TerminalWorkerIngestController({
      getInstance: (id) => (id === "t1" ? managed : undefined),
      getQueuedBytes: () => 0,
      resumeFlush: vi.fn(),
      incrementUnseen,
      fetchAndRestore: vi.fn(async () => true),
    });
    controller.applyWorkerIngestPolicy("t1", TerminalRefreshTier.BACKGROUND, managed);
    const deps = capturedIngestDeps[0];
    if (!deps) throw new Error("worker ingest was not created");
    mirror = deps.mirror;
  });

  it("flags a snapshot apply as Daintree's own clear until its parse callback", () => {
    const onApplied = vi.fn();
    applySnapshotToMirror(mirror, "first", onApplied);
    applySnapshotToMirror(mirror, "second");
    expect(managed.pendingOwnClearWrites).toBe(2);
    expect(incrementUnseen).not.toHaveBeenCalled();

    writes[0]?.callback?.();
    expect(managed.pendingOwnClearWrites).toBe(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(incrementUnseen).toHaveBeenCalledTimes(1);

    writes[1]?.callback?.();
    expect(managed.pendingOwnClearWrites).toBe(0);
    expect(incrementUnseen).toHaveBeenCalledTimes(2);
    expect(incrementUnseen).toHaveBeenLastCalledWith("t1", true);
  });

  it("live chunks never touch the flag and count once they have landed", () => {
    const onParsed = vi.fn();
    mirror.write("agent output", onParsed);
    expect(managed.pendingOwnClearWrites).toBe(0);
    expect(incrementUnseen).not.toHaveBeenCalled();

    writes[0]?.callback?.();
    expect(onParsed).toHaveBeenCalledTimes(1);
    expect(incrementUnseen).toHaveBeenCalledWith("t1", true);
    expect(managed.pendingOwnClearWrites).toBe(0);
  });

  it("a write xterm rejects releases the flag instead of stranding it", () => {
    vi.mocked(managed.terminal.write).mockImplementationOnce(() => {
      throw new Error("write buffer discard watermark");
    });

    expect(() => applySnapshotToMirror(mirror, "payload")).toThrow("discard watermark");
    expect(managed.pendingOwnClearWrites).toBe(0);

    // The next erase from the agent can still arm.
    applySnapshotToMirror(mirror, "payload");
    expect(managed.pendingOwnClearWrites).toBe(1);
    writes[0]?.callback?.();
    expect(managed.pendingOwnClearWrites).toBe(0);
  });

  it("a snapshot landing after the terminal was torn down completes its callback quietly", () => {
    applySnapshotToMirror(mirror, "payload");
    const disposedManaged = managed;
    managed = undefined as unknown as ManagedTerminal;
    expect(() => writes[0]?.callback?.()).not.toThrow();
    expect(disposedManaged.pendingOwnClearWrites).toBe(1);
    expect(incrementUnseen).not.toHaveBeenCalled();
  });
});
