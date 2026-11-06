import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => loggerMock,
}));

import { Lane } from "../../link/frames.js";
import { InteractiveKind } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import type { TerminalOutMessage, TerminalResetMessage } from "../../link/messages.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import {
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_PAUSE_MS,
  IPC_MAX_QUEUE_BYTES,
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
} from "../../../services/pty/types.js";
import { ClientTerminalRelay } from "../ClientTerminalRelay.js";
import { RingBudget } from "../ring.js";
import { TERMINAL_RESUME_METHOD, TerminalResumeResultSchema } from "../protocol.js";
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_MAX_OUTSTANDING_BYTES,
  DEFAULT_MAX_TOTAL_OUTSTANDING_BYTES,
  TerminalStreamBridge,
  type TerminalStreamBridgeOptions,
} from "../TerminalStreamBridge.js";
import type { SerializedTerminalSnapshot } from "../../../../shared/types/terminal.js";
import { fakeSession } from "./fakeSession.js";
import { FakePeer, FakePtyHost, decode } from "./streamTestUtils.js";

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  loggerMock.info.mockClear();
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await removeTempDir(dir);
});

const ENDPOINT = "ep-1";

interface Harness {
  bridge: TerminalStreamBridge;
  relay: ClientTerminalRelay;
  pty: () => FakePtyHost;
  renderer: () => FakePeer;
  incarnations: Map<string, number>;
  snapshots: Map<string, string>;
  /** Owning project per terminal as the host's spawn records say; unset means project-a. */
  owners: Map<string, string | null>;
  /** While blocked the pty-host refuses the bridge's connection, as while it restarts. */
  blockPty(blocked: boolean): void;
  host: LinkSession;
  client: LinkSession;
  outFrames: TerminalOutMessage[];
  resets: TerminalResetMessage[];
  connectLink(): Promise<void>;
  dropLink(): Promise<void>;
}

async function setup(overrides: Partial<TerminalStreamBridgeOptions> = {}): Promise<Harness> {
  const incarnations = new Map<string, number>();
  const snapshots = new Map<string, string>();
  const owners = new Map<string, string | null>();
  let ptyPeer: FakePtyHost | null = null;
  let rendererPeer: FakePeer | null = null;
  let ptyBlocked = false;

  const bridge = new TerminalStreamBridge({
    endpointId: ENDPOINT,
    openPort: () => {
      if (ptyBlocked) return null;
      ptyPeer?.close();
      ptyPeer = new FakePtyHost((id) => {
        const data = snapshots.get(id);
        return data === undefined ? null : { data, cols: 100, rows: 30 };
      });
      return ptyPeer.port;
    },
    releasePort: () => ptyPeer?.close(),
    getIncarnation: (id) => incarnations.get(id) ?? 1,
    ownerOf: (id) => (owners.has(id) ? owners.get(id)! : "project-a"),
    reconnectDelayMs: 10,
    ...overrides,
  });
  const relay = new ClientTerminalRelay({
    endpointId: ENDPOINT,
    openRendererPort: () => {
      rendererPeer?.close();
      rendererPeer = new FakePeer();
      return rendererPeer.port;
    },
  });
  bridge.setProject("project-a");
  relay.deliverPort();
  cleanups.push(() => {
    relay.dispose();
    bridge.dispose();
    ptyPeer?.close();
    rendererPeer?.close();
  });

  const h: Harness = {
    bridge,
    relay,
    pty: () => ptyPeer!,
    renderer: () => rendererPeer!,
    incarnations,
    snapshots,
    owners,
    blockPty: (blocked) => {
      ptyBlocked = blocked;
    },
    host: null as unknown as LinkSession,
    client: null as unknown as LinkSession,
    outFrames: [],
    resets: [],
    async connectLink() {
      const { host, client } = await openSessionPair(dir);
      cleanups.push(() => {
        host.close("test done");
        client.close("test done");
      });
      h.host = host;
      h.client = client;
      client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (body) => h.outFrames.push(body));
      client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_RESET, (body) => h.resets.push(body));
      bridge.attach(host);
      relay.attach(client);
      // The attach-time resume must have been answered and applied before the
      // test drives traffic: until then the host holds output back.
      await waitFor(() => relay.isAttached && bridge.isResumed && !relay.resumeInFlight);
    },
    async dropLink() {
      const closed = new Promise((resolve) => h.host.onClose(resolve));
      h.client.close("network gone");
      await closed;
      await waitFor(() => !bridge.isAttached && !relay.isAttached);
    },
  };
  return h;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the host has handled everything the renderer posted so far: a
 * resize behind it travels the same ordered path and reaches the pty-host
 * after any ack the host passed on for what came before.
 */
async function hostCaughtUp(h: Harness, id = "t1"): Promise<void> {
  const before = h.pty().ofType("resize").length;
  h.renderer().post({ type: "resize", id, cols: 80, rows: 24 });
  await waitFor(() => h.pty().ofType("resize").length > before);
}

/** Have the client ask for a repaint of t1 and wait for the reset to reach its renderer. */
async function requestRepaint(h: Harness, lastSeq: number): Promise<void> {
  const resets = h.renderer().ofType("reset").length;
  await h.client.call(TERMINAL_RESUME_METHOD, {
    endpointId: ENDPOINT,
    terminals: [{ id: "t1", incarnation: 1, lastSeq, reset: true }],
  });
  await waitFor(() => h.renderer().ofType("reset").length === resets + 1);
}

/** A bridge on a session the test drives by hand, with a pty-host stand-in. */
function bareBridge(overrides: Partial<TerminalStreamBridgeOptions> = {}) {
  const pty = new FakePtyHost(() => ({ data: "SNAP", cols: 80, rows: 24 }));
  const session = fakeSession();
  const bridge = new TerminalStreamBridge({
    endpointId: ENDPOINT,
    openPort: () => pty.port,
    releasePort: () => {},
    getIncarnation: () => 1,
    ownerOf: () => "project-a",
    ...overrides,
  });
  cleanups.push(() => {
    bridge.dispose();
    pty.close();
  });
  bridge.setProject("project-a");
  return {
    pty,
    session,
    bridge,
    start() {
      bridge.attach(session);
      bridge.resume({ endpointId: ENDPOINT, terminals: [] });
    },
  };
}

