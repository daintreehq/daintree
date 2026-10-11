import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkClient, type LinkClientState } from "../LinkClient.js";
import { TransportError, createDirectTransport, type LinkTransport } from "../transport.js";
import { FrameDecoder, Lane, encodeFrame, type LinkFrame } from "../../link/frames.js";
import {
  ControlKind,
  EventKind,
  RpcKind,
  frameToMessage,
  messageToFrame,
  type LinkMessage,
} from "../../link/messages.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";

let client: LinkClient | null = null;

afterEach(async () => {
  await client?.stop();
  client = null;
});

function failingTransport(detail: string): LinkTransport & { opens: number } {
  const t = {
    opens: 0,
    async open() {
      t.opens++;
      throw new TransportError("unreachable", detail);
    },
  };
  return t;
}

describe("LinkClient backoff", () => {
  it("retries with capped exponential backoff and reports what it saw", async () => {
    const transport = failingTransport("Connection timed out");
    const now = 1_000;
    const states: LinkClientState[] = [];
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 5, maxMs: 20, jitter: 0.5 },
      random: () => 0,
      now: () => now,
    });
    client.onStateChange((s) => states.push(s));
    client.start();
    await waitFor(() => transport.opens >= 5);
    const delays = states
      .filter(
        (s): s is Extract<LinkClientState, { status: "unreachable" }> => s.status === "unreachable"
      )
      .map((s) => s.retryAt - now);
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 20]);
    expect(states[0]).toEqual({ status: "connecting", attempt: 1 });
    expect(states[1]).toMatchObject({ status: "unreachable", detail: "Connection timed out" });
  });

  it("applies jitter below the base delay", async () => {
    const transport = failingTransport("x");
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 1_000, jitter: 0.5 },
      random: () => 1,
      now: () => 0,
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({ retryAt: 500 });
  });

  it("stops retrying and returns to disconnected on stop", async () => {
    const transport = failingTransport("x");
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 5 },
    });
    client.start();
    await waitFor(() => transport.opens >= 2);
    await client.stop();
    const opens = transport.opens;
    await new Promise((r) => setTimeout(r, 40));
    expect(transport.opens).toBe(opens);
    expect(client.getState()).toEqual({ status: "disconnected" });
  });
});

describe("LinkClient session start", () => {
  it("delivers frames coalesced with WELCOME to handlers attached in onSession", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "h.sock");
    const received: LinkFrame[] = [];
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      let welcomed = false;
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          received.push(frame);
          if (welcomed || frame.kind !== ControlKind.HELLO) continue;
          welcomed = true;
          const messages: LinkMessage[] = [
            {
              lane: Lane.CONTROL,
              kind: ControlKind.WELCOME,
              body: { handshake: TEST_HANDSHAKE, hostName: "h", sessionId: "s1", resumed: false },
            },
            {
              lane: Lane.EVENTS,
              kind: EventKind.EVENT,
              body: { endpointId: null, channel: "x:event", args: [1] },
            },
            {
              lane: Lane.RPC,
              kind: RpcKind.REVERSE_REQUEST,
              body: { requestId: 7, endpointId: "e1", method: "ask", payload: 2 },
            },
          ];
          // One write, so the client reads all three in the same chunk.
          socket.write(
            Buffer.concat(messages.map((m) => Buffer.from(encodeFrame(messageToFrame(m)))))
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const events: unknown[] = [];
      client = new LinkClient({
        transport: createDirectTransport({ socketPath, token: "t" }),
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      });
      client.onSession(({ session }) => {
        session.on(Lane.EVENTS, EventKind.EVENT, (body) => events.push(body));
        session.setReverseRequestHandler(async (msg) => ({ answered: msg.payload }));
      });
      client.start();
      await waitFor(() => received.some((f) => f.kind === RpcKind.REVERSE_RESULT));
      expect(events).toEqual([{ endpointId: null, channel: "x:event", args: [1] }]);
      const result = frameToMessage(received.find((f) => f.kind === RpcKind.REVERSE_RESULT)!);
      expect(result.body).toMatchObject({
        requestId: 7,
        envelope: { ok: true, data: { answered: 2 } },
      });
    } finally {
      await client?.stop();
      server.close();
      await removeTempDir(dir);
    }
  });
});

describe("LinkClient quiet link", () => {
  it("reports when the host last spoke once it goes quiet, and clears it when it speaks again", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "q.sock");
    let peer: net.Socket | null = null;
    const server = net.createServer((socket) => {
      peer = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const welcome: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.WELCOME,
            body: { handshake: TEST_HANDSHAKE, hostName: "h", sessionId: "s1", resumed: false },
          };
          socket.write(Buffer.from(encodeFrame(messageToFrame(welcome))));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      client = new LinkClient({
        transport: createDirectTransport({ socketPath, token: "t" }),
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        quietAfterMs: 200,
      });
      // Every report, since a cleared quiet only lasts until the silence runs long again.
      const quietSince: Array<number | null> = [];
      client.onStateChange((state) => {
        if (state.status === "connected") quietSince.push(state.quietSince);
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      expect(client.getState()).toMatchObject({ quietSince: null });
      await waitFor(() => quietSince.some((at) => at !== null));
      const heard = client.session!.lastReceivedAt;
      expect(quietSince.find((at) => at !== null)).toBe(heard);
      const reports = quietSince.length;

      const event: LinkMessage = {
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: "x:event", args: [] },
      };
      peer!.write(Buffer.from(encodeFrame(messageToFrame(event))));
      await waitFor(() => quietSince.slice(reports).includes(null));
    } finally {
      await client?.stop();
      server.close();
      await removeTempDir(dir);
    }
  });
});

describe("LinkClient session loss", () => {
  it("stops reading as connected the moment its session closes, before the old forward is released", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "d.sock");
    let peer: net.Socket | null = null;
    const server = net.createServer((socket) => {
      peer = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const welcome: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.WELCOME,
            body: { handshake: TEST_HANDSHAKE, hostName: "h", sessionId: "s1", resumed: false },
          };
          socket.write(Buffer.from(encodeFrame(messageToFrame(welcome))));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    let opens = 0;
    // A forward whose release hangs, as an ssh forward does through a stalled master.
    const transport: LinkTransport = {
      async open(signal) {
        opens++;
        const connection = await direct.open(signal);
        return { ...connection, dispose: () => new Promise<void>(() => {}) };
      },
    };
    try {
      client = new LinkClient({
        transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        quietAfterMs: 0,
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      // Something from the host after the WELCOME, later than anything the client noted.
      const welcomedAt = client.session!.lastReceivedAt;
      await new Promise((resolve) => setTimeout(resolve, 15));
      const event: LinkMessage = {
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: "x:event", args: [] },
      };
      peer!.write(Buffer.from(encodeFrame(messageToFrame(event))));
      await waitFor(() => client!.session!.lastReceivedAt > welcomedAt);
      const lastFrameAt = client.session!.lastReceivedAt;
      // Whoever hears the drop reads when the host was last heard from, as of then.
      let seenAtDrop: number | null = null;
      client.onStateChange((state) => {
        if (state.status === "connecting") seenAtDrop = client!.lastSeen;
      });
      peer!.destroy();
      await waitFor(() => client!.getState().status !== "connected");
      expect(client.getState()).toEqual({ status: "connecting", attempt: 1 });
      expect(seenAtDrop).toBe(lastFrameAt);
      // Still waiting on the release: no second attempt has started.
      expect(opens).toBe(1);
    } finally {
      const stopping = client?.stop();
      client = null;
      void stopping;
      server.close();
      await removeTempDir(dir);
    }
  });
});
