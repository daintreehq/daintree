import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type net from "node:net";
import { FrameDecoder, Lane, encodeFrame, type LinkFrame } from "../frames.js";
import { FRAGMENT_MORE, MESSAGE_FRAGMENT_BYTES, MessageAssembler } from "../messageFragments.js";
import {
  ControlKind,
  EventKind,
  InteractiveKind,
  RpcKind,
  frameToMessage,
  type LinkMessage,
} from "../messages.js";
import { LinkSession } from "../session.js";
import {
  closedPromise,
  heldWritesSocket,
  makeTempDir,
  removeTempDir,
  socketPair,
  waitFor,
} from "./linkTestUtils.js";

let dir: string;
const sessions: LinkSession[] = [];
const sockets: net.Socket[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close("test done");
  for (const s of sockets.splice(0)) s.destroy();
  await removeTempDir(dir);
});

/** Far larger than any socket buffer, so the sender stalls partway through it. */
const BIG = "x".repeat(4 * 1024 * 1024);

/**
 * A host and client that both read message fragments, over a real socket
 * whose client end starts paused: whatever the host writes stalls until the
 * test resumes it.
 */
async function stalledPair() {
  const { a, b } = await socketPair(dir);
  sockets.push(a, b);
  const options = { pingIntervalMs: 0, idleTimeoutMs: 0 } as const;
  const host = new LinkSession(a, { ...options, role: "host" });
  const client = new LinkSession(b, { ...options, role: "client" });
  sessions.push(host, client);
  host.open({ peerReadsFragments: true });
  client.open({ peerReadsFragments: true });
  b.pause();
  return { host, client, a, b };
}

function postOutput(session: LinkSession, terminalId: string, data: string): void {
  session.post({
    lane: Lane.INTERACTIVE,
    kind: InteractiveKind.TERMINAL_OUT,
    body: { endpointId: "e1", terminalId, incarnation: 1, seq: 1, message: { type: "data", data } },
  });
}

describe("LinkSession large messages (#15892)", () => {
  it("writes a ping and another terminal's output ahead of a multi-megabyte snapshot already being written", async () => {
    const { host, client, a, b } = await stalledPair();
    const seen: string[] = [];
    let pingBeforeReset: boolean | null = null;
    let snapshotData: string | null = null;
    client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (body) => {
      seen.push(`out:${body.terminalId}`);
    });
    client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_RESET, (body) => {
      seen.push(`reset:${body.terminalId}`);
      pingBeforeReset = client.peerPingNonce !== null;
      snapshotData = body.snapshot?.data ?? null;
    });

    host.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_RESET,
      body: {
        endpointId: "e1",
        terminalId: "t1",
        incarnation: 1,
        snapshot: { data: BIG, cols: 80, rows: 24 },
        seq: 0,
      },
    });
    await waitFor(() => a.writableNeedDrain);
    host.ping();
    postOutput(host, "t2", "echo");
    b.resume();

    await waitFor(() => seen.includes("reset:t1"));
    expect(seen).toEqual(["out:t2", "reset:t1"]);
    expect(pingBeforeReset).toBe(true);
    expect(snapshotData).toBe(BIG);
  });

  it("writes a ping and a small interactive frame ahead of a multi-megabyte RPC result already being written", async () => {
    const { host, client, a, b } = await stalledPair();
    host.setInvokeHandler(async () => ({ __daintreeIpcEnvelope: true, ok: true, data: BIG }));
    const decoder = new FrameDecoder();
    const frames: LinkFrame[] = [];
    b.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));

    const result = client.invoke("e1", "review:compare", []);
    await waitFor(() => a.writableNeedDrain);
    host.ping();
    postOutput(host, "t1", "echo");
    b.resume();

    const envelope = await result;
    expect(envelope).toEqual({ __daintreeIpcEnvelope: true, ok: true, data: BIG });
    const pingAt = frames.findIndex((f) => f.lane === Lane.CONTROL && f.kind === ControlKind.PING);
    const echoAt = frames.findIndex(
      (f) => f.lane === Lane.INTERACTIVE && f.kind === InteractiveKind.TERMINAL_OUT
    );
    const resultEndsAt = frames.findLastIndex((f) => f.lane === Lane.RPC);
    expect(pingAt).toBeGreaterThanOrEqual(0);
    expect(echoAt).toBeGreaterThanOrEqual(0);
    expect(pingAt).toBeLessThan(resultEndsAt);
    expect(echoAt).toBeLessThan(resultEndsAt);
  });
});

/** Every message in what a stream took, reassembled the way a peer would. */
function messagesIn(written: Buffer[]): LinkMessage[] {
  const decoder = new FrameDecoder();
  const assembler = new MessageAssembler(16 * 1024 * 1024);
  const messages: LinkMessage[] = [];
  for (const chunk of written) {
    for (const frame of decoder.push(chunk)) {
      const whole = assembler.push(frame);
      if (whole) messages.push(frameToMessage(whole));
    }
  }
  return messages;
}

