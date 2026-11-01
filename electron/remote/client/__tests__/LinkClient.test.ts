import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
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
import { fragmentFrame } from "../../link/messageFragments.js";
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

  it("reads a new link's Host mode off as a restart while the host was heard from moments ago", async () => {
    let now = 10 * 60_000;
    // An earlier link, released or from before this launch, heard it 30 s ago.
    const heard = now - 30_000;
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
      backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
      random: () => 0,
      now: () => now,
      lastSeenAt: () => heard,
    });
    client.start();
    await waitFor(() => transport.opens >= 3);
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({ hostModeOff: true, retryAt: expect.any(Number) });
    expect(client.restarting).toBe(true);

    // Two minutes on from when it was heard, the same answer is no longer a restart.
    now = heard + 2 * 60_000;
    await waitFor(() => {
      const state = client!.getState();
      return state.status === "unreachable" && state.retryAt === null;
    });
    expect(client.getState()).toMatchObject({ hostModeOff: true });
    expect(client.restarting).toBe(false);
    const parkedAt = transport.opens;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.opens).toBe(parkedAt);
  });

  it("parks a new link once the host was last heard from longer ago than a restart takes", async () => {
    const now = 10 * 60_000;
    const transport = {
      opens: 0,
      async open(): Promise<never> {
        transport.opens++;
        throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
      },
    };
    for (const lastSeenAt of [now - 2 * 60_000, now + 60 * 60_000]) {
      transport.opens = 0;
      client = new LinkClient({
        transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
        random: () => 0,
        now: () => now,
        // An hour ahead is a clock that moved back: it proves nothing about a restart.
        lastSeenAt: () => lastSeenAt,
      });
      client.start();
      await waitFor(() => client!.getState().status === "unreachable");
      expect(client.getState()).toMatchObject({ hostModeOff: true, retryAt: null });
      expect(client.restarting).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transport.opens).toBe(1);
      await client.stop();
    }
  });

  it("reads a host that said it was shutting down as restarting, and redials it quickly", async () => {
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
          socket.write(encodeFrame(messageToFrame(welcome)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    let down = false;
    const transport: LinkTransport & { opens: number } = {
      opens: 0,
      async open(signal) {
        transport.opens++;
        if (down) {
          throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
        }
        return direct.open(signal);
      },
    };
    // The session stamps what it hears on the real clock.
    const now = () => Date.now();
    const states: { state: LinkClientState; at: number }[] = [];
    try {
      client = new LinkClient({
        transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        // Far longer than the restart's own cap, so the cap is what's seen.
        backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
        random: () => 0,
        now,
        quietAfterMs: 0,
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      client.onStateChange((state) => states.push({ state, at: now() }));
      down = true;
      const goodbye: LinkMessage = {
        lane: Lane.CONTROL,
        kind: ControlKind.GOODBYE,
        body: { reason: "shutting-down" },
      };
      peer!.write(encodeFrame(messageToFrame(goodbye)));
      peer!.end();

      const hostModeOff = () =>
        states.find((s) => s.state.status === "unreachable" && s.state.hostModeOff);
      await waitFor(() => hostModeOff() !== undefined);
      // One variant throughout: every state on the way down says restarting.
      expect(states.every((s) => s.state.status !== "connected")).toBe(true);
      expect(states.filter((s) => !("restarting" in s.state))).toEqual([]);
      const unreachable = hostModeOff()!;
      expect(unreachable.state).toMatchObject({ restarting: true });
      const retryAt = unreachable.state.status === "unreachable" ? unreachable.state.retryAt! : 0;
      expect(retryAt - unreachable.at).toBeGreaterThan(900);
      expect(retryAt - unreachable.at).toBeLessThanOrEqual(1_000);
      expect(client.restartAnnounced).toBe(true);

      // Back up: the next dial connects, and the restart is over.
      down = false;
      await waitFor(() => client!.getState().status === "connected", 5_000);
      expect(client.restartAnnounced).toBe(false);
    } finally {
      await client?.stop();
      client = null;
      server.close();
      await removeTempDir(dir);
    }
  });

  it("reads a host refusing its first HELLO because it is shutting down as restarting, for one grace", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "s.sock");
    let refusals = 0;
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          refusals++;
          const reject: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.REJECT,
            body: { reason: "shutting-down", handshake: null, detail: null },
          };
          socket.write(encodeFrame(messageToFrame(reject)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let offset = 0;
    const now = () => Date.now() + offset;
    const restartingAfter = async (seen: number) => {
      await waitFor(() => refusals > seen && client!.getState().status === "unreachable");
      const state = client!.getState();
      return state.status === "unreachable" && state.restarting === true;
    };
    try {
      client = new LinkClient({
        transport: createDirectTransport({ socketPath, token: "t" }),
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
        now,
      });
      client.start();
      expect(await restartingAfter(0)).toBe(true);
      const state = client.getState();
      expect(state.status === "unreachable" && state.retryAt! - now()).toBeLessThanOrEqual(1_000);

      // Still refusing past the grace: the deadline ran from the first refusal.
      offset = 2 * 60_000;
      client.retryNow();
      expect(await restartingAfter(refusals)).toBe(false);

      // A stop ends the episode; the next run's refusal starts a new one.
      await client.stop();
      client.start();
      expect(await restartingAfter(refusals)).toBe(true);
    } finally {
      await client?.stop();
      client = null;
      server.close();
      await removeTempDir(dir);
    }
  });

  it("asks the transport not to start a host that said it is restarting, until the restart's grace is out", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "m.sock");
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const reject: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.REJECT,
            body: { reason: "shutting-down", handshake: null, detail: null },
          };
          socket.write(encodeFrame(messageToFrame(reject)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    const mayStart: Array<boolean | undefined> = [];
    const transport: LinkTransport = {
      async open(signal, options) {
        mayStart.push(options?.mayStart);
        // On its way down the host removed its discovery file.
        if (mayStart.length > 1) {
          throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
        }
        return direct.open(signal);
      },
    };
    let offset = 0;
    const now = () => Date.now() + offset;
    const failed = (dials: number) =>
      waitFor(() => mayStart.length >= dials && client!.getState().status === "unreachable");
    try {
      client = new LinkClient({
        transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
        now,
      });
      client.start();
      await failed(1);
      expect(client.restartAnnounced).toBe(true);
      // The restart's own one-second retries may dial in between: every one is held back too.
      for (let retry = 0; retry < 3; retry++) {
        const dialled = mayStart.length;
        client.retryNow();
        await failed(dialled + 1);
      }
      expect(mayStart[0]).toBe(true);
      expect(mayStart.length).toBeGreaterThanOrEqual(4);
      expect(mayStart.slice(1).every((value) => value === false)).toBe(true);

      // Not back within the grace: whatever is there now may be started.
      offset = 2 * 60_000;
      const before = mayStart.length;
      client.retryNow();
      await failed(before + 1);
      expect(mayStart[before]).toBe(true);
    } finally {
      await client?.stop();
      client = null;
      server.close();
      await removeTempDir(dir);
    }
  });

  it("hears a GOODBYE in place of the WELCOME and keeps retrying a fresh link through Host mode off", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "w.sock");
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const goodbye: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.GOODBYE,
            body: { reason: "shutting-down" },
          };
          socket.end(encodeFrame(messageToFrame(goodbye)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    const transport: LinkTransport & { opens: number } = {
      opens: 0,
      async open(signal) {
        transport.opens++;
        if (transport.opens > 1) {
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
        backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
      });
      client.start();
      await waitFor(() => {
        const state = client!.getState();
        return state.status === "unreachable" && state.hostModeOff === true;
      }, 5_000);
      // Never heard from before this link, so only the host's own word keeps it from parking.
      expect(client.getState()).toMatchObject({ restarting: true, retryAt: expect.any(Number) });
    } finally {
      await client?.stop();
      client = null;
      server.close();
      await removeTempDir(dir);
    }
  });

  it("stops reading a shutdown as a restart once the host has been gone longer than one takes", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "g.sock");
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
          socket.write(encodeFrame(messageToFrame(welcome)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    let down = false;
    const transport: LinkTransport = {
      async open(signal) {
        if (down) throw new TransportError("unreachable", "Connection refused");
        return direct.open(signal);
      },
    };
    let offset = 0;
    const now = () => Date.now() + offset;
    try {
      client = new LinkClient({
        transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
        backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
        random: () => 0,
        now,
        quietAfterMs: 0,
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      down = true;
      peer!.write(
        encodeFrame(
          messageToFrame({
            lane: Lane.CONTROL,
            kind: ControlKind.GOODBYE,
            body: { reason: "shutting-down" },
          })
        )
      );
      peer!.end();
      await waitFor(() => client!.getState().status === "unreachable");
      expect(client.getState()).toMatchObject({ restarting: true });

      offset = 2 * 60_000;
      client.retryNow();
      await waitFor(() => {
        const state = client!.getState();
        return state.status === "unreachable" && state.restarting === undefined;
      });
      const state = client.getState();
      expect(state.status === "unreachable" && state.retryAt! - now()).toBeGreaterThan(50_000);
      expect(client.restartAnnounced).toBe(false);
    } finally {
      await client?.stop();
      client = null;
      server.close();
      await removeTempDir(dir);
    }
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

describe("LinkClient message fragments (#15892)", () => {
  const BIG = "f".repeat(200_000);

  /**
   * A host in memory that answers HELLO with WELCOME and a fragmented event in
   * one push, so the client reads them all in a single chunk, before anything
   * has attached to the session.
   */
  function inMemoryHost(hostOffers: boolean) {
    const decoder = new FrameDecoder();
    const received: LinkFrame[] = [];
    const socket: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        for (const frame of decoder.push(chunk)) {
          received.push(frame);
          if (frame.lane !== Lane.CONTROL || frame.kind !== ControlKind.HELLO) continue;
          const welcome = messageToFrame({
            lane: Lane.CONTROL,
            kind: ControlKind.WELCOME,
            body: {
              handshake: TEST_HANDSHAKE,
              hostName: "h",
              sessionId: "s1",
              resumed: false,
              ...(hostOffers ? { messageFragments: true } : {}),
            },
          });
          const event = messageToFrame({
            lane: Lane.EVENTS,
            kind: EventKind.EVENT,
            body: { endpointId: null, channel: "x:big", args: [BIG] },
          });
          socket.push(
            Buffer.concat(
              [welcome, ...fragmentFrame(event, 1)].map((f) => Buffer.from(encodeFrame(f)))
            )
          );
        }
        callback();
      },
      // Ends when the client does, as a host closing its side would.
      final(callback) {
        socket.push(null);
        callback();
      },
    });
    const transport: LinkTransport = {
      async open() {
        return { socket, token: "t", dispose: async () => void socket.destroy() };
      },
    };
    return { transport, received };
  }

  it.each([
    ["a host that offers them", true],
    ["an older host that doesn't", false],
  ])(
    "offers them in its HELLO, holds them read with WELCOME, and sends them only to %s",
    async (_name, hostOffers) => {
      const host = inMemoryHost(hostOffers);
      const events: unknown[] = [];
      client = new LinkClient({
        transport: host.transport,
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      });
      client.onSession(({ session }) => {
        session.on(Lane.EVENTS, EventKind.EVENT, (body) => events.push(body));
        session.post({
          lane: Lane.EVENTS,
          kind: EventKind.EVENT,
          body: { endpointId: null, channel: "x:reply", args: [BIG] },
        });
      });
      client.start();
      await waitFor(() => events.length > 0);
      const hello = host.received.find((f) => f.kind === ControlKind.HELLO)!;
      expect(frameToMessage(hello).body).toMatchObject({ messageFragments: true });
      expect(events).toEqual([{ endpointId: null, channel: "x:big", args: [BIG] }]);

      await waitFor(() =>
        host.received.some((f) => f.lane === Lane.EVENTS && f.kind === EventKind.EVENT)
      );
      const sent = host.received.filter((f) => f.lane === Lane.EVENTS);
      if (hostOffers) {
        expect(sent.length).toBeGreaterThan(1);
        expect(sent.every((f) => f.streamId !== 0)).toBe(true);
      } else {
        expect(sent).toHaveLength(1);
        expect(frameToMessage(sent[0]!).body).toMatchObject({ channel: "x:reply" });
      }
    }
  );
});

describe("LinkClient stop", () => {
  /**
   * Every write leaves a moment late, so a GOODBYE is still queued when a
   * stop disposes the transport, which destroys its socket at once.
   */
  function slowTransport(socketPath: string): LinkTransport {
    return {
      async open() {
        const raw = net.connect(socketPath);
        await new Promise<void>((resolve, reject) => {
          raw.once("connect", resolve);
          raw.once("error", reject);
        });
        const socket = new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            setTimeout(() => raw.write(chunk, () => callback()), 20);
          },
          final(callback) {
            setTimeout(() => raw.end(callback), 20);
          },
          destroy(error, callback) {
            raw.destroy();
            callback(error);
          },
        });
        raw.on("data", (chunk) => socket.push(chunk));
        raw.on("end", () => socket.push(null));
        return { socket, token: "t", dispose: async () => void socket.destroy() };
      },
    };
  }

  it("lets its GOODBYE reach the host before letting go of a slow transport", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "h.sock");
    const seen: number[] = [];
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          seen.push(frame.kind);
          if (frame.kind === ControlKind.HELLO) {
            const welcome: LinkMessage = {
              lane: Lane.CONTROL,
              kind: ControlKind.WELCOME,
              body: { handshake: TEST_HANDSHAKE, hostName: "h", sessionId: "s1", resumed: false },
            };
            socket.write(encodeFrame(messageToFrame(welcome)));
          }
          // A host ends the link on a GOODBYE, as HostServer does.
          if (frame.kind === ControlKind.GOODBYE) socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      client = new LinkClient({
        transport: slowTransport(socketPath),
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      await client.stop();
      client = null;
      // A stop that has returned has let its GOODBYE reach the host.
      expect(seen).toContain(ControlKind.GOODBYE);
    } finally {
      server.close();
      await removeTempDir(dir);
    }
  });

  it("lets its GOODBYE reach the host before letting go of a slow transport, stopped mid-handshake (#15877)", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "h.sock");
    // A host that may already have resumed a session on the HELLO, and hasn't answered yet.
    const seen: number[] = [];
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          seen.push(frame.kind);
          if (frame.kind === ControlKind.GOODBYE) socket.end();
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      client = new LinkClient({
        transport: slowTransport(socketPath),
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      });
      client.start();
      await waitFor(() => seen.includes(ControlKind.HELLO));
      await client.stop();
      client = null;
      // A stop that has returned has let its GOODBYE reach the host.
      expect(seen).toContain(ControlKind.GOODBYE);
    } finally {
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

describe("LinkClient wake (#14365)", () => {
  it("dials at once on wake instead of waiting out the backoff", async () => {
    const transport = failingTransport("Network is unreachable");
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(transport.opens).toBe(1);
    client.noteSystemResumed();
    await waitFor(() => transport.opens === 2);
  });

  it("redials a session that doesn't answer after the wake, asking to resume it, with no GOODBYE", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "w.sock");
    const hellos: Array<{ resumeSessionId: string | null }> = [];
    const kinds: number[] = [];
    // Answers the handshake and nothing after it, as a link that died in the sleep.
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          kinds.push(frame.kind);
          if (frame.lane !== Lane.CONTROL || frame.kind !== ControlKind.HELLO) continue;
          const hello = frameToMessage(frame) as Extract<
            LinkMessage,
            { lane: typeof Lane.CONTROL; kind: typeof ControlKind.HELLO }
          >;
          hellos.push({ resumeSessionId: hello.body.resumeSessionId });
          const welcome: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.WELCOME,
            body: {
              handshake: TEST_HANDSHAKE,
              hostName: "h",
              sessionId: "s1",
              resumed: hellos.length > 1,
            },
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
        backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
        quietAfterMs: 0,
        wakeProbeMs: 30,
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      client.noteSystemResumed();
      await waitFor(() => hellos.length === 2);
      expect(hellos[1]).toEqual({ resumeSessionId: "s1" });
      expect(kinds).not.toContain(ControlKind.GOODBYE);
    } finally {
      await client?.stop();
      client = null;
      server.close();
      await removeTempDir(dir);
    }
  });
});

