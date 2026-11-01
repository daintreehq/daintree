import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type net from "node:net";
import { encodeValue } from "../encoding.js";
import { FrameDecoder, Lane, encodeFrame, type LinkFrame } from "../frames.js";
import {
  BulkKind,
  ControlKind,
  EventKind,
  InteractiveKind,
  RpcKind,
  frameToMessage,
  messageToFrame,
} from "../messages.js";
import { LinkSession } from "../session.js";
import { bytesTransferSource } from "../transfer.js";
import {
  TEST_HANDSHAKE,
  closedPromise,
  makeTempDir,
  openSessionPair,
  removeTempDir,
  socketPair,
  waitFor,
} from "./linkTestUtils.js";

let dir: string;
const sessions: LinkSession[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close("test done");
  await removeTempDir(dir);
});

async function pair(
  ...args: Parameters<typeof openSessionPair> extends [string, ...infer R] ? R : never
) {
  const p = await openSessionPair(dir, ...args);
  sessions.push(p.host, p.client);
  return p;
}

/** Collects frames arriving on a raw socket. */
function recordFrames(socket: net.Socket): LinkFrame[] {
  const decoder = new FrameDecoder();
  const frames: LinkFrame[] = [];
  socket.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  return frames;
}

describe("LinkSession request/response", () => {
  it("correlates concurrent invokes with their results", async () => {
    const { host, client } = await pair();
    host.setInvokeHandler(async (msg) => {
      const delay = msg.channel === "slow" ? 30 : 0;
      await new Promise((r) => setTimeout(r, delay));
      return {
        __daintreeIpcEnvelope: true,
        ok: true,
        data: `${msg.channel}:${String(msg.args[0])}`,
      };
    });
    const [slow, fast] = await Promise.all([
      client.invoke("e1", "slow", [1]),
      client.invoke("e1", "fast", [2]),
    ]);
    expect(slow).toEqual({ __daintreeIpcEnvelope: true, ok: true, data: "slow:1" });
    expect(fast).toEqual({ __daintreeIpcEnvelope: true, ok: true, data: "fast:2" });
  });

  it("answers an invoke with no handler with an error envelope", async () => {
    const { client } = await pair();
    const env = await client.invoke("e1", "x", []);
    expect(env.ok).toBe(false);
    expect(!env.ok && env.error.code).toBe("UNSUPPORTED");
  });

  it("times out an unanswered invoke as an unknown outcome", async () => {
    const { host, client } = await pair();
    host.setInvokeHandler(() => new Promise(() => {}));
    const env = await client.invoke("e1", "hang", [], { timeoutMs: 30 });
    expect(!env.ok && env.error.code).toBe("OUTCOME_UNKNOWN");
  });

  it("settles sent requests as OUTCOME_UNKNOWN and reverse requests as HOST_DISCONNECTED when the session dies", async () => {
    const { host, client } = await pair();
    host.setInvokeHandler(() => new Promise(() => {}));
    host.registerCallHandler("hang", z.unknown(), () => new Promise(() => {}));
    client.setReverseRequestHandler(() => new Promise(() => {}));
    const invoke = client.invoke("e1", "hang", []);
    const call = client.call("hang", null);
    const reverse = host.reverseRequest("e1", "mcp:dispatch-action", {});
    await new Promise((r) => setTimeout(r, 20));
    host.close("going away");
    const [env] = await Promise.all([
      invoke,
      expect(call).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }),
      expect(reverse).rejects.toMatchObject({ code: "HOST_DISCONNECTED" }),
    ]);
    expect(!env.ok && env.error.code).toBe("OUTCOME_UNKNOWN");
  });

  it("settles requests that never reached the socket as HOST_DISCONNECTED", async () => {
    const { host, client } = await pair();
    host.setInvokeHandler(() => new Promise(() => {}));
    host.registerCallHandler("hang", z.unknown(), () => new Promise(() => {}));
    // Queued in this tick; the close drops them before the deferred flush.
    const invoke = client.invoke("e1", "hang", []);
    const call = client.call("hang", null);
    client.close("leaving");
    const [env] = await Promise.all([
      invoke,
      expect(call).rejects.toMatchObject({ code: "HOST_DISCONNECTED" }),
    ]);
    expect(!env.ok && env.error.code).toBe("HOST_DISCONNECTED");
  });

  it("refuses requests beyond the pending cap until earlier ones settle", async () => {
    const { host, client } = await pair({}, { maxPendingRequests: 2 });
    host.setInvokeHandler(async (msg) =>
      msg.channel === "hang"
        ? new Promise<never>(() => {})
        : { __daintreeIpcEnvelope: true, ok: true, data: "done" }
    );
    const first = client.invoke("e1", "hang", [], { timeoutMs: 30 });
    const second = client.invoke("e1", "hang", [], { timeoutMs: 30 });
    const third = await client.invoke("e1", "ok", []);
    expect(!third.ok && third.error.code).toBe("RATE_LIMITED");
    await Promise.all([first, second]);
    await expect(client.invoke("e1", "ok", [])).resolves.toMatchObject({ ok: true, data: "done" });
  });

  it("validates CALL payloads by method and rejects unknown methods", async () => {
    const { host, client } = await pair();
    host.registerCallHandler("terminal.resume", z.object({ lastSeq: z.number() }), (p) => ({
      next: p.lastSeq + 1,
    }));
    await expect(client.call("terminal.resume", { lastSeq: 4 })).resolves.toEqual({ next: 5 });
    await expect(client.call("terminal.resume", { lastSeq: "x" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(client.call("nope", {})).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("carries reverse requests and their errors back to the host", async () => {
    const { host, client } = await pair();
    client.setReverseRequestHandler(async (msg) => {
      if (msg.method === "fail") throw new Error("renderer said no");
      return { endpoint: msg.endpointId, echo: msg.payload };
    });
    await expect(host.reverseRequest("e7", "ok", { a: 1 })).resolves.toEqual({
      endpoint: "e7",
      echo: { a: 1 },
    });
    await expect(host.reverseRequest("e7", "fail", null)).rejects.toThrow("renderer said no");
  });

  it("reports an aborted request as an unknown outcome once sent, cancelled before", async () => {
    const { host, client } = await pair();
    let reached = false;
    host.registerCallHandler("hang", z.unknown(), () => {
      reached = true;
      return new Promise(() => {});
    });
    const ac = new AbortController();
    const p = client.call("hang", null, { signal: ac.signal });
    p.catch(() => {});
    await waitFor(() => reached);
    ac.abort();
    await expect(p).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringMatching(/after it was sent/),
    });
    await expect(client.call("hang", null, { signal: ac.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  describe("a request settled while its frame waits behind backpressure (#15882)", () => {
    const BEYOND_SOCKET_BUFFERS = "x".repeat(4 * 1024 * 1024);
    const peers: net.Socket[] = [];

    afterEach(() => {
      for (const peer of peers.splice(0)) peer.destroy();
    });

    /**
     * A client whose peer is a paused raw socket, with one frame larger than
     * any socket buffer already handed to the stream: until the peer reads,
     * every later frame stays in the scheduler.
     */
    async function stalledClient(options: { requestTimeoutMs?: number } = {}) {
      const { client, a, b } = await pausedPeer(options);
      client.post({
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: "fill", args: [BEYOND_SOCKET_BUFFERS] },
      });
      await waitFor(() => a.writableNeedDrain);
      return { client, b };
    }

    async function pausedPeer(options: { requestTimeoutMs?: number } = {}) {
      const { a, b } = await socketPair(dir);
      peers.push(b);
      const client = new LinkSession(a, {
        role: "client",
        pingIntervalMs: 0,
        idleTimeoutMs: 0,
        ...options,
      });
      sessions.push(client);
      client.open();
      b.pause();
      return { client, a, b };
    }

    /** Resume the peer and name every request it receives up to a sentinel posted behind them. */
    async function requestsReceived(client: LinkSession, b: net.Socket): Promise<string[]> {
      const frames = recordFrames(b);
      client.post({
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: "sentinel", args: [] },
      });
      b.resume();
      const isSentinel = (f: LinkFrame) =>
        f.lane === Lane.EVENTS &&
        (frameToMessage(f).body as { channel: string }).channel === "sentinel";
      await waitFor(() => frames.some(isSentinel));
      return frames.flatMap((f) => {
        if (f.lane !== Lane.RPC) return [];
        const message = frameToMessage(f);
        if (message.lane !== Lane.RPC) return [];
        if (message.kind === RpcKind.CALL) return [message.body.method];
        if (message.kind === RpcKind.INVOKE) return [message.body.channel];
        return [];
      });
    }

    it("never sends a request that timed out before it was written", async () => {
      const { client, b } = await stalledClient();
      const timedOut = client.call("late", null, { timeoutMs: 20 });
      await expect(timedOut).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(client.queuedBytes(Lane.RPC)).toBeGreaterThan(0);
      client.call("kept", null).catch(() => {});
      expect(await requestsReceived(client, b)).toEqual(["kept"]);
      expect(client.queuedBytes(Lane.RPC)).toBe(0);
    });

    it("never sends a request that was aborted before it was written", async () => {
      const { client, b } = await stalledClient();
      const ac = new AbortController();
      const aborted = client.invoke("e1", "late", [], { signal: ac.signal });
      await new Promise((r) => setTimeout(r, 20));
      expect(client.queuedBytes(Lane.RPC)).toBeGreaterThan(0);
      ac.abort();
      const env = await aborted;
      expect(!env.ok && env.error.code).toBe("OUTCOME_UNKNOWN");
      expect(!env.ok && env.error.message).toMatch(/before it was sent/);
      client.invoke("e1", "kept", []).catch(() => {});
      expect(await requestsReceived(client, b)).toEqual(["kept"]);
    });

    it("still reports a request the stalled socket took as an unknown outcome, and delivers it", async () => {
      const { client, a, b } = await pausedPeer();
      const taken = client.call("taken", BEYOND_SOCKET_BUFFERS, { timeoutMs: 20 });
      taken.catch(() => {});
      await waitFor(() => a.writableNeedDrain);
      expect(client.queuedBytes(Lane.RPC)).toBe(0);
      await expect(taken).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(await requestsReceived(client, b)).toEqual(["taken"]);
    });

    it("still sends a request with no deadline once the link drains", async () => {
      const { client, b } = await stalledClient({ requestTimeoutMs: 20 });
      const late = client.call("late", null);
      const notice = client.call("notice", null, { timeoutMs: 0 });
      late.catch(() => {});
      notice.catch(() => {});
      await expect(late).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      // Past the session's deadline for a call made a moment after the first.
      await new Promise((r) => setTimeout(r, 40));
      expect(await requestsReceived(client, b)).toEqual(["notice"]);
    });

    it("still sends an endpoint's close held behind a request that settled unsent (#15881)", async () => {
      const { client, b } = await stalledClient();
      const ac = new AbortController();
      const aborted = client.invoke("e1", "late", [], { signal: ac.signal });
      client.post({
        lane: Lane.CONTROL,
        kind: ControlKind.ENDPOINT_CLOSE,
        body: { endpointId: "e1" },
      });
      await new Promise((r) => setTimeout(r, 20));
      ac.abort();
      await aborted;
      const frames = recordFrames(b);
      expect(await requestsReceived(client, b)).toEqual([]);
      expect(
        frames.some(
          (f) => f.lane === Lane.CONTROL && frameToMessage(f).kind === ControlKind.ENDPOINT_CLOSE
        )
      ).toBe(true);
    });
  });

  it("refuses to send a message the peer would reject, without ending the session", async () => {
    const { client } = await pair();
    expect(() =>
      client.post({
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: "", channel: "x", args: [] },
      })
    ).toThrow(/invalid body/);
    const env = await client.invoke("e", "x", new Array(100).fill(0));
    expect(!env.ok && env.error.message).toMatch(/invalid body/);
    expect(client.isOpen).toBe(true);
  });

  it("delivers events and interactive messages to subscribers", async () => {
    const { host, client } = await pair();
    const events: unknown[] = [];
    const inputs: unknown[] = [];
    client.on(Lane.EVENTS, EventKind.EVENT, (body) => events.push(body));
    host.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_IN, (body) => inputs.push(body));
    host.post({
      lane: Lane.EVENTS,
      kind: EventKind.EVENT,
      body: { endpointId: null, channel: "worktree:update", args: [{ id: "w" }] },
    });
    client.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_IN,
      body: { endpointId: "e1", message: { type: "write", data: "ls\r" } },
    });
    await waitFor(() => events.length === 1 && inputs.length === 1);
    expect(events[0]).toEqual({
      endpointId: null,
      channel: "worktree:update",
      args: [{ id: "w" }],
    });
    expect(inputs[0]).toEqual({ endpointId: "e1", message: { type: "write", data: "ls\r" } });
  });
});