function rendererData(h: Harness, id?: string): string[] {
  return h
    .renderer()
    .ofType("data")
    .filter((m) => id === undefined || m.id === id)
    .map(decode);
}

describe("terminal stream over the link", () => {
  it("round-trips data, write, resize and ack with the port message shapes", async () => {
    const h = await setup();
    await h.connectLink();

    const bytes = h.pty().emit("t1", "hello");
    await waitFor(() => h.renderer().ofType("data").length === 1);
    const delivered = h.renderer().ofType("data")[0]!;
    expect(delivered.type).toBe("data");
    expect(delivered.id).toBe("t1");
    expect(delivered.data).toBeInstanceOf(Uint8Array);
    expect(delivered.bytes).toBe(bytes);
    expect(decode(delivered)).toBe("hello");

    h.renderer().post({ type: "write", id: "t1", data: "ls\r" });
    h.renderer().post({ type: "resize", id: "t1", cols: 120, rows: 40 });
    h.renderer().post({ type: "ack", id: "t1", bytes });
    await waitFor(() => h.pty().received.length === 3);
    expect(h.pty().received).toEqual([
      { type: "write", id: "t1", data: "ls\r" },
      { type: "resize", id: "t1", cols: 120, rows: 40 },
      { type: "ack", id: "t1", bytes },
    ]);
  });

  it("drops input and resizes while this endpoint does not drive, and stamps its lease when it does", async () => {
    // Asked as each message is applied, so answer per message, in order.
    const answers: Array<number | null | false> = [false, false, 7, 7, null];
    const h = await setup({ driveLease: () => answers.shift() ?? null });
    await h.connectLink();

    h.renderer().post({ type: "resize", id: "t1", cols: 90, rows: 20 });
    h.renderer().post({ type: "write", id: "t1", data: "a" });
    // A stamp is the host's to make, never the client's.
    h.renderer().post({ type: "write", id: "t1", data: "b", leaseId: 99 });
    h.renderer().post({ type: "resize", id: "t1", cols: 120, rows: 40 });
    // Nobody holds the project: through, unstamped.
    h.renderer().post({ type: "write", id: "t1", data: "c" });
    await waitFor(() => h.pty().received.length === 3);
    expect(h.pty().received).toEqual([
      { type: "write", id: "t1", data: "b", leaseId: 7 },
      { type: "resize", id: "t1", cols: 120, rows: 40, leaseId: 7 },
      { type: "write", id: "t1", data: "c" },
    ]);
  });

  it("relays status pulses and drops renderer messages a remote view may not send", async () => {
    const h = await setup();
    await h.connectLink();

    h.pty().post({ type: "tier-changed", id: "t1", tier: "background" });
    await waitFor(() => h.renderer().ofType("tier-changed").length === 1);
    expect(h.outFrames[0]).toMatchObject({ terminalId: "t1", seq: 0 });

    h.renderer().post({ type: "worker-ingest-engage", id: "t1" });
    h.renderer().post({ type: "write", id: "t1", data: "x" });
    await waitFor(() => h.pty().received.length === 1);
    expect(h.pty().received).toEqual([{ type: "write", id: "t1", data: "x" }]);
  });

  it("stamps a monotonic per-terminal sequence and the PTY incarnation", async () => {
    const h = await setup();
    h.incarnations.set("t1", 7);
    h.incarnations.set("t2", 3);
    await h.connectLink();

    h.pty().emit("t1", "a");
    h.pty().emit("t2", "b");
    h.pty().emit("t1", "c");
    h.pty().emit("t1", "d");
    await waitFor(() => h.outFrames.length === 4);

    const t1 = h.outFrames.filter((f) => f.terminalId === "t1");
    const t2 = h.outFrames.filter((f) => f.terminalId === "t2");
    expect(t1.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(t1.every((f) => f.incarnation === 7)).toBe(true);
    expect(t2.map((f) => [f.seq, f.incarnation])).toEqual([[1, 3]]);
    expect(h.relay.position("t1")).toEqual({ incarnation: 7, lastSeq: 3 });
  });

  it("replays exactly the frames missed while the link was down", async () => {
    const h = await setup();
    await h.connectLink();

    h.pty().emit("t1", "one");
    h.pty().emit("t1", "two");
    await waitFor(() => rendererData(h).length === 2);

    await h.dropLink();
    h.pty().emit("t1", "three");
    h.pty().emit("t1", "four");
    await waitFor(() => h.bridge.position("t1")?.seq === 4);

    h.outFrames.length = 0;
    await h.connectLink();
    await waitFor(() => rendererData(h).length === 4);
    expect(rendererData(h)).toEqual(["one", "two", "three", "four"]);
    expect(h.outFrames.map((f) => f.seq)).toEqual([3, 4]);
    expect(h.resets).toEqual([]);

    h.pty().emit("t1", "five");
    await waitFor(() => rendererData(h).length === 5);
    expect(h.relay.position("t1")).toEqual({ incarnation: 1, lastSeq: 5 });
  });

  it("resets from a snapshot when the ring no longer holds the resume point", async () => {
    const h = await setup({ ringBytesPerTerminal: 300 });
    await h.connectLink();
    h.pty().emit("t1", "first");
    await waitFor(() => rendererData(h).length === 1);

    await h.dropLink();
    for (let i = 0; i < 10; i++) h.pty().emit("t1", `chunk-${i}-${"x".repeat(40)}`);
    await waitFor(() => h.bridge.position("t1")?.seq === 11);
    h.snapshots.set("t1", "SNAPSHOT-OF-T1");

    await h.connectLink();
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]).toEqual({
      type: "reset",
      id: "t1",
      snapshot: { data: "SNAPSHOT-OF-T1", cols: 100, rows: 30 },
    });
    expect(h.resets[0]).toMatchObject({ terminalId: "t1", seq: 11, incarnation: 1 });
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Terminal stream reset",
      expect.objectContaining({ terminalId: "t1", reason: "ring-gap", endpointId: ENDPOINT })
    );
    expect(JSON.stringify(loggerMock.info.mock.calls)).not.toContain("chunk-");

    h.pty().emit("t1", "after");
    await waitFor(() => rendererData(h).includes("after"));
    expect(h.relay.position("t1")).toEqual({ incarnation: 1, lastSeq: 12 });
  });

  it("resets cleanly when the PTY restarted while the client was away", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().emit("t1", "old life");
    await waitFor(() => rendererData(h).length === 1);

    await h.dropLink();
    h.incarnations.set("t1", 2);
    h.pty().emit("t1", "new life");
    h.snapshots.set("t1", "FRESH");

    await h.connectLink();
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.resets[0]).toMatchObject({ terminalId: "t1", incarnation: 2, seq: 1 });
    expect(h.renderer().ofType("reset")[0]!.snapshot).toMatchObject({ data: "FRESH" });
    expect(h.relay.position("t1")).toEqual({ incarnation: 2, lastSeq: 1 });
  });

  it("streams a restarted PTY live from its first frame without a reset", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => rendererData(h).length === 1);

    h.incarnations.set("t1", 2);
    h.pty().emit("t1", "b");
    await waitFor(() => rendererData(h).length === 2);
    expect(h.outFrames.at(-1)).toMatchObject({ incarnation: 2, seq: 1 });
    expect(h.resets).toEqual([]);
  });

  it("acks for itself while the client is away so the PTY never stalls", async () => {
    const h = await setup();
    await h.connectLink();

    const first = h.pty().emit("t1", "unacked by the renderer");
    await waitFor(() => rendererData(h).length === 1);
    expect(h.pty().ackedBytes()).toBe(0);

    await h.dropLink();
    // What the renderer still owed is settled at once...
    await waitFor(() => h.pty().ackedBytes() === first);
    // ...and everything produced while away is acked on arrival.
    let away = 0;
    for (let i = 0; i < 5; i++) away += h.pty().emit("t1", `away-${i}`);
    await waitFor(() => h.pty().ackedBytes() === first + away);

    // After the resume, late acks for frames already settled are not
    // counted a second time.
    await h.connectLink();
    await waitFor(() => rendererData(h).length === 6);
    h.renderer().post({ type: "ack", id: "t1", bytes: first + away });
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).length === 7);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes() === first + away + live);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.pty().ackedBytes()).toBe(first + away + live);
  });

  it("drops a client that stops acking to a snapshot resync", async () => {
    const h = await setup({ maxOutstandingBytes: 100 });
    h.snapshots.set("t1", "RESYNC");
    await h.connectLink();

    let produced = 0;
    for (let i = 0; i < 6; i++) produced += h.pty().emit("t1", "y".repeat(30));
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    // The PTY is released rather than left paused on a renderer that is not acking.
    await waitFor(() => h.pty().ackedBytes() >= 100);
    expect(h.pty().ackedBytes()).toBeLessThanOrEqual(produced);
    expect(h.renderer().ofType("reset")[0]!.snapshot).toMatchObject({ data: "RESYNC" });
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Terminal stream reset",
      expect.objectContaining({ terminalId: "t1", reason: "outstanding-bytes" })
    );
  });

  it("enforces the host-wide ring cap across terminals", async () => {
    const budget = new RingBudget(2_000);
    const h = await setup({ budget, ringBytesPerTerminal: 1_500 });
    await h.connectLink();
    await h.dropLink();

    for (let i = 0; i < 20; i++) {
      h.pty().emit("t1", "a".repeat(100));
      h.pty().emit("t2", "b".repeat(100));
    }
    await waitFor(() => h.bridge.position("t2")?.seq === 20);
    expect(budget.usedBytes).toBeLessThanOrEqual(2_000);
    expect(budget.usedBytes).toBeGreaterThan(0);
  });

  it("drops input typed while the link is down and sends only the latest size after reconnecting", async () => {
    const h = await setup();
    await h.connectLink();
    await h.dropLink();

    h.renderer().post({ type: "write", id: "t1", data: "typed offline" });
    h.renderer().post({ type: "resize", id: "t1", cols: 80, rows: 24 });
    h.renderer().post({ type: "resize", id: "t1", cols: 100, rows: 30 });
    h.renderer().post({ type: "ack", id: "t1", bytes: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await h.connectLink();
    h.renderer().post({ type: "write", id: "t1", data: "typed online" });
    await waitFor(() => h.pty().received.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Keystrokes never cross into a session other than the one they were typed against.
    expect(h.pty().received).toEqual([
      { type: "resize", id: "t1", cols: 100, rows: 30 },
      { type: "write", id: "t1", data: "typed online" },
    ]);
  });

  it("repaints a terminal from a snapshot when a fresh host bridge never streamed it", async () => {
    const h = await setup();
    h.snapshots.set("t1", "EVERYTHING-SO-FAR");
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => h.relay.position("t1") !== null);

    // A fresh host bridge (the endpoint was recreated) never carried t1, so
    // it can't replay what the client missed; it must not leave a silent gap.
    await h.dropLink();
    h.bridge.setProject(null);
    h.bridge.setProject("project-a");
    await h.connectLink();
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]!.snapshot).toMatchObject({ data: "EVERYTHING-SO-FAR" });

    h.pty().emit("t1", "b");
    await waitFor(() => rendererData(h).includes("b"));
  });

  it("delivers that repaint once the pty-host connects, even if the terminal stays quiet", async () => {
    const h = await setup();
    h.snapshots.set("t1", "QUIET-SINCE");
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => h.relay.position("t1") !== null);

    await h.dropLink();
    h.blockPty(true);
    h.bridge.setProject(null);
    h.bridge.setProject("project-a");
    await h.connectLink();
    expect(h.renderer().ofType("reset")).toEqual([]);

    h.blockPty(false);
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]!.snapshot).toMatchObject({ data: "QUIET-SINCE" });
  });

  it("answers unknown for a stream its own resume retired to make room", async () => {
    const h = await setup({ maxStreams: 1 });
    await h.connectLink();
    h.pty().emit("t1", "a");
    h.pty().emit("t2", "b");
    await waitFor(() => h.relay.position("t2") !== null);

    await h.dropLink();
    h.bridge.setProject(null);
    h.bridge.setProject("project-a");
    const answer = TerminalResumeResultSchema.parse(
      await (async () => {
        const { host, client } = await openSessionPair(dir);
        cleanups.push(() => {
          host.close("test done");
          client.close("test done");
        });
        h.bridge.attach(host);
        return client.call(TERMINAL_RESUME_METHOD, {
          endpointId: ENDPOINT,
          terminals: [
            { id: "t1", incarnation: 1, lastSeq: 1 },
            { id: "t2", incarnation: 1, lastSeq: 1 },
          ],
        });
      })()
    );
    expect(answer.terminals).toEqual([
      { id: "t1", outcome: "unknown" },
      { id: "t2", outcome: "reset" },
    ]);
  });

  it("forgets a terminal its project no longer owns instead of waiting on it", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => h.relay.position("t1") !== null);

    await h.dropLink();
    h.owners.set("t1", null);
    h.bridge.setProject(null);
    h.bridge.setProject("project-a");
    await h.connectLink();
    await waitFor(() => h.relay.position("t1") === null);
    expect(h.renderer().ofType("reset")).toEqual([]);
  });

  it("answers resume for the right endpoint on a shared session", async () => {
    const h = await setup();
    await h.connectLink();
    await expect(
      h.client.call(TERMINAL_RESUME_METHOD, { endpointId: "someone-else", terminals: [] })
    ).rejects.toThrow();
  });

  it("reconnects to the pty-host when its port closes underneath", async () => {
    const h = await setup();
    h.snapshots.set("t1", "REPAINT");
    await h.connectLink();
    h.pty().emit("t1", "before");
    await waitFor(() => rendererData(h).length === 1);
    const first = h.pty();
    first.close();
    await waitFor(() => h.pty() !== first);
    // Bytes the old connection held are gone, so the stream is repainted.
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]!.snapshot).toMatchObject({ data: "REPAINT" });

    h.pty().emit("t1", "after reconnect");
    await waitFor(() => rendererData(h).includes("after reconnect"));
  });
  it("refuses input for terminals the endpoint's project does not own", async () => {
    const h = await setup();
    h.owners.set("foreign", "project-b");
    h.owners.set("gone", null);
    await h.connectLink();

    h.renderer().post({ type: "write", id: "foreign", data: "rm -rf ~\r" });
    h.renderer().post({ type: "resize", id: "foreign", cols: 10, rows: 10 });
    h.renderer().post({ type: "ack", id: "foreign", bytes: 1_000 });
    h.renderer().post({ type: "write", id: "gone", data: "x" });
    h.renderer().post({ type: "write", id: "t1", data: "mine" });
    await waitFor(() => h.pty().received.some((m) => m.type === "write"));
    expect(h.pty().received).toEqual([{ type: "write", id: "t1", data: "mine" }]);
  });

  it("never streams a foreign terminal's output, but releases its bytes", async () => {
    const h = await setup();
    h.owners.set("foreign", "project-b");
    await h.connectLink();

    const bytes = h.pty().emit("foreign", "secret");
    h.pty().emit("t1", "visible");
    await waitFor(() => rendererData(h).length === 1);
    expect(rendererData(h)).toEqual(["visible"]);
    expect(h.bridge.position("foreign")).toBeNull();
    expect(h.pty().ackedBytes("foreign")).toBe(bytes);
  });

  it("answers a resume for a foreign terminal as unknown", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => h.bridge.position("t1") !== null);

    // The spawn records moved t1 away (or it was never ours).
    h.owners.set("t1", "project-b");
    const result = await h.client.call(TERMINAL_RESUME_METHOD, {
      endpointId: ENDPOINT,
      terminals: [{ id: "t1", incarnation: 1, lastSeq: 0 }],
    });
    expect(result).toEqual({ terminals: [{ id: "t1", outcome: "unknown" }] });
    expect(h.bridge.position("t1")).toBeNull();
  });

  it("resets instead of replaying when the client asks for it", async () => {
    const h = await setup();
    h.snapshots.set("t1", "REPAINT");
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => rendererData(h).length === 1);

    const result = await h.client.call(TERMINAL_RESUME_METHOD, {
      endpointId: ENDPOINT,
      terminals: [{ id: "t1", incarnation: 1, lastSeq: 1, reset: true }],
    });
    expect(result).toEqual({ terminals: [{ id: "t1", outcome: "reset" }] });
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Terminal stream reset",
      expect.objectContaining({ terminalId: "t1", reason: "client-requested" })
    );
  });

  it("fences a reset so output around the snapshot is neither repeated nor lost", async () => {
    const h = await setup({ maxOutstandingBytes: 10 });
    await h.connectLink();
    h.pty().holdFences = true;

    // Over the outstanding cap: the bridge asks the pty-host for a fenced snapshot.
    h.pty().emit("t1", "0123456789ABC");
    await waitFor(() => h.pty().pendingFences.length === 1);
    const fence = h.pty().pendingFences[0]!;
    // Before the marker: already in the snapshot, so it must never be sent.
    h.pty().emit("t1", "before-fence");
    h.pty().postFenceMarker(fence);
    // After the marker: not in the snapshot, so it must follow the reset.
    h.pty().emit("t1", "after-fence");
    await waitFor(() => h.bridge.position("t1")?.seq === 3);
    h.pty().postSnapshot(fence, { data: "SNAP", cols: 132, rows: 43 });

    await waitFor(() => rendererData(h).includes("after-fence"));
    expect(h.renderer().ofType("reset")).toEqual([
      { type: "reset", id: "t1", snapshot: { data: "SNAP", cols: 132, rows: 43 } },
    ]);
    expect(h.resets[0]).toMatchObject({ terminalId: "t1", seq: 2 });
    expect(rendererData(h)).not.toContain("before-fence");
    const order = h.renderer().received.map((m) => (m.type === "reset" ? "reset" : decode(m)));
    expect(order.slice(order.indexOf("reset"))).toEqual(["reset", "after-fence"]);
  });

  it("carries each chunk's stream offset to the renderer, live and replayed", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().stampStreams = true;

    h.pty().emit("t1", "one");
    await waitFor(() => rendererData(h).length === 1);
    expect(h.outFrames[0]!.message).toMatchObject({ streamEnd: 3 });
    expect(h.renderer().ofType("data")[0]).toMatchObject({ streamEnd: 3 });

    await h.dropLink();
    h.pty().emit("t1", "two");
    h.pty().emit("t1", "three");
    await waitFor(() => h.bridge.position("t1")?.seq === 3);

    await h.connectLink();
    await waitFor(() => rendererData(h).length === 3);
    // Replayed from the ring with the offsets they were stamped with.
    expect(
      h
        .renderer()
        .ofType("data")
        .map((m) => m.streamEnd)
    ).toEqual([3, 6, 11]);
  });

  it("leaves a chunk the pty-host did not stamp without an offset", async () => {
    const h = await setup();
    await h.connectLink();

    h.pty().emit("t1", "legacy");
    await waitFor(() => rendererData(h).length === 1);
    expect(h.renderer().ofType("data")[0]).not.toHaveProperty("streamEnd");
  });

  it("hands a fenced reset's continuation to the renderer", async () => {
    const h = await setup({ maxOutstandingBytes: 10 });
    await h.connectLink();
    h.pty().holdFences = true;
    h.pty().stampStreams = true;

    h.pty().emit("t1", "0123456789\x1b[");
    await waitFor(() => h.pty().pendingFences.length === 1);
    const fence = h.pty().pendingFences[0]!;
    h.pty().postFenceMarker(fence);
    const continuation = { pendingEscapeTail: "\x1b[", streamOffset: h.pty().streamOffset("t1") };
    h.pty().emit("t1", "1mRED");
    await waitFor(() => h.bridge.position("t1")?.seq === 2);
    h.pty().postSnapshot(fence, { data: "0123456789", cols: 132, rows: 43, continuation });

    await waitFor(() => rendererData(h).includes("1mRED"));
    // Through the link's schema, then the relay.
    expect(h.resets[0]!.snapshot).toEqual({
      data: "0123456789",
      cols: 132,
      rows: 43,
      continuation,
    });
    expect(h.renderer().ofType("reset")).toEqual([
      {
        type: "reset",
        id: "t1",
        snapshot: { data: "0123456789", cols: 132, rows: 43, continuation },
      },
    ]);
    expect(h.renderer().ofType("data").at(-1)).toMatchObject({ streamEnd: 17 });
  });

  it("drops a malformed continuation from a reset but keeps the snapshot", async () => {
    const h = await setup({ maxOutstandingBytes: 10 });
    await h.connectLink();
    h.pty().holdFences = true;

    h.pty().emit("t1", "0123456789ABC");
    await waitFor(() => h.pty().pendingFences.length === 1);
    const fence = h.pty().pendingFences[0]!;
    h.pty().postFenceMarker(fence);
    h.pty().postSnapshot(fence, {
      data: "SNAP",
      cols: 80,
      rows: 24,
      continuation: { pendingEscapeTail: 7, streamOffset: -1 },
    } as unknown as SerializedTerminalSnapshot);

    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]).toEqual({
      type: "reset",
      id: "t1",
      snapshot: { data: "SNAP", cols: 80, rows: 24 },
    });
  });

  it("still repaints after a pty-host restart whose respawned PTY outruns the repaint", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().emit("t1", "before");
    await waitFor(() => rendererData(h).length === 1);

    // The pty-host restarted: every followed stream is owed a repaint...
    h.bridge.reconnect();
    h.pty().holdFences = true;
    h.pty().stampStreams = true;
    await waitFor(() => h.pty().pendingFences.length === 1);
    // ...and the respawned PTY emits before that snapshot comes back.
    h.incarnations.set("t1", 2);
    h.pty().emit("t1", "fresh");
    await waitFor(() => h.pty().pendingFences.length === 2);

    const fence = h.pty().pendingFences[1]!;
    h.pty().postFenceMarker(fence);
    h.pty().postSnapshot(fence, { data: "fresh", cols: 80, rows: 24 });
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.resets[0]).toMatchObject({ terminalId: "t1", incarnation: 2, seq: 1 });
    expect(rendererData(h)).toEqual(["before"]);
  });

  it("streams a restarted PTY live when only a resync for a slow client was pending", async () => {
    const h = await setup({ maxOutstandingBytes: 10 });
    await h.connectLink();
    h.pty().holdFences = true;

    h.pty().emit("t1", "0123456789ABC");
    await waitFor(() => h.pty().pendingFences.length === 1);
    h.incarnations.set("t1", 2);
    h.pty().emit("t1", "fresh");

    // On top of the scrollback the pane already has, rather than a repaint
    // of the new PTY that would wipe it.
    await waitFor(() => rendererData(h).includes("fresh"));
    expect(h.outFrames.at(-1)).toMatchObject({ incarnation: 2, seq: 1 });
    expect(h.resets).toEqual([]);
    expect(h.pty().pendingFences).toHaveLength(1);
  });

  it("drops the continuation along with a snapshot too large to send", async () => {
    const h = await setup({ maxOutstandingBytes: 10, maxSnapshotBytes: 4 });
    await h.connectLink();
    h.pty().holdFences = true;
    h.pty().stampStreams = true;

    h.pty().emit("t1", "0123456789ABC");
    await waitFor(() => h.pty().pendingFences.length === 1);
    const fence = h.pty().pendingFences[0]!;
    h.pty().postFenceMarker(fence);
    h.pty().postSnapshot(fence, {
      data: "TOO LARGE",
      cols: 80,
      rows: 24,
      continuation: { pendingEscapeTail: "\x1b[", streamOffset: 13 },
    });

    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]).toEqual({ type: "reset", id: "t1", snapshot: null });
  });

  it("resets to a cleared screen when the snapshot never arrives", async () => {
    const h = await setup({ maxOutstandingBytes: 10, snapshotTimeoutMs: 30 });
    await h.connectLink();
    h.pty().holdFences = true;
    h.pty().emit("t1", "0123456789ABC");
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]).toEqual({ type: "reset", id: "t1", snapshot: null });
  });

  it("keeps its resync thresholds under the pty-host's pause watermarks and safety timeout", () => {
    expect(DEFAULT_MAX_OUTSTANDING_BYTES).toBeLessThan(
      (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100
    );
    expect(DEFAULT_MAX_TOTAL_OUTSTANDING_BYTES).toBeLessThan(IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES);
    expect(DEFAULT_ACK_TIMEOUT_MS).toBeLessThan(IPC_MAX_PAUSE_MS);
  });

  it("releases a PTY whose renderer never acks, well before the pause safety timeout", async () => {
    const h = await setup({ ackTimeoutMs: 40 });
    h.snapshots.set("t1", "LATEST");
    await h.connectLink();

    const produced = h.pty().emit("t1", "small, far under any byte cap");
    await waitFor(() => rendererData(h).length === 1);
    expect(h.pty().ackedBytes("t1")).toBe(0);

    // The renderer never acks: after the ack timeout the bridge settles the
    // bytes itself and resyncs the view rather than hold the PTY.
    await waitFor(() => h.pty().ackedBytes("t1") === produced, 1_000);
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]!.snapshot).toMatchObject({ data: "LATEST" });

    // Silent after the reset too: nothing is held against the PTY, so there
    // is no reason to send it another snapshot.
    const after = h.pty().emit("t1", "more");
    await waitFor(() => h.pty().ackedBytes("t1") === produced + after);
    await sleep(150);
    expect(h.renderer().ofType("reset")).toHaveLength(1);
  });

  it("resets once, not in a loop, when the client takes longer than the ack timeout to apply a snapshot while output continues", async () => {
    const h = await setup({ ackTimeoutMs: 150 });
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    // A repaint before any output, so nothing is owed going into it.
    await requestRepaint(h, 0);

    // The renderer takes the reset, then spends several ack timeouts
    // restoring it, acking nothing, while the PTY keeps printing.
    h.renderer().post({ type: "reset-ack", id: "t1" });
    let during = 0;
    for (let i = 0; i < 10; i++) {
      during += h.pty().emit("t1", `during-${i}`);
      await sleep(50);
    }
    await waitFor(() => rendererData(h).filter((d) => d.startsWith("during-")).length === 10);
    // None of it was held against the PTY meanwhile.
    await waitFor(() => h.pty().ackedBytes("t1") === during);
    expect(h.renderer().ofType("reset")).toHaveLength(1);

    // Restored: it acks what it deferred, and its acks pace the PTY again.
    h.renderer().post({ type: "ack", id: "t1", bytes: during });
    await hostCaughtUp(h);
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).includes("live"));
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(during);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === during + live);
    expect(h.renderer().ofType("reset")).toHaveLength(1);
  });

  it("ends a reset's catch-up on the renderer's reset-ack, even when its acks alone could not show it", async () => {
    const h = await setup();
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    // Dropped by the renderer when it takes the reset, and larger than
    // anything acked after it: counting acks never gets past it.
    const pre = h.pty().emit("t1", "x".repeat(1000));
    await waitFor(() => rendererData(h).length === 1);
    await requestRepaint(h, 1);
    h.renderer().post({ type: "reset-ack", id: "t1" });
    const during = h.pty().emit("t1", "restored");
    await waitFor(() => rendererData(h).length === 2);
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during);

    h.renderer().post({ type: "ack", id: "t1", bytes: during });
    await hostCaughtUp(h);
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).includes("live"));
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(pre + during);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during + live);
    expect(h.renderer().ofType("reset")).toHaveLength(1);
  });

  it("never lets acks for replayed frames pay down live output", async () => {
    const h = await setup();
    await h.connectLink();
    const seen = h.pty().emit("t1", "seen");
    await waitFor(() => rendererData(h).length === 1);
    h.renderer().post({ type: "ack", id: "t1", bytes: seen });
    await waitFor(() => h.pty().ackedBytes("t1") === seen);

    await h.dropLink();
    let away = 0;
    for (let i = 0; i < 3; i++) away += h.pty().emit("t1", `away-${i}`);
    await waitFor(() => h.pty().ackedBytes("t1") === seen + away);
    await h.connectLink();
    await waitFor(() => rendererData(h).length === 4);
    const live = h.pty().emit("t1", "live output");
    await waitFor(() => rendererData(h).length === 5);

    // The replay's ack only comes in once the live output is out as well.
    h.renderer().post({ type: "ack", id: "t1", bytes: away });
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(seen + away);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === seen + away + live);
  });

  it("never lets a write that finishes after a reconnect pay down output sent since", async () => {
    const h = await setup();
    await h.connectLink();
    const old = h.pty().emit("t1", "written just before the link dropped");
    await waitFor(() => rendererData(h).length === 1);
    await h.dropLink();
    // Settled when the client went away.
    await waitFor(() => h.pty().ackedBytes("t1") === old);
    await h.connectLink();
    const live = h.pty().emit("t1", "live after the reconnect");
    await waitFor(() => rendererData(h).length === 2);

    // The renderer's write of the old frame only completes now.
    h.renderer().post({ type: "ack", id: "t1", bytes: old });
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(old);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === old + live);
  });

  it("ignores a renderer's reset-ack for a reset sent on an earlier session", async () => {
    const h = await setup({ ackTimeoutMs: 10_000 });
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    const pre = h.pty().emit("t1", "x".repeat(100));
    await waitFor(() => rendererData(h).length === 1);
    // The first reset reaches the renderer port, which is too busy to take it
    // before the link drops and comes back.
    await requestRepaint(h, 1);
    await h.dropLink();
    await h.connectLink();
    const between = h.pty().emit("t1", "between");
    await waitFor(() => rendererData(h).length === 2);
    await requestRepaint(h, 2);

    // It takes the first reset only now, and finishes writing what followed it.
    h.renderer().post({ type: "reset-ack", id: "t1" });
    h.renderer().post({ type: "ack", id: "t1", bytes: between });
    await hostCaughtUp(h);
    // The second reset is still unconfirmed, so what follows is still settled.
    const during = h.pty().emit("t1", "during");
    await waitFor(() => h.pty().ackedBytes("t1") === pre + between + during, 1_000);

    h.renderer().post({ type: "reset-ack", id: "t1" });
    h.renderer().post({ type: "ack", id: "t1", bytes: during });
    await hostCaughtUp(h);
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).includes("live"));
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(pre + between + during);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === pre + between + during + live);
    expect(h.renderer().ofType("reset")).toHaveLength(2);
  });

  it("confirms the reset a renderer took when an earlier one at the same point never reached it", async () => {
    const h = await setup({ ackTimeoutMs: 10_000 });
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    // Larger than anything acked after: counting acks never ends the catch-up.
    const pre = h.pty().emit("t1", "x".repeat(1000));
    await waitFor(() => rendererData(h).length === 1);
    // The view reloads: the first reset finds no renderer port, and the new
    // document asks for another at the same point.
    h.renderer().close();
    await waitFor(() => !h.relay.hasRendererPort);
    await h.client.call(TERMINAL_RESUME_METHOD, {
      endpointId: ENDPOINT,
      terminals: [{ id: "t1", incarnation: 1, lastSeq: 1, reset: true }],
    });
    await waitFor(() => h.resets.length === 1);
    h.relay.deliverPort();
    await waitFor(() => h.renderer().ofType("reset").length === 1);

    h.renderer().post({ type: "reset-ack", id: "t1" });
    const during = h.pty().emit("t1", "restored");
    await waitFor(() => rendererData(h).length === 1);
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during);
    h.renderer().post({ type: "ack", id: "t1", bytes: during });
    await hostCaughtUp(h);
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).includes("live"));
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(pre + during);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during + live);
  });

  it("never times out output still waiting in the ring for a busy lane", async () => {
    const h = await setup({ ackTimeoutMs: 100 });
    await h.connectLink();
    const real = h.host.queuedBytes.bind(h.host);
    // The lane is past its busy mark with this terminal's own frames, so its
    // output waits here rather than join them.
    h.host.queuedBytes = (_lane, flow) =>
      flow === undefined ? Number.MAX_SAFE_INTEGER : 64 * 1024;
    const held = h.pty().emit("t1", "held back");
    await waitFor(() => h.bridge.position("t1")?.seq === 1);
    await sleep(300);
    expect(rendererData(h)).toEqual([]);
    expect(h.pty().ofType("serialize-fence")).toEqual([]);

    h.host.queuedBytes = real;
    const next = h.pty().emit("t1", "and on");
    await waitFor(() => rendererData(h).length === 2);
    h.renderer().post({ type: "ack", id: "t1", bytes: held + next });
    await waitFor(() => h.pty().ackedBytes("t1") === held + next);
    expect(h.renderer().ofType("reset")).toEqual([]);
  });

  it("starts the ack clock only once the link has written the output", async () => {
    const { pty, session, start } = bareBridge({ ackTimeoutMs: 40 });
    const written: (() => void)[] = [];
    vi.mocked(session.post).mockImplementation((_message, onWritten) => {
      if (onWritten) written.push(onWritten);
      return "queued";
    });
    start();

    pty.emit("t1", "queued behind other traffic");
    await waitFor(() => written.length === 1);
    await sleep(150);
    expect(pty.ofType("serialize-fence")).toEqual([]);

    // Once it has left, a client that never acks it is still resynced.
    written[0]!();
    await waitFor(() => pty.ofType("serialize-fence").length === 1, 1_000);
  });

  it("posts a reset the link refused again as it is, without taking another snapshot", async () => {
    const { pty, session, bridge, start } = bareBridge({ maxOutstandingBytes: 10 });
    let writable: () => void = () => {};
    let refuse = true;
    const resets: unknown[] = [];
    vi.mocked(session.onWritable).mockImplementation((listener) => {
      writable = listener;
      return () => {};
    });
    const isReset = (message: Parameters<LinkSession["post"]>[0]) =>
      message.lane === Lane.INTERACTIVE && message.kind === InteractiveKind.TERMINAL_RESET;
    vi.mocked(session.post).mockImplementation((message) => {
      if (!isReset(message)) return "queued";
      if (refuse) return "refused";
      resets.push(message.body);
      return "queued";
    });
    start();

    const over = pty.emit("t1", "0123456789ABC");
    await waitFor(() => vi.mocked(session.post).mock.calls.some(([message]) => isReset(message)));
    writable();
    writable();
    const more = pty.emit("t1", "more");
    await waitFor(() => bridge.position("t1")?.seq === 2);
    await sleep(30);
    refuse = false;
    writable();

    expect(resets).toEqual([
      expect.objectContaining({
        terminalId: "t1",
        seq: 1,
        snapshot: { data: "SNAP", cols: 80, rows: 24 },
      }),
    ]);
    expect(pty.ofType("serialize-fence")).toHaveLength(1);
    // What arrived while it waited was settled, and follows it.
    await waitFor(() => pty.ackedBytes("t1") === over + more);
    const out = vi
      .mocked(session.post)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.lane === Lane.INTERACTIVE);
    expect(out.slice(-2).map((message) => message.kind)).toEqual([
      InteractiveKind.TERMINAL_RESET,
      InteractiveKind.TERMINAL_OUT,
    ]);
  });

  it("holds output past a window while the client restores a snapshot, and sends it once it acks", async () => {
    const h = await setup({ maxOutstandingBytes: 20 });
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => rendererData(h).length === 1);
    h.renderer().post({ type: "ack", id: "t1", bytes: 1 });
    await waitFor(() => h.pty().ackedBytes("t1") === 1);
    await requestRepaint(h, 1);

    for (let i = 0; i < 3; i++) h.pty().emit("t1", String(i).repeat(10));
    await waitFor(() => h.bridge.position("t1")?.seq === 4);
    // Two went out after the reset at seq 1; the third waits in the ring.
    expect(h.bridge.position("t1")?.sentSeq).toBe(3);
    await waitFor(() => rendererData(h).length === 3);
    expect(rendererData(h).slice(1)).toEqual(["0".repeat(10), "1".repeat(10)]);

    h.renderer().post({ type: "reset-ack", id: "t1" });
    h.renderer().post({ type: "ack", id: "t1", bytes: 10 });
    await waitFor(() => rendererData(h).length === 4);
    expect(rendererData(h)[3]).toBe("2".repeat(10));
  });

  it("falls back to counting acks for a client that never confirms a reset", async () => {
    const h = await setup();
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    // Its renderer drops the ack for this when it takes the reset.
    const pre = h.pty().emit("t1", "unacked");
    await waitFor(() => rendererData(h).length === 1);
    await requestRepaint(h, 1);

    const during = h.pty().emit("t1", "output after the reset");
    await waitFor(() => rendererData(h).length === 2);
    // An older renderer sends no reset-ack, only the ack once it has restored.
    h.renderer().post({ type: "ack", id: "t1", bytes: during });
    await hostCaughtUp(h);
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).length === 3);
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(pre + during);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during + live);
    expect(h.renderer().ofType("reset")).toHaveLength(1);
  });

  it("keeps settling output after a reset when a late ack for output from before it arrives", async () => {
    const h = await setup({ ackTimeoutMs: 10_000 });
    h.snapshots.set("t1", "SNAP");
    await h.connectLink();
    const pre = h.pty().emit("t1", "written before the reset");
    await waitFor(() => rendererData(h).length === 1);
    await requestRepaint(h, 1);

    // Its write finished before the renderer took the reset, so its ack
    // comes in after the reset went out. It says nothing about the restore.
    h.renderer().post({ type: "ack", id: "t1", bytes: pre });
    await hostCaughtUp(h);
    const during = h.pty().emit("t1", "still restoring");
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during, 1_000);

    h.renderer().post({ type: "reset-ack", id: "t1" });
    h.renderer().post({ type: "ack", id: "t1", bytes: during });
    await hostCaughtUp(h);
    const live = h.pty().emit("t1", "live");
    await waitFor(() => rendererData(h).includes("live"));
    await hostCaughtUp(h);
    expect(h.pty().ackedBytes("t1")).toBe(pre + during);
    h.renderer().post({ type: "ack", id: "t1", bytes: live });
    await waitFor(() => h.pty().ackedBytes("t1") === pre + during + live);
    expect(h.renderer().ofType("reset")).toHaveLength(1);
  });

  it("resyncs the busiest terminal when the endpoint's total unacked output grows too large", async () => {
    const h = await setup({ maxOutstandingBytes: 1_000, maxTotalOutstandingBytes: 150 });
    await h.connectLink();
    h.pty().emit("t1", "a".repeat(120));
    h.pty().emit("t2", "b".repeat(40));
    await waitFor(() => h.renderer().ofType("reset").length === 1);
    expect(h.renderer().ofType("reset")[0]!.id).toBe("t1");
  });

  it("keeps stream state bounded as thousands of terminals come and go", async () => {
    const budget = new RingBudget(64 * 1024);
    const live = new Set<string>();
    // A synchronous port, so each terminal's output lands while it is alive.
    let deliver: (message: unknown) => void = () => {};
    const churn = new TerminalStreamBridge({
      endpointId: "ep-churn",
      openPort: () => ({
        postMessage: () => {},
        onMessage: (listener) => (deliver = listener),
        onClose: () => {},
        close: () => {},
      }),
      releasePort: () => {},
      getIncarnation: () => 1,
      ownerOf: (id) => (live.has(id) ? "project-a" : null),
      budget,
    });
    cleanups.push(() => churn.dispose());
    churn.setProject("project-a");

    const data = new TextEncoder().encode("x");
    let peak = 0;
    for (let i = 0; i < 5_000; i++) {
      const id = `term-${i}`;
      live.add(id);
      deliver({ type: "data", id, data, bytes: data.byteLength });
      expect(churn.position(id)).not.toBeNull();
      // Terminals are destroyed as new ones start; only a handful run at once.
      live.delete(`term-${i - 8}`);
      peak = Math.max(peak, churn.streamCount);
    }
    expect(peak).toBeLessThan(200);
    expect(budget.usedBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("lets a quiet terminal's echo through a busy lane, holding back only terminals already waiting in it", async () => {
    const h = await setup();
    await h.connectLink();
    const real = h.host.queuedBytes.bind(h.host);
    // The lane is past its busy mark, all of it the flooding terminal's.
    h.host.queuedBytes = (_lane, flow) =>
      flow === undefined ? Number.MAX_SAFE_INTEGER : flow.endsWith("\0flood") ? 64 * 1024 : 0;
    h.pty().emit("flood", "line 1");
    h.pty().emit("quiet", "Q");
    await waitFor(() =>
      h
        .renderer()
        .ofType("data")
        .some((m) => m.id === "quiet")
    );
    expect(
      h
        .renderer()
        .ofType("data")
        .filter((m) => m.id === "flood")
    ).toEqual([]);

    // Held while its own frame waits; once that frame has left, the next write
    // pass sends the rest though the lane is still busy.
    let quietQueued = 64 * 1024;
    h.host.queuedBytes = (_lane, flow) =>
      flow === undefined
        ? Number.MAX_SAFE_INTEGER
        : flow.endsWith("\0flood")
          ? 64 * 1024
          : flow.endsWith("\0quiet")
            ? quietQueued
            : 0;
    h.pty().emit("quiet", "R");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      h
        .renderer()
        .ofType("data")
        .filter((m) => m.id === "quiet")
    ).toHaveLength(1);
    quietQueued = 0;
    h.pty().emit("other", "o");
    await waitFor(
      () =>
        h
          .renderer()
          .ofType("data")
          .filter((m) => m.id === "quiet").length === 2
    );
    expect(
      h
        .renderer()
        .ofType("data")
        .filter((m) => m.id === "flood")
    ).toEqual([]);

    // Once the lane has room the held terminal follows, in order.
    h.host.queuedBytes = real;
    h.pty().emit("flood", "line 2");
    await waitFor(
      () =>
        h
          .renderer()
          .ofType("data")
          .filter((m) => m.id === "flood").length === 2
    );
    expect(
      h
        .renderer()
        .ofType("data")
        .filter((m) => m.id === "flood")
        .map((m) => decode(m))
    ).toEqual(["line 1", "line 2"]);
  });

  it("caps tracked terminals even when all of them are still alive", async () => {
    const h = await setup({ maxStreams: 50 });
    await h.connectLink();
    for (let i = 0; i < 120; i++) h.pty().emit(`live-${i}`, "x");
    await waitFor(() => h.bridge.position("live-119") !== null);
    expect(h.bridge.streamCount).toBeLessThanOrEqual(50);
    // The least recently active went first.
    expect(h.bridge.position("live-0")).toBeNull();
  });
});
