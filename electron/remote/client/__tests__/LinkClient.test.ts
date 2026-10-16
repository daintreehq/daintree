import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinkClient, type LinkClientState } from "../LinkClient.js";
import { logBuffer } from "../../../services/LogBuffer.js";
import {
  HostModeOffError,
  SshAccessError,
  UnusableConnectionError,
  TransportError,
  createDirectTransport,
  type LinkTransport,
} from "../transport.js";
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

function failingTransport(detail: string): LinkTransport & {
  opens: number;
  message: string;
  detail: string | (() => string);
  /** "access" fails as ssh refusing the login does, which stops the retries. */
  kind: "unreachable" | "access";
} {
  const t = {
    opens: 0,
    message: "unreachable",
    detail: detail as string | (() => string),
    kind: "unreachable" as "unreachable" | "access",
    async open() {
      t.opens++;
      const said = typeof t.detail === "function" ? t.detail() : t.detail;
      if (t.kind === "access") throw new SshAccessError(said);
      throw new TransportError(t.message, said);
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
      .map((s) => (s.retryAt ?? Number.NaN) - now);
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 20]);
    expect(states[0]).toEqual({ status: "connecting", attempt: 1 });
    expect(states[1]).toMatchObject({ status: "unreachable", detail: "Connection timed out" });
  });

  it("logs a host that stays down once, not on every retry, and again when what it sees changes", async () => {
    logBuffer.clear();
    const transport = failingTransport("Connection timed out");
    client = new LinkClient({
      hostId: "host-studio",
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
    });
    client.start();
    await waitFor(() => transport.opens >= 5);
    // What production's info floor keeps; the retries in between are debug.
    const lines = () =>
      logBuffer
        .getFiltered({ sources: ["main:LinkClient"] })
        .filter((entry) => entry.level !== "debug")
        .map((entry) => ({ message: entry.message, context: entry.context }));
    expect(lines()).toEqual([
      {
        message: "Dialling remote host",
        context: { hostId: "host-studio", attempt: 1, previousSessionId: null },
      },
      {
        message: "Remote host unreachable",
        context: {
          hostId: "host-studio",
          attempt: 1,
          previousSessionId: null,
          failure: "unreachable",
          detail: "Connection timed out",
          retryInMs: 1,
        },
      },
    ]);
    const failures = () => lines().filter((line) => line.message === "Remote host unreachable");

    // Only the per-attempt forward socket's nonce differs: still the same failure.
    let seenBefore = transport.opens;
    let nonce = 0;
    transport.detail = () =>
      `connect ENOENT /tmp/daintree/l-1a2b3c4d-${(++nonce).toString(16).padStart(8, "0")}.sock`;
    await waitFor(() => transport.opens >= seenBefore + 3);
    expect(failures()).toHaveLength(2);
    expect(failures().at(-1)?.context).toMatchObject({
      detail: expect.stringContaining("ENOENT /tmp/daintree/"),
    });

    // The same retrying failure, until ssh refuses the login and retrying stops: that is news.
    seenBefore = transport.opens;
    transport.message = "ssh couldn't log in to the host";
    transport.detail = "Permission denied (publickey).";
    await waitFor(() => transport.opens >= seenBefore + 3);
    expect(failures()).toHaveLength(3);
    transport.kind = "access";
    await waitFor(() => {
      const state = client!.getState();
      return state.status === "unreachable" && state.retryAt === null;
    });
    expect(failures()).toHaveLength(4);
    expect(failures().at(-1)?.context).toEqual({
      hostId: "host-studio",
      attempt: expect.any(Number),
      previousSessionId: null,
      failure: "ssh couldn't log in to the host",
      detail: "Permission denied (publickey).",
      stoppedRetrying: true,
    });
  });

  it("says when the host answered but Daintree there isn't in Host mode", async () => {
    const transport = {
      opens: 0,
      async open(): Promise<never> {
        transport.opens++;
        throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
      },
    };
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 1000, maxMs: 1000, jitter: 0 },
      random: () => 0,
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({
      status: "unreachable",
      hostModeOff: true,
      detail: "Daintree isn't running in Host mode there (no host.json).",
      // Trying again finds the same: it waits to be asked.
      retryAt: null,
    });
  });

  it("stops retrying when ssh can't log in, until asked to try again", async () => {
    const transport = {
      opens: 0,
      async open(): Promise<never> {
        transport.opens++;
        throw new SshAccessError("greg@studio: Permission denied (publickey).");
      },
    };
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
      random: () => 0,
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({ retryAt: null });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transport.opens).toBe(1);

    client.retryNow();
    await waitFor(() => transport.opens === 2);
    await waitFor(() => client!.getState().status === "unreachable");
    expect(transport.opens).toBe(2);
  });

  it("stops retrying a host this machine can't reach as set up (WSL missing, no such distro)", async () => {
    const transport = {
      opens: 0,
      async open(): Promise<never> {
        transport.opens++;
        throw new UnusableConnectionError(
          "Ubuntu isn't installed in WSL",
          "There is no distribution with the supplied name."
        );
      },
    };
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "win32" },
      backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
      random: () => 0,
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({
      retryAt: null,
      detail: "There is no distribution with the supplied name.",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(transport.opens).toBe(1);
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

describe("LinkClient host restart (#13392)", () => {
  it("keeps dialling a host it was just connected to while it restarts, and only parks once it's been gone a while", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "r.sock");
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
    // The link's own timestamps are wall clock, so the test moves time by an offset.
    let offset = 0;
    let hostModeOff = false;
    const direct = createDirectTransport({ socketPath, token: "t" });
    const transport: LinkTransport & { opens: number } = {
      opens: 0,
      async open(signal) {
        transport.opens++;
        // A restarting host removes host.json on the way down and writes it on the way up.
        if (hostModeOff) {
          throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
        }
        return direct.open(signal);
      },
    };
    try {
      client = new LinkClient({
        transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
        random: () => 0,
        now: () => Date.now() + offset,
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");

      hostModeOff = true;
      peer!.destroy();
      const opensAtDrop = transport.opens;
      await waitFor(() => transport.opens >= opensAtDrop + 3);
      expect(client.getState()).toMatchObject({
        status: "unreachable",
        hostModeOff: true,
        retryAt: expect.any(Number),
      });
      hostModeOff = false;
      await waitFor(() => client!.getState().status === "connected");

      // Down again, and still not in Host mode long after it was last heard from.
      hostModeOff = true;
      offset = 3 * 60_000;
      peer!.destroy();
      await waitFor(() => client!.getState().status === "unreachable");
      expect(client.getState()).toMatchObject({ hostModeOff: true, retryAt: null });
      const parkedAt = transport.opens;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(transport.opens).toBe(parkedAt);
    } finally {
      await client?.stop();
      server.close();
      await removeTempDir(dir);
    }
  });
});
