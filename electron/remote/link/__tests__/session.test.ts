import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("settles every pending request with HOST_DISCONNECTED when the session dies", async () => {
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
      expect(call).rejects.toMatchObject({ code: "HOST_DISCONNECTED" }),
      expect(reverse).rejects.toMatchObject({ code: "HOST_DISCONNECTED" }),
    ]);
    expect(!env.ok && env.error.code).toBe("HOST_DISCONNECTED");
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
    host.registerCallHandler("hang", z.unknown(), () => new Promise(() => {}));
    const ac = new AbortController();
    const p = client.call("hang", null, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(client.call("hang", null, { signal: ac.signal })).rejects.toMatchObject({
      code: "CANCELLED",
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

  it("closes a session that stops hearing from its peer", async () => {
    const { a, b } = await socketPair(dir);
    const session = new LinkSession(a, { role: "host", pingIntervalMs: 0, idleTimeoutMs: 40 });
    sessions.push(session);
    session.open();
    const closed = await closedPromise(session);
    expect(closed.reason).toBe("idle timeout");
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