function callsIn(written: Buffer[]): Array<{ method: string; payload: unknown }> {
  return messagesIn(written).flatMap((m) =>
    m.lane === Lane.RPC && m.kind === RpcKind.CALL
      ? [{ method: m.body.method, payload: m.body.payload }]
      : []
  );
}

/** A client session over a stream that takes one frame at a time when the test says. */
function heldSession(options: { peerReadsFragments: boolean }) {
  const held = heldWritesSocket();
  const session = new LinkSession(held.socket, {
    role: "client",
    pingIntervalMs: 0,
    idleTimeoutMs: 0,
  });
  sessions.push(session);
  session.open(options);
  /** Let every write through until the session has nothing left to write. */
  const drain = async () => {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!held.release()) {
        await new Promise((resolve) => setImmediate(resolve));
        if (!held.release()) return;
      }
    }
  };
  return { session, held, drain };
}

describe("LinkSession large messages and their requests (#15892)", () => {
  it("lets a small answer overtake a large one already being written", async () => {
    const { host, client, a, b } = await stalledPair();
    let smallAnswered = false;
    host.setInvokeHandler(async (msg) => {
      // Answered once the large answer is already being written.
      if (msg.channel === "small") {
        await waitFor(() => a.writableNeedDrain);
        smallAnswered = true;
      }
      return { __daintreeIpcEnvelope: true, ok: true, data: msg.channel === "big" ? BIG : 1 };
    });
    const settled: string[] = [];
    const big = client.invoke("e1", "big", []).then(() => settled.push("big"));
    const small = client.invoke("e1", "small", []).then(() => settled.push("small"));
    await waitFor(() => smallAnswered);
    await new Promise((r) => setTimeout(r, 20));
    b.resume();
    await Promise.all([big, small]);
    expect(settled).toEqual(["small", "big"]);
  });

  it("never sends any of a large request that settled before its first fragment went", async () => {
    const { session, held, drain } = heldSession({ peerReadsFragments: true });
    session.post({
      lane: Lane.EVENTS,
      kind: EventKind.EVENT,
      body: { endpointId: null, channel: "fill", args: [BIG] },
    });
    await waitFor(() => held.written.length === 1);
    const late = session.call("late", BIG, { timeoutMs: 20 });
    await expect(late).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    session.call("kept", null).catch(() => {});
    await drain();
    expect(callsIn(held.written).map((c) => c.method)).toEqual(["kept"]);
  });

  it("sends all of a large request once its first fragment went, though it settled meanwhile", async () => {
    const { session, held, drain } = heldSession({ peerReadsFragments: true });
    const ac = new AbortController();
    const taken = session.call("taken", BIG, { signal: ac.signal });
    await waitFor(() => held.written.length === 1);
    ac.abort();
    await expect(taken).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringMatching(/after it was sent/),
    });
    await drain();
    expect(callsIn(held.written)).toEqual([{ method: "taken", payload: BIG }]);
  });

  it("writes a large message whole to a peer that never offered fragments", async () => {
    const { session, held, drain } = heldSession({ peerReadsFragments: false });
    session.post({
      lane: Lane.EVENTS,
      kind: EventKind.EVENT,
      body: { endpointId: null, channel: "big", args: [BIG] },
    });
    await drain();
    const frames = held.written.flatMap((chunk) => new FrameDecoder().push(chunk));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.streamId).toBe(0);
    expect(frameToMessage(frames[0]!).body).toMatchObject({ channel: "big", args: [BIG] });
  });

  it("ends the session on the first fragment of a message it can't read, before holding the rest", async () => {
    const { a, b } = await socketPair(dir);
    sockets.push(a, b);
    const session = new LinkSession(a, { role: "host", pingIntervalMs: 0, idleTimeoutMs: 0 });
    sessions.push(session);
    session.open({ peerReadsFragments: true });
    const closed = closedPromise(session);
    b.write(
      encodeFrame({
        lane: Lane.RPC,
        kind: 99 | FRAGMENT_MORE,
        streamId: 1,
        payload: new Uint8Array(MESSAGE_FRAGMENT_BYTES),
      })
    );
    expect((await closed).reason).toMatch(/unknown message 1\/99/);
  });

  it("takes no fragments before the handshake", async () => {
    const { a, b } = await socketPair(dir);
    sockets.push(a, b);
    const session = new LinkSession(a, { role: "host", pingIntervalMs: 0, idleTimeoutMs: 0 });
    sessions.push(session);
    const closed = closedPromise(session);
    b.write(
      encodeFrame({
        lane: Lane.CONTROL,
        kind: ControlKind.HELLO | FRAGMENT_MORE,
        streamId: 1,
        payload: new Uint8Array(16),
      })
    );
    expect((await closed).reason).toMatch(/before handshake/);
  });
});
