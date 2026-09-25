import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { TERMINAL_RESUME_METHOD } from "../protocol.js";
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_MAX_OUTSTANDING_BYTES,
  DEFAULT_MAX_TOTAL_OUTSTANDING_BYTES,
  TerminalStreamBridge,
  type TerminalStreamBridgeOptions,
} from "../TerminalStreamBridge.js";
import { FakePeer, FakePtyHost, decode } from "./streamTestUtils.js";

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
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

  const bridge = new TerminalStreamBridge({
    endpointId: ENDPOINT,
    openPort: () => {
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

  it("drops resizes while this endpoint's client does not hold the drive lease", async () => {
    let driving = false;
    const h = await setup({ mayResize: () => driving });
    await h.connectLink();

    h.renderer().post({ type: "resize", id: "t1", cols: 90, rows: 20 });
    h.renderer().post({ type: "write", id: "t1", data: "a" });
    await waitFor(() => h.pty().received.length === 1);
    expect(h.pty().received).toEqual([{ type: "write", id: "t1", data: "a" }]);

    driving = true;
    h.renderer().post({ type: "resize", id: "t1", cols: 120, rows: 40 });
    await waitFor(() => h.pty().received.length === 2);
    expect(h.pty().received[1]).toEqual({ type: "resize", id: "t1", cols: 120, rows: 40 });
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

  it("holds input typed while the link is down and sends it after reconnecting", async () => {
    const h = await setup();
    await h.connectLink();
    await h.dropLink();

    h.renderer().post({ type: "write", id: "t1", data: "typed offline" });
    h.renderer().post({ type: "resize", id: "t1", cols: 80, rows: 24 });
    h.renderer().post({ type: "resize", id: "t1", cols: 100, rows: 30 });
    h.renderer().post({ type: "ack", id: "t1", bytes: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await h.connectLink();
    await waitFor(() => h.pty().received.length >= 2);
    expect(h.pty().received).toEqual([
      { type: "resize", id: "t1", cols: 100, rows: 30 },
      { type: "write", id: "t1", data: "typed offline" },
    ]);
  });

  it("forgets a terminal the host has no stream for instead of waiting on it", async () => {
    const h = await setup();
    await h.connectLink();
    h.pty().emit("t1", "a");
    await waitFor(() => h.relay.position("t1") !== null);

    // A fresh host bridge (the endpoint was recreated) knows nothing of t1.
    await h.dropLink();
    h.bridge.setProject(null);
    h.bridge.setProject("project-a");
    await h.connectLink();
    await waitFor(() => h.relay.position("t1") === null);

    h.pty().emit("t1", "b");
    await waitFor(() => rendererData(h).includes("b"));
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
