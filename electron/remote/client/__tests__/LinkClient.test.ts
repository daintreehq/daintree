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