describe("LinkClient quiet across a sleep (#14365)", () => {
  it("doesn't report a link quiet for time the machine spent asleep", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "s.sock");
    const server = net.createServer((socket) => {
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
      // Silent host, and every moment since its last frame was spent asleep.
      client = new LinkClient({
        transport: createDirectTransport({ socketPath, token: "t" }),
        handshake: TEST_HANDSHAKE,
        client: { clientId: "c", clientName: "n", platform: "linux" },
        session: { pingIntervalMs: 0, idleTimeoutMs: 0, awakeSince: () => 0 },
        quietAfterMs: 40,
      });
      const quietSince: Array<number | null> = [];
      client.onStateChange((state) => {
        if (state.status === "connected") quietSince.push(state.quietSince);
      });
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(quietSince.every((at) => at === null)).toBe(true);
    } finally {
      await client?.stop();
      client = null;
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

describe("LinkClient host process (#14184)", () => {
  it("says the host restarted only when two WELCOMEs in a row name different processes", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "p.sock");
    // Each session's WELCOME, in order: a session that expired on the same
    // process, a restart, a host that names no process, then one that does.
    const launches: Array<string | undefined> = [
      "launch-a",
      "launch-a",
      "launch-b",
      undefined,
      "launch-c",
    ];
    let served = 0;
    let peer: net.Socket | null = null;
    const server = net.createServer((socket) => {
      peer = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const hostLaunchId = launches[served];
          served += 1;
          const welcome: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.WELCOME,
            body: {
              handshake: TEST_HANDSHAKE,
              hostName: "h",
              sessionId: `s${served}`,
              resumed: false,
              ...(hostLaunchId !== undefined && { hostLaunchId }),
            },
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
        backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
        random: () => 0,
      });
      const restarted: boolean[] = [];
      client.onSession(({ hostRestarted }) => restarted.push(hostRestarted));
      client.start();
      for (let session = 1; session <= launches.length; session += 1) {
        await waitFor(() => restarted.length === session);
        if (session < launches.length) peer!.destroy();
      }

      expect(restarted).toEqual([false, false, true, false, false]);
    } finally {
      await client?.stop();
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
      expect(client.restarting).toBe(true);
      hostModeOff = false;
      await waitFor(() => client!.getState().status === "connected");
      expect(client.restarting).toBe(false);

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

  it("stops reading a restart once something answers there, even one that refuses the link", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "r.sock");
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const reject: LinkMessage = {
            lane: Lane.CONTROL,
            kind: ControlKind.REJECT,
            body: { reason: "busy", handshake: null, detail: null },
          };
          socket.write(Buffer.from(encodeFrame(messageToFrame(reject))));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let hostModeOff = true;
    const direct = createDirectTransport({ socketPath, token: "t" });
    const transport: LinkTransport & { opens: number } = {
      opens: 0,
      async open(signal) {
        transport.opens++;
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
        lastSeenAt: () => Date.now() - 10_000,
      });
      client.start();
      await waitFor(() => client!.restarting);
      hostModeOff = false;
      await waitFor(() => {
        const state = client!.getState();
        return state.status === "unreachable" && state.detail?.includes("busy") === true;
      });
      expect(client.restarting).toBe(false);
    } finally {
      await client?.stop();
      server.close();
      await removeTempDir(dir);
    }
  });
});

describe("LinkClient retry during an attempt (#13926)", () => {
  it("leaves an attempt under way alone, and abandons it to start over when asked to restart", async () => {
    // An ssh that never hears back from the host: it ends when cancelled, or when the test fails it.
    const attempts: Array<{ signal: AbortSignal; fail: (error: Error) => void }> = [];
    const transport: LinkTransport = {
      open(signal) {
        return new Promise((_resolve, reject) => {
          attempts.push({ signal, fail: reject });
          signal.addEventListener("abort", () =>
            reject(new TransportError("Connection cancelled", null))
          );
        });
      },
    };
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 1_000, jitter: 0 },
      now: () => 0,
    });
    const seen: LinkClientState[] = [];
    client.onStateChange((state) => seen.push(state));
    client.start();
    await waitFor(() => attempts.length === 1);

    // Anything asking for the link while it dials doesn't cut a slow host off.
    client.retryNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.signal.aborted).toBe(false);

    client.retryNow({ restart: true });
    client.retryNow({ restart: true });
    await waitFor(() => attempts.length === 3);
    expect(attempts.map((attempt) => attempt.signal.aborted)).toEqual([true, true, false]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Abandoning an attempt is not a failure: nothing reports the host unreachable.
    expect(seen.map((state) => state.status)).toEqual(["connecting", "connecting", "connecting"]);
    expect(client.getState()).toEqual({ status: "connecting", attempt: 3 });

    // The first real failure backs off as a first failure: abandoned attempts didn't count.
    const said = "ssh: connect to host studio port 22: Operation timed out";
    attempts[2]!.fail(new TransportError("ssh failed", said));
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({ detail: said, retryAt: 1_000 });
  });

  it("lets go of a connection abandoned mid-handshake, once, and dials afresh", async () => {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "h.sock");
    // A host that reads HELLO and never answers it.
    const accepted: net.Socket[] = [];
    let hellos = 0;
    const goodbyes: number[] = [];
    const server = net.createServer((socket) => {
      const index = accepted.push(socket) - 1;
      goodbyes[index] = 0;
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === ControlKind.HELLO) hellos++;
          if (frame.kind === ControlKind.GOODBYE) goodbyes[index]!++;
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    const disposes: number[] = [];
    let opens = 0;
    const transport: LinkTransport = {
      async open(signal) {
        const index = opens++;
        disposes[index] = 0;
        const connection = await direct.open(signal);
        return {
          ...connection,
          dispose: async () => {
            disposes[index]!++;
            await connection.dispose();
          },
        };
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
      // Waiting on the host's answer to HELLO: past the transport, which the signal no longer reaches.
      await waitFor(() => hellos === 1);

      client.retryNow({ restart: true });
      await waitFor(() => hellos === 2);
      expect(disposes[0]).toBe(1);
      expect(client.getState()).toEqual({ status: "connecting", attempt: 2 });

      await client.stop();
      client = null;
      // Late enough for the abandoned handshakes to have settled and let go too.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(disposes).toEqual([1, 1]);
      // The host may have resumed a session on either HELLO: the restart leaves
      // it for the next dial, and only the stop ends it (#15877).
      await waitFor(() => goodbyes[1] === 1);
      expect(goodbyes).toEqual([0, 1]);
    } finally {
      await client?.stop();
      for (const socket of accepted) socket.destroy();
      server.close();
      await removeTempDir(dir);
    }
  });
});