describe("LinkSession liveness", () => {
  it("measures round-trip time from pings", async () => {
    const { host, client } = await pair({}, { pingIntervalMs: 10 });
    await waitFor(() => client.rttMs !== null);
    expect(client.rttMs).toBeGreaterThanOrEqual(0);
    expect(host.isOpen).toBe(true);
  });

  it("numbers its pings and tells the peer's newest one, for a summary to be dated by (#14462)", async () => {
    let t = 500;
    const { host, client } = await pair({}, { clock: () => ({ wall: t, mono: t }) });
    expect(host.peerPingNonce).toBeNull();
    client.ping();
    t = 900;
    client.ping();
    await waitFor(() => host.peerPingNonce === 1);
    expect(client.pingSentAt(0)).toEqual({ wall: 500, mono: 500 });
    expect(client.pingSentAt(1)).toEqual({ wall: 900, mono: 900 });
    expect(client.pingSentAt(2)).toBeNull();
    // The answer to each still measures the round trip.
    await waitFor(() => client.rttMs !== null);
    for (let i = 0; i < 20; i += 1) client.ping();
    // The newest 16 of the 22 sent.
    for (let nonce = 0; nonce <= 5; nonce += 1) expect(client.pingSentAt(nonce)).toBeNull();
    for (let nonce = 6; nonce <= 21; nonce += 1) expect(client.pingSentAt(nonce)).not.toBeNull();
    client.close("done");
    expect(client.pingSentAt(21)).toBeNull();
  });

  it("closes a session that stops hearing from its peer", async () => {
    const { a, b } = await socketPair(dir);
    const session = new LinkSession(a, { role: "host", pingIntervalMs: 0, idleTimeoutMs: 40 });
    sessions.push(session);
    session.open();
    const closed = await closedPromise(session);
    expect(closed.reason).toBe("idle timeout");
    b.destroy();
  });

  it("ends an idle link without a GOODBYE, so a peer that was only stalled can still resume the session", async () => {
    const { a, b } = await socketPair(dir);
    const frames = recordFrames(b);
    const session = new LinkSession(a, { role: "client", pingIntervalMs: 0, idleTimeoutMs: 40 });
    sessions.push(session);
    session.open();
    await expect(closedPromise(session)).resolves.toEqual({ reason: "idle timeout", by: "local" });
    await new Promise<void>((resolve) => b.once("end", resolve));
    expect(frames.filter((f) => f.kind === ControlKind.GOODBYE)).toEqual([]);
    b.destroy();
  });

  it("doesn't count time asleep toward the idle timeout", async () => {
    const { a, b } = await socketPair(dir);
    // The wall clock jumps ten minutes, as it does across a sleep, while the
    // process's own timers carry on from where they stopped.
    let jumpedAt: number | null = null;
    const slept = 600_000;
    const now = () => Date.now() + (jumpedAt === null ? 0 : slept);
    const awakeSince = (since: number) =>
      now() - since - (jumpedAt !== null && since < jumpedAt + slept ? slept : 0);
    const session = new LinkSession(a, {
      role: "client",
      pingIntervalMs: 0,
      idleTimeoutMs: 300,
      now,
      awakeSince,
    });
    sessions.push(session);
    session.open();
    jumpedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session.isOpen).toBe(true);
    // Awake and still silent: the window runs out as before.
    const closed = await closedPromise(session);
    expect(closed.reason).toBe("idle timeout");
    b.destroy();
  });

  it("drops a link whose peer doesn't answer a probe in time, without a GOODBYE", async () => {
    const { a, b } = await socketPair(dir);
    const frames = recordFrames(b);
    const session = new LinkSession(a, { role: "client", pingIntervalMs: 0, idleTimeoutMs: 0 });
    sessions.push(session);
    session.open();
    session.probe(30, "no answer after wake");
    await expect(closedPromise(session)).resolves.toEqual({
      reason: "no answer after wake",
      by: "local",
    });
    await new Promise<void>((resolve) => b.once("end", resolve));
    expect(frames.map((f) => f.kind)).toEqual([ControlKind.PING]);
    b.destroy();
  });

  it("keeps a link whose peer answers the probe", async () => {
    const { host, client } = await pair({}, { pingIntervalMs: 0, idleTimeoutMs: 0 });
    client.probe(250, "no answer after wake");
    await waitFor(() => client.rttMs !== null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(client.isOpen).toBe(true);
    expect(host.isOpen).toBe(true);
  });

  it("keeps hearing a peer whose frame arrives slower than the idle window, then gives up once it stops", async () => {
    const { a, b } = await socketPair(dir);
    const session = new LinkSession(a, { role: "host", pingIntervalMs: 0, idleTimeoutMs: 60 });
    sessions.push(session);
    session.open();
    // One frame, a byte every 15 ms: about 0.3 s for something the idle window would cut at 60 ms.
    const bytes = encodeFrame(
      messageToFrame({ lane: Lane.CONTROL, kind: ControlKind.PING, body: { sentAt: 1 } }),
      1024
    );
    let closedEarly = false;
    void closedPromise(session).then(() => (closedEarly = true));
    for (const byte of bytes) {
      b.write(Buffer.from([byte]));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(bytes.length * 15).toBeGreaterThan(120);
    expect(closedEarly).toBe(false);
    expect(session.isOpen).toBe(true);
    // Nothing more: the window runs out as before.
    const closed = await closedPromise(session);
    expect(closed.reason).toBe("idle timeout");
    b.destroy();
  });

  it("reads what the peer sent while this side's own loop was stalled before judging silence", async () => {
    const { a, b } = await socketPair(dir);
    const session = new LinkSession(a, { role: "host", pingIntervalMs: 0, idleTimeoutMs: 80 });
    sessions.push(session);
    session.open();
    let closed = false;
    void closedPromise(session).then(() => (closed = true));
    const ping = encodeFrame(
      messageToFrame({ lane: Lane.CONTROL, kind: ControlKind.PING, body: { sentAt: 1 } }),
      1024
    );
    // The peer spoke, but this loop is blocked past the idle window before it can read it.
    b.write(ping);
    const stalledUntil = Date.now() + 250;
    while (Date.now() < stalledUntil) {
      // a stalled main loop
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closed).toBe(false);
    expect(session.isOpen).toBe(true);
    b.destroy();
  });

  it("keeps a peer that has been silent for longer than a stall it can recover from", async () => {
    const { a, b } = await socketPair(dir);
    vi.useFakeTimers();
    try {
      let now = 0;
      const session = new LinkSession(a, { role: "client", pingIntervalMs: 0, now: () => now });
      sessions.push(session);
      session.open();
      const advance = (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
          now += 1_000;
          vi.advanceTimersByTime(1_000);
        }
      };
      // Two minutes of nothing: far longer than a host paging under pressure stalls.
      advance(120_000);
      expect(session.isOpen).toBe(true);
      // A peer stuck for good is still given up on, on the next check after that.
      advance(31_000);
      expect(session.closedWith).toEqual({ reason: "idle timeout", by: "local" });
      b.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up a client handshake without a GOODBYE, so a stalled host that reads the HELLO keeps what it resumed (#15877)", async () => {
    const { a, b } = await socketPair(dir);
    const frames = recordFrames(b);
    const session = new LinkSession(a, { role: "client", handshakeTimeoutMs: 30 });
    sessions.push(session);
    session.post({
      lane: Lane.CONTROL,
      kind: ControlKind.HELLO,
      body: {
        handshake: TEST_HANDSHAKE,
        token: "t",
        client: { clientId: "c", clientName: "n", platform: "linux" },
        resumeSessionId: "s-1",
        resumeSecret: "secret",
      },
    });
    await expect(closedPromise(session)).resolves.toEqual({
      reason: "handshake timed out",
      by: "local",
    });
    await new Promise<void>((resolve) => b.once("end", resolve));
    expect(frames.map((f) => f.kind)).toEqual([ControlKind.HELLO]);
    b.destroy();
  });

  it("tells a client that never said HELLO why the host gave up on it", async () => {
    const { a, b } = await socketPair(dir);
    const frames = recordFrames(b);
    const session = new LinkSession(a, { role: "host", handshakeTimeoutMs: 30 });
    sessions.push(session);
    await expect(closedPromise(session)).resolves.toEqual({
      reason: "handshake timed out",
      by: "local",
    });
    await new Promise<void>((resolve) => b.once("end", resolve));
    expect(frames.map((f) => frameToMessage(f))).toEqual([
      expect.objectContaining({
        kind: ControlKind.GOODBYE,
        body: { reason: "handshake timed out" },
      }),
    ]);
    b.destroy();
  });

  it("ends with a GOODBYE the peer sees as a remote close", async () => {
    const { host, client } = await pair();
    const closed = closedPromise(client);
    host.close("host shutting down");
    await expect(closed).resolves.toEqual({ reason: "host shutting down", by: "remote" });
  });
});

describe("LinkSession validation", () => {
  async function rawPeer(options: { open?: boolean; maxFrameBytes?: number } = {}) {
    const { a, b } = await socketPair(dir);
    const session = new LinkSession(a, {
      role: "host",
      pingIntervalMs: 0,
      idleTimeoutMs: 0,
      maxFrameBytes: options.maxFrameBytes,
    });
    sessions.push(session);
    if (options.open ?? true) session.open();
    const frames = recordFrames(b);
    return { session, raw: b, frames, closed: closedPromise(session) };
  }

  it("drops the session with a GOODBYE on an invalid body", async () => {
    const { raw, frames, closed } = await rawPeer();
    raw.write(
      encodeFrame({
        lane: Lane.RPC,
        kind: RpcKind.INVOKE,
        streamId: 0,
        payload: encodeValue({ requestId: "nope", channel: 5 }),
      })
    );
    expect((await closed).reason).toMatch(/protocol error/);
    await waitFor(() => frames.some((f) => f.kind === ControlKind.GOODBYE));
    const goodbye = frames.find((f) => f.lane === Lane.CONTROL && f.kind === ControlKind.GOODBYE)!;
    expect(frameToMessage(goodbye).body).toMatchObject({
      reason: expect.stringMatching(/invalid body/),
    });
  });

  it("kills the session on a frame larger than the cap", async () => {
    const { raw, closed } = await rawPeer({ maxFrameBytes: 1024 });
    const header = Buffer.alloc(10);
    header.writeUInt32BE(4096, 0);
    raw.write(header);
    expect((await closed).reason).toMatch(/invalid frame length/);
  });

  it("accepts nothing but the handshake before it is opened", async () => {
    const { raw, frames, closed, session } = await rawPeer({ open: false });
    session.onHandshake(() => {
      throw new Error("must not be called");
    });
    raw.write(
      encodeFrame(
        messageToFrame({ lane: Lane.CONTROL, kind: ControlKind.PING, body: { sentAt: 1 } })
      )
    );
    expect((await closed).reason).toMatch(/before handshake/);
    await waitFor(() => frames.some((f) => f.kind === ControlKind.GOODBYE));
  });

  it("rejects bulk chunks larger than the chunk size", async () => {
    const { raw, closed } = await rawPeer();
    raw.write(
      encodeFrame({
        lane: Lane.BULK,
        kind: BulkKind.TRANSFER_CHUNK,
        streamId: 3,
        payload: new Uint8Array(64 * 1024 + 1),
      })
    );
    expect((await closed).reason).toMatch(/transfer chunk/);
  });

  it("refuses to post anything but control traffic before the handshake", async () => {
    const { a } = await socketPair(dir);
    const session = new LinkSession(a, { role: "client", handshakeTimeoutMs: 0 });
    sessions.push(session);
    expect(
      session.post({
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: "x", args: [] },
      })
    ).toBe("refused");
    const env = await session.invoke("e", "x", []);
    expect(!env.ok && env.error.code).toBe("HOST_DISCONNECTED");
  });
});

describe("LinkSession lane priority", () => {
  it("writes an interactive frame ahead of bulk chunks already queued", async () => {
    const { a, b } = await socketPair(dir);
    const sender = new LinkSession(a, { role: "client", pingIntervalMs: 0, idleTimeoutMs: 0 });
    sessions.push(sender);
    sender.open();
    b.pause();

    const payload = new Uint8Array(8 * 1024 * 1024).fill(7);
    const transfer = sender.transfers.send(bytesTransferSource(payload), {
      name: "big.bin",
      destination: { kind: "inbox", bucket: "files" },
    });
    transfer.catch(() => {});
    // The socket stalls behind the paused reader; later chunks wait in the scheduler.
    await waitFor(() => sender.queuedBytes(Lane.BULK) > 0);
    sender.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_IN,
      body: { endpointId: "e1", message: { type: "write", data: "q" } },
    });

    const frames = recordFrames(b);
    b.resume();
    await waitFor(() => frames.some((f) => f.lane === Lane.INTERACTIVE));
    const interactiveAt = frames.findIndex((f) => f.lane === Lane.INTERACTIVE);
    await waitFor(() => frames.length > interactiveAt + 1);
    expect(frames.slice(interactiveAt + 1).some((f) => f.kind === BulkKind.TRANSFER_CHUNK)).toBe(
      true
    );
  });
});