describe("LinkClient connections opened from what earlier links learned (#15895)", () => {
  type Answer = "welcome" | "unauthorized" | "busy" | "close";

  /**
   * A host that answers each HELLO with the next of `answers` (the last one
   * repeats), reached by a transport whose opens are `remembered` unless the
   * dial asks for `fresh`. `holdFresh` keeps a fresh open waiting until its
   * dial is cancelled.
   */
  async function rememberingHost(answers: Answer[], options: { holdFresh?: boolean } = {}) {
    const dir = await makeTempDir();
    const socketPath = path.join(dir, "k.sock");
    let hellos = 0;
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== ControlKind.HELLO) continue;
          const answer = answers[Math.min(hellos, answers.length - 1)]!;
          hellos++;
          if (answer === "close") {
            socket.destroy();
            return;
          }
          const message: LinkMessage =
            answer === "welcome"
              ? {
                  lane: Lane.CONTROL,
                  kind: ControlKind.WELCOME,
                  body: {
                    handshake: TEST_HANDSHAKE,
                    hostName: "h",
                    sessionId: "s1",
                    resumed: false,
                  },
                }
              : {
                  lane: Lane.CONTROL,
                  kind: ControlKind.REJECT,
                  body: { reason: answer, handshake: null, detail: null },
                };
          socket.write(encodeFrame(messageToFrame(message)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const direct = createDirectTransport({ socketPath, token: "t" });
    const opens: boolean[] = [];
    const transport: LinkTransport = {
      async open(signal, openOptions) {
        const fresh = openOptions?.fresh === true;
        opens.push(fresh);
        if (fresh && options.holdFresh) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          throw new TransportError("Connection cancelled", null);
        }
        const connection = await direct.open(signal);
        return fresh ? connection : { ...connection, remembered: true as const };
      },
    };
    return {
      transport,
      opens,
      hellos: () => hellos,
      async close() {
        server.close();
        await removeTempDir(dir);
      },
    };
  }

  const linkOver = (transport: LinkTransport, states: LinkClientState[]) => {
    const link = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
      now: () => 1_000,
      quietAfterMs: 0,
    });
    link.onStateChange((state) => states.push(state));
    return link;
  };

  it("dials afresh within the same attempt when the host refuses the token it remembered", async () => {
    const host = await rememberingHost(["unauthorized", "welcome"]);
    const states: LinkClientState[] = [];
    try {
      client = linkOver(host.transport, states);
      client.start();
      await waitFor(() => client!.getState().status === "connected");
      expect(host.opens).toEqual([false, true]);
      // No failure in between, and no second attempt either.
      expect(states.some((state) => state.status === "unreachable")).toBe(false);
      expect(states.filter((state) => state.status === "connecting")).toEqual([
        { status: "connecting", attempt: 1 },
      ]);
    } finally {
      await client?.stop();
      client = null;
      await host.close();
    }
  });

  it("dials afresh once when a remembered link closes unanswered, then backs off as before", async () => {
    for (const answers of [["close"], ["unauthorized"]] as Answer[][]) {
      const host = await rememberingHost(answers);
      const states: LinkClientState[] = [];
      try {
        client = linkOver(host.transport, states);
        client.start();
        await waitFor(() => client!.getState().status === "unreachable");
        expect(host.opens).toEqual([false, true]);
        expect(client.getState()).toMatchObject({ retryAt: 61_000 });
        if (answers[0] === "unauthorized") {
          expect(client.getState()).toMatchObject({
            detail: "Host refused the connection: unauthorized",
          });
        }
      } finally {
        await client?.stop();
        client = null;
        await host.close();
      }
    }
  });

  it("takes any other refusal as the host's own answer", async () => {
    const host = await rememberingHost(["busy"]);
    const states: LinkClientState[] = [];
    try {
      client = linkOver(host.transport, states);
      client.start();
      await waitFor(() => client!.getState().status === "unreachable");
      expect(host.opens).toEqual([false]);
      expect(client.getState()).toMatchObject({ detail: "Host refused the connection: busy" });
    } finally {
      await client?.stop();
      client = null;
      await host.close();
    }
  });

  it("ends the attempt when stopped during the fresh dial", async () => {
    const host = await rememberingHost(["unauthorized"], { holdFresh: true });
    const states: LinkClientState[] = [];
    try {
      client = linkOver(host.transport, states);
      client.start();
      await waitFor(() => host.opens.length === 2);
      await client.stop();
      expect(client.getState()).toEqual({ status: "disconnected" });
      expect(host.opens).toEqual([false, true]);
      expect(states.some((state) => state.status === "unreachable")).toBe(false);
    } finally {
      await client?.stop();
      client = null;
      await host.close();
    }
  });

  it("dials afresh on a person's Retry, and only then", async () => {
    const fresh: Array<boolean | undefined> = [];
    const transport: LinkTransport = {
      async open(_signal, options) {
        fresh.push(options?.fresh);
        throw new TransportError("unreachable", "Connection timed out");
      },
    };
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c", clientName: "n", platform: "linux" },
      backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
    });
    client.start();
    await waitFor(() => fresh.length === 1 && client!.getState().status === "unreachable");
    client.retryNow({ restart: true });
    await waitFor(() => fresh.length === 2 && client!.getState().status === "unreachable");
    client.retryNow();
    await waitFor(() => fresh.length === 3 && client!.getState().status === "unreachable");
    expect(fresh).toEqual([undefined, true, undefined]);
  });
});