describe("LinkSession endpoint closes (#15881)", () => {
  it("writes what an endpoint queued before its close ahead of it, and other control frames past it", async () => {
    const { host, client } = await pair();
    const arrived: string[] = [];
    host.setSendHandler((body) => arrived.push(`send:${body.channel}`));
    host.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_IN, () => arrived.push("input"));
    host.on(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, (body) =>
      arrived.push(`close:${body.endpointId}`)
    );
    host.on(Lane.CONTROL, ControlKind.ENDPOINT_OPEN, (body) =>
      arrived.push(`open:${body.endpointId}`)
    );

    // All before one flush, where the control lane would otherwise go first.
    client.send("e1", "commit", []);
    client.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_IN,
      body: { endpointId: "e1", message: { type: "write", data: "q" } },
    });
    client.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_CLOSE,
      body: { endpointId: "e1" },
    });
    client.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_OPEN,
      body: { endpointId: "e2", projectId: "p", openId: "o" },
    });

    await waitFor(() => arrived.length === 4);
    expect(arrived).toEqual(["open:e2", "input", "send:commit", "close:e1"]);
  });

  // The queued frame's own answer, when it has one, to wait for before the sessions close.
  it.each<[string, (client: LinkSession) => unknown, string?]>([
    [
      "terminal input",
      (client) =>
        client.post({
          lane: Lane.INTERACTIVE,
          kind: InteractiveKind.TERMINAL_IN,
          body: { endpointId: "e1", message: { type: "write", data: "q" } },
        }),
    ],
    [
      "a worktree port message",
      (client) =>
        client.post({
          lane: Lane.INTERACTIVE,
          kind: InteractiveKind.WORKTREE_PORT,
          body: { endpointId: "e1", message: { id: 1 } },
        }),
    ],
    ["an invoke", (client) => client.invoke("e1", "commit", [])],
    ["a call naming it", (client) => client.call("m", { endpointId: "e1" })],
    [
      "a call naming it last of several",
      (client) => client.call("m", { endpointIds: ["e2", "e1"] }),
    ],
    [
      "a call naming it first of several",
      (client) => client.call("m", { endpointIds: ["e2", "e1"] }),
      "e2",
    ],
    [
      "a call naming it beside another endpoint",
      (client) => client.call("m", { endpointId: "e2", endpointIds: ["e1"] }),
    ],
  ])("writes %s ahead of the endpoint's close", async (_kind, queue, closes = "e1") => {
    const { host, client } = await pair();
    const arrived: string[] = [];
    const record = () => void arrived.push("frame");
    host.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_IN, record);
    host.on(Lane.INTERACTIVE, InteractiveKind.WORKTREE_PORT, record);
    host.setInvokeHandler(async () => {
      record();
      return { __daintreeIpcEnvelope: true, ok: true, data: null };
    });
    host.registerCallHandler("m", z.unknown(), () => {
      record();
      return null;
    });
    host.on(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, () => arrived.push("close"));

    const answered = queue(client);
    client.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_CLOSE,
      body: { endpointId: closes },
    });

    await waitFor(() => arrived.length === 2);
    expect(arrived).toEqual(["frame", "close"]);
    await answered;
  });

  it("keeps a reopen under the same id behind the close it follows", async () => {
    const { host, client } = await pair();
    const arrived: string[] = [];
    host.setSendHandler(() => arrived.push("send"));
    host.on(Lane.CONTROL, ControlKind.ENDPOINT_CLOSE, () => arrived.push("close"));
    host.on(Lane.CONTROL, ControlKind.ENDPOINT_OPEN, () => arrived.push("open"));
    host.on(Lane.CONTROL, ControlKind.ENDPOINT_REBIND, () => arrived.push("rebind"));

    client.send("e1", "commit", []);
    client.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_CLOSE,
      body: { endpointId: "e1" },
    });
    client.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_OPEN,
      body: { endpointId: "e1", projectId: "p", openId: "o2" },
    });
    client.post({
      lane: Lane.CONTROL,
      kind: ControlKind.ENDPOINT_REBIND,
      body: { endpointId: "e1", projectId: "q" },
    });

    await waitFor(() => arrived.length === 4);
    expect(arrived).toEqual(["send", "close", "open", "rebind"]);
  });
});
