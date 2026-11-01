import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder, Lane, type LinkFrame } from "../../link/frames.js";
import {
  ControlKind,
  EventKind,
  frameToMessage,
  messageToFrame,
  type LinkMessage,
} from "../../link/messages.js";
import { LinkClient, type LinkClientState } from "../../client/LinkClient.js";
import { createDirectTransport, type LinkTransport } from "../../client/transport.js";
import { HostServer, MAX_PENDING_HANDSHAKES, type HostSessionContext } from "../HostServer.js";
import { HANDSHAKE_MAX_FRAME_BYTES } from "../../link/session.js";
import {
  SocketPathTooLongError,
  hostSocketLocation,
  type HostSocketLocation,
} from "../hostSocketPath.js";
import { readDiscoveryFile, removeDiscoveryFile, writeDiscoveryFile } from "../discoveryFile.js";
import { processStartTime } from "../hostSocketLock.js";
import { logBuffer } from "../../../services/LogBuffer.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";

let root: string;
let location: HostSocketLocation;
const servers: HostServer[] = [];
const clients: LinkClient[] = [];
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  logBuffer.clear();
  root = await makeTempDir();
  location = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "ud") });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) await c.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
  await removeTempDir(root);
});

async function startServer(overrides: Partial<ConstructorParameters<typeof HostServer>[0]> = {}) {
  const server = new HostServer({
    location,
    handshake: TEST_HANDSHAKE,
    hostName: "studio-01",
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    ...overrides,
  });
  servers.push(server);
  await server.listen();
  return server;
}

function startClient(
  server: HostServer,
  overrides: Partial<ConstructorParameters<typeof LinkClient>[0]> = {}
) {
  const client = new LinkClient({
    transport: createDirectTransport({ discoveryPath: location.discoveryPath }),
    handshake: TEST_HANDSHAKE,
    client: { clientId: "client-a", clientName: "greg-mbp", platform: "darwin" },
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    backoff: { initialMs: 10, maxMs: 50 },
    ...overrides,
  });
  clients.push(client);
  client.start();
  void server;
  return client;
}

async function rawConnect(): Promise<{ socket: net.Socket; frames: LinkFrame[] }> {
  const socket = net.connect(location.socketPath);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const decoder = new FrameDecoder();
  const frames: LinkFrame[] = [];
  socket.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  return { socket, frames };
}

async function rawHello(token: string, clientId: string) {
  const raw = await rawConnect();
  raw.socket.write(
    encodeFrame(
      messageToFrame({
        lane: Lane.CONTROL,
        kind: ControlKind.HELLO,
        body: {
          handshake: TEST_HANDSHAKE,
          token,
          client: { clientId, clientName: "n", platform: "linux" },
          resumeSessionId: null,
        },
      })
    )
  );
  return raw;
}

/** A HELLO from a hand-driven client, resuming `resume` when given; resolves with its WELCOME. */
async function helloOn(
  server: HostServer,
  clientId: string,
  resume: { id: string; secret: string } | null,
  deviceId?: string
) {
  const raw = await rawConnect();
  raw.socket.write(
    encodeFrame(
      messageToFrame({
        lane: Lane.CONTROL,
        kind: ControlKind.HELLO,
        body: {
          handshake: TEST_HANDSHAKE,
          token: server.token,
          client: {
            clientId,
            clientName: "n",
            platform: "linux",
            ...(deviceId ? { deviceId } : {}),
          },
          resumeSessionId: resume?.id ?? null,
          resumeSecret: resume?.secret ?? null,
        },
      })
    )
  );
  await waitFor(() => raw.frames.some((f) => frameToMessage(f)?.kind === ControlKind.WELCOME));
  const welcome = raw.frames
    .map((frame) => frameToMessage(frame))
    .find((m) => m?.kind === ControlKind.WELCOME)!.body as {
    sessionId: string;
    resumed: boolean;
    resumeSecret: string;
  };
  return { raw, welcome };
}

/** What a logger wrote, in order, as daintree.log keeps it at production's info floor. */
function logged(source: string): Array<{ message: string; context: unknown }> {
  return logBuffer
    .getFiltered({ sources: [source] })
    .filter((entry) => entry.level !== "debug")
    .map((entry) => ({ message: entry.message, context: entry.context }));
}

/** Something from the client after its WELCOME, as any live Shell soon sends. */
function ping(raw: { socket: net.Socket }): void {
  raw.socket.write(
    encodeFrame(
      messageToFrame({ lane: Lane.CONTROL, kind: ControlKind.PING, body: { sentAt: Date.now() } })
    )
  );
}

function closedSocket(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
}

/**
 * Dials the host directly, except that after `stall()` the next dial reaches a
 * host stalled under memory pressure: what the Shell sends sits unread until
 * `deliver()`, then reaches the host in the order it was sent, its end
 * included. Dials after the stalled one wait for `resume()`.
 */
async function stallingTransport() {
  const direct = createDirectTransport({ discoveryPath: location.discoveryPath });
  const proxyPath = path.join(root, "stall.sock");
  const sockets: net.Socket[] = [];
  let held: { chunks: Buffer[]; ended: boolean } | null = null;
  const proxy = net.createServer((socket) => {
    sockets.push(socket);
    const entry = { chunks: [] as Buffer[], ended: false };
    held = entry;
    socket.on("data", (chunk: Buffer) => entry.chunks.push(chunk));
    socket.on("end", () => (entry.ended = true));
    socket.on("error", () => {});
  });
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  await new Promise<void>((resolve) => proxy.listen(proxyPath, resolve));
  let stallNext = false;
  let lastStalled = false;
  let resumed: Promise<void> = Promise.resolve();
  let resume = () => {};
  const transport: LinkTransport = {
    async open(signal) {
      lastStalled = stallNext;
      if (stallNext) {
        stallNext = false;
        const info = (await readDiscoveryFile(location.discoveryPath))!;
        return createDirectTransport({ socketPath: proxyPath, token: info.token }).open(signal);
      }
      await new Promise<void>((resolve, reject) => {
        void resumed.then(resolve);
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      return direct.open(signal);
    },
  };
  return {
    transport,
    stall() {
      stallNext = true;
      resumed = new Promise((resolve) => (resume = resolve));
    },
    /** Whether the latest dial is the one that reaches the stalled host. */
    lastDialStalled: () => lastStalled,
    /** What the stalled dial has sent so far. */
    sent(): LinkMessage[] {
      const decoder = new FrameDecoder();
      return (held?.chunks ?? []).flatMap((chunk) =>
        decoder.push(chunk).map((frame) => frameToMessage(frame)!)
      );
    },
    /** The Shell has closed its end of the stalled dial. */
    abandoned: () => held?.ended === true,
    /** The host catches up on the stalled dial and reads it to its end. */
    async deliver() {
      const entry = held!;
      const upstream = net.connect(location.socketPath);
      sockets.push(upstream);
      upstream.on("error", () => {});
      upstream.resume();
      await new Promise<void>((resolve) => upstream.once("connect", resolve));
      for (const chunk of entry.chunks) upstream.write(chunk);
      if (entry.ended) upstream.end();
      await closedSocket(upstream);
    },
    /** Dials after the stalled one go. */
    resume: () => resume(),
  };
}

describe("HostServer socket and discovery", () => {
  it("binds an owner-only socket and advertises it in an owner-only discovery file", async () => {
    const server = await startServer();
    expect((await fs.stat(location.dir)).mode & 0o777).toBe(0o700);
    const sock = await fs.lstat(location.socketPath);
    expect(sock.isSocket()).toBe(true);
    expect(sock.mode & 0o777).toBe(0o600);
    expect((await fs.stat(location.discoveryPath)).mode & 0o777).toBe(0o600);
    const info = await readDiscoveryFile(location.discoveryPath);
    expect(info).toEqual({
      version: 1,
      socketPath: location.socketPath,
      token: server.token,
      pid: process.pid,
      ...(info?.startedAt && { startedAt: info.startedAt }),
    });
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(info?.startedAt).toBe(processStartTime(process.pid)?.replace(/\s+/g, " "));
    }
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("removes the discovery file on close only while it carries this launch's token", async () => {
    const server = await startServer();
    await server.close();
    await expect(fs.stat(location.discoveryPath)).rejects.toThrow();
    await expect(fs.stat(location.socketPath)).rejects.toThrow();

    const other = { version: 1 as const, socketPath: "/x.sock", token: "b".repeat(64), pid: 1 };
    const second = await startServer();
    await writeDiscoveryFile(location.discoveryPath, other);
    await second.close();
    expect(await readDiscoveryFile(location.discoveryPath)).toEqual(other);
    expect(await removeDiscoveryFile(location.discoveryPath, "a".repeat(64))).toBe(false);
    expect(await removeDiscoveryFile(location.discoveryPath, other.token)).toBe(true);
  });

  it("replaces a stale socket but refuses one a live process is serving", async () => {
    await fs.mkdir(location.dir, { recursive: true });
    // A process killed outright leaves its socket file behind with nothing listening.
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(location.socketPath)}); setInterval(() => {}, 1000);`,
    ]);
    await waitFor(() => existsSync(location.socketPath));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect((await fs.lstat(location.socketPath)).isSocket()).toBe(true);
    const server = await startServer();
    await server.close();

    const live = net.createServer();
    await new Promise<void>((r) => live.listen(location.socketPath, r));
    const blocked = new HostServer({ location, handshake: TEST_HANDSHAKE, hostName: "h" });
    await expect(blocked.listen()).rejects.toThrow(/already listening/);
    await new Promise<void>((r) => live.close(() => r()));

    await fs.writeFile(location.socketPath, "not a socket");
    await expect(blocked.listen()).rejects.toThrow(/not a socket/);
  });

  it("lets exactly one of two concurrent starts take over a stale socket", async () => {
    await fs.mkdir(location.dir, { recursive: true });
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(location.socketPath)}); setInterval(() => {}, 1000);`,
    ]);
    await waitFor(() => existsSync(location.socketPath));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    const make = () => {
      const s = new HostServer({ location, handshake: TEST_HANDSHAKE, hostName: "h" });
      servers.push(s);
      return s;
    };
    const a = make();
    const b = make();
    const results = await Promise.allSettled([a.listen(), b.listen()]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0]!.reason)).toMatch(/already listening/);

    const winner = results[0]!.status === "fulfilled" ? a : b;
    expect(winner.isListening).toBe(true);
    expect((await readDiscoveryFile(location.discoveryPath))?.token).toBe(winner.token);
    const probe = net.connect(location.socketPath);
    await new Promise<void>((resolve, reject) => {
      probe.once("connect", resolve);
      probe.once("error", reject);
    });
    probe.destroy();
    expect(existsSync(`${location.socketPath}.lock`)).toBe(false);
  });

  it("fails clearly when the socket path exceeds the platform limit", async () => {
    const long = hostSocketLocation({
      platform: "darwin",
      userDataDir: path.join(root, "x".repeat(120)),
    });
    const server = new HostServer({ location: long, handshake: TEST_HANDSHAKE, hostName: "h" });
    await expect(server.listen()).rejects.toBeInstanceOf(SocketPathTooLongError);
  });
});

describe("HostServer authentication", () => {
  it("accepts a client with the token and a matching build", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server);
    await waitFor(() => client.getState().status === "connected");
    expect(client.getState()).toMatchObject({
      status: "connected",
      hostName: "studio-01",
      handshake: TEST_HANDSHAKE,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      resumed: false,
      client: { clientId: "client-a", clientName: "greg-mbp" },
    });

    seen[0]!.session.setInvokeHandler(async (msg) => ({
      __daintreeIpcEnvelope: true,
      ok: true,
      data: msg.channel,
    }));
    const env = await client.session!.invoke("e1", "project:get-all", []);
    expect(env).toEqual({ __daintreeIpcEnvelope: true, ok: true, data: "project:get-all" });
  });

  it.each([
    ["a Shell that offers them", true],
    ["an older Shell that doesn't", false],
  ])(
    "offers message fragments in its WELCOME and sends them only to %s (#15892)",
    async (_name, shellOffers) => {
      const server = await startServer();
      const seen: HostSessionContext[] = [];
      server.onSession((ctx) => seen.push(ctx));
      const raw = await rawConnect();
      raw.socket.write(
        encodeFrame(
          messageToFrame({
            lane: Lane.CONTROL,
            kind: ControlKind.HELLO,
            body: {
              handshake: TEST_HANDSHAKE,
              token: server.token,
              client: { clientId: "c-frag", clientName: "n", platform: "linux" },
              resumeSessionId: null,
              ...(shellOffers ? { messageFragments: true } : {}),
            },
          })
        )
      );
      await waitFor(() =>
        raw.frames.some((f) => f.lane === Lane.CONTROL && f.kind === ControlKind.WELCOME)
      );
      expect(seen).toHaveLength(1);
      const welcome = raw.frames
        .map((frame) => frameToMessage(frame))
        .find((m) => m.kind === ControlKind.WELCOME)!;
      expect(welcome.body).toMatchObject({ messageFragments: true });

      const big = "r".repeat(200_000);
      seen[0]!.session.post({
        lane: Lane.EVENTS,
        kind: EventKind.EVENT,
        body: { endpointId: null, channel: "x:big", args: [big] },
      });
      await waitFor(() =>
        raw.frames.some((f) => f.lane === Lane.EVENTS && f.kind === EventKind.EVENT)
      );
      const events = raw.frames.filter((f) => f.lane === Lane.EVENTS);
      if (shellOffers) {
        expect(events.length).toBeGreaterThan(1);
        expect(events.every((f) => f.streamId !== 0)).toBe(true);
      } else {
        expect(events).toHaveLength(1);
        expect(frameToMessage(events[0]!).body).toMatchObject({ args: [big] });
      }
      raw.socket.destroy();
    }
  );

  it("logs a Shell retrying into the same refusal once, and again after it gets a session", async () => {
    const server = await startServer();
    const refusals = () =>
      logged("main:HostServer").filter(
        (entry) => entry.message === "Remote Shell refused at handshake"
      );
    for (let i = 0; i < 3; i++) {
      const raw = await rawHello("f".repeat(64), "c1");
      await closedSocket(raw.socket);
    }
    expect(refusals()).toEqual([
      {
        message: "Remote Shell refused at handshake",
        context: {
          reason: "unauthorized",
          clientId: "c1",
          clientName: "n",
          requestedSessionId: null,
        },
      },
    ]);

    const accepted = await rawHello(server.token, "c1");
    await waitFor(() => server.sessions.length === 1);
    const again = await rawHello("f".repeat(64), "c1");
    await closedSocket(again.socket);
    expect(refusals()).toHaveLength(2);
    expect(JSON.stringify(logged("main:HostServer"))).not.toContain(server.token);
    accepted.socket.destroy();
  });

  it("rejects a wrong token as unauthorized and never exposes the session", async () => {
    const server = await startServer();
    const seen: unknown[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server, {
      transport: createDirectTransport({ socketPath: location.socketPath, token: "f".repeat(64) }),
    });
    await waitFor(() => client.getState().status === "unreachable");
    const state = client.getState() as Extract<LinkClientState, { status: "unreachable" }>;
    expect(state.detail).toMatch(/unauthorized/);
    expect(seen).toHaveLength(0);
  });

  it("drops a HELLO with a missing token and anything sent before HELLO", async () => {
    const server = await startServer();
    const seen: unknown[] = [];
    server.onSession((ctx) => seen.push(ctx));

    const badToken = await rawConnect();
    badToken.socket.write(
      encodeFrame(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.HELLO,
          body: {
            handshake: TEST_HANDSHAKE,
            token: "x",
            client: { clientId: "c", clientName: "n", platform: "linux" },
            resumeSessionId: null,
          },
        })
      )
    );
    await closedSocket(badToken.socket);
    expect(badToken.frames.map((f) => frameToMessage(f).body)).toContainEqual({
      reason: "unauthorized",
      handshake: null,
      detail: null,
    });

    const missing = await rawConnect();
    const { encodeValue } = await import("../../link/encoding.js");
    missing.socket.write(
      encodeFrame({
        lane: Lane.CONTROL,
        kind: ControlKind.HELLO,
        streamId: 0,
        payload: encodeValue({
          handshake: TEST_HANDSHAKE,
          client: { clientId: "c", clientName: "n", platform: "linux" },
          resumeSessionId: null,
        }),
      })
    );
    await closedSocket(missing.socket);
    expect(missing.frames.some((f) => f.kind === ControlKind.GOODBYE)).toBe(true);

    const early = await rawConnect();
    early.socket.write(
      encodeFrame(
        messageToFrame({
          lane: Lane.RPC,
          kind: 3,
          body: { endpointId: "e", channel: "x", args: [] },
        })
      )
    );
    await closedSocket(early.socket);
    expect(early.frames.some((f) => f.kind === ControlKind.GOODBYE)).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("lets a different version or commit in, and the client carries the difference", async () => {
    const server = await startServer();
    const other = { ...TEST_HANDSHAKE, commit: "def456" };
    const client = startClient(server, { handshake: other });
    await waitFor(() => client.getState().status === "connected");
    expect(client.getState()).toMatchObject({
      status: "connected",
      handshake: TEST_HANDSHAKE,
      buildMismatch: { kind: "commit", local: "def456", remote: "abc123" },
    });
  });

  it("rejects a different wire protocol and the client reports the mismatch without retrying", async () => {
    const server = await startServer();
    const other = { ...TEST_HANDSHAKE, protocolVersion: TEST_HANDSHAKE.protocolVersion + 1 };
    let attempts = 0;
    const client = startClient(server, { handshake: other });
    client.onStateChange((s) => {
      if (s.status === "connecting") attempts++;
    });
    await waitFor(() => client.getState().status === "version-mismatch");
    expect(client.getState()).toEqual({
      status: "version-mismatch",
      mismatch: {
        kind: "protocol",
        local: other.protocolVersion,
        remote: TEST_HANDSHAKE.protocolVersion,
      },
      local: other,
      remote: TEST_HANDSHAKE,
      // This server wasn't given a way to see its agents, so it says nothing about them.
      observed: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(client.getState().status).toBe("version-mismatch");
    expect(attempts).toBe(0);
  });

  it("tells a client on another protocol what its agents are doing, fresh on every handshake", async () => {
    let working: number | null = 2;
    const server = await startServer({ observeWorkingAgents: async () => working });
    const client = startClient(server, {
      handshake: { ...TEST_HANDSHAKE, protocolVersion: TEST_HANDSHAKE.protocolVersion + 1 },
    });
    await waitFor(() => client.getState().status === "version-mismatch");
    const first = client.getState();
    expect(first).toMatchObject({ observed: { workingAgents: 2 } });

    working = 0;
    client.retryNow();
    await waitFor(() => {
      const state = client.getState();
      return state.status === "version-mismatch" && state.observed?.workingAgents === 0;
    });
  });

  it("says unknown, never zero, when its agents can't be seen or don't answer in time", async () => {
    const server = await startServer({
      observeWorkingAgents: () => new Promise<number | null>(() => {}),
    });
    const client = startClient(server, {
      handshake: { ...TEST_HANDSHAKE, protocolVersion: TEST_HANDSHAKE.protocolVersion + 1 },
    });
    await waitFor(() => client.getState().status === "version-mismatch", 5_000);
    expect(client.getState()).toMatchObject({ observed: { workingAgents: null } });
  });

  it("tells an unauthenticated client nothing about its agents", async () => {
    const observe = vi.fn(async () => 3);
    await startServer({ observeWorkingAgents: observe });
    const raw = await rawConnect();
    raw.socket.write(
      encodeFrame(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.HELLO,
          body: {
            handshake: { ...TEST_HANDSHAKE, commit: "def456" },
            token: "0".repeat(64),
            client: { clientId: "client-x", clientName: "x", platform: "darwin" },
            resumeSessionId: null,
          },
        })
      )
    );
    await closedSocket(raw.socket);
    expect(observe).not.toHaveBeenCalled();
  });

  it("rejects a different wire protocol with reason protocol", async () => {
    await startServer();
    const raw = await rawConnect();
    raw.socket.write(
      encodeFrame(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.HELLO,
          body: {
            handshake: { ...TEST_HANDSHAKE, protocolVersion: 2 },
            token: (await readDiscoveryFile(location.discoveryPath))!.token,
            client: { clientId: "c", clientName: "n", platform: "linux" },
            resumeSessionId: null,
          },
        })
      )
    );
    await closedSocket(raw.socket);
    expect(raw.frames.map((f) => frameToMessage(f).body)).toContainEqual(
      expect.objectContaining({ reason: "protocol", handshake: TEST_HANDSHAKE })
    );
  });
});

describe("HostServer session resume", () => {
  it("keeps a link that answers after a wake on the session it had (#14365)", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server, { wakeProbeMs: 200 });
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");
    const session = client.session;
    client.noteSystemResumed();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(client.session).toBe(session);
    expect(session?.isOpen).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("resumes the session a link that died in a sleep held, when it is redialled on wake (#14365)", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server, { wakeProbeMs: 30 });
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");
    // The host still reads but never answers, as the far end of a link lost
    // while the Shell slept: whatever the Shell says on the way out reaches it.
    const stale = seen[0]!.session as unknown as { post: (message: LinkMessage) => string };
    const post = stale.post.bind(stale);
    stale.post = (message) =>
      message.lane === Lane.CONTROL && message.kind === ControlKind.PONG ? "queued" : post(message);
    client.noteSystemResumed();
    await waitFor(() => seen.length === 2 && client.getState().status === "connected");
    expect(seen[1]).toMatchObject({ sessionId: seen[0]!.sessionId, resumed: true });
  });

  it("lets a Shell on another build in, and logs both builds with the session", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server, { handshake: { ...TEST_HANDSHAKE, version: "0.9.0" } });
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");

    const started = logged("main:HostServer").find(
      (entry) => entry.message === "Remote session started"
    );
    expect(started?.context).toMatchObject({
      sessionId: seen[0]!.sessionId,
      buildMismatch: { kind: "version", local: TEST_HANDSHAKE.version, remote: "0.9.0" },
    });
  });

  it("logs a link's life on both ends with the session id, and never a credential", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server, { hostId: "host-studio" });
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");
    const sessionId = seen[0]!.sessionId;
    const firstSecret = (client as unknown as { resumeSecret: string }).resumeSecret;

    (seen[0]!.session as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => seen.length === 2 && client.getState().status === "connected");
    await client.stop();
    await waitFor(() =>
      logged("main:HostServer").some((entry) => entry.message === "Remote session expired")
    );

    const host = logged("main:HostServer");
    const who = { sessionId, clientId: "client-a", clientName: "greg-mbp" };
    expect(host.map((entry) => entry.message)).toEqual([
      "Remote session started",
      "Remote session detached; held for resume",
      "Remote session resumed",
      "Remote session expired",
    ]);
    expect(host[0]!.context).toEqual(who);
    expect(host[1]!.context).toMatchObject({ sessionId, by: "transport", graceMs: 60_000 });
    expect(host[2]!.context).toMatchObject({ ...who, parkedMs: expect.any(Number) });
    expect(host[3]!.context).toMatchObject({ sessionId, cause: "goodbye", by: "remote" });

    // A drop this soon after the handshake also logs the retry's backoff,
    // unless the machine stalled past the short-session window; not asserted.
    const shell = logged("main:LinkClient").filter(
      (entry) => entry.message !== "Remote host unreachable"
    );
    const link = { hostId: "host-studio", sessionId };
    expect(shell.map((entry) => entry.message)).toEqual([
      "Dialling remote host",
      "Remote host link established",
      "Remote host link closed",
      "Dialling remote host",
      "Remote host link resumed",
      "Remote host link closed",
    ]);
    expect(shell[0]!.context).toEqual({
      hostId: "host-studio",
      attempt: 1,
      previousSessionId: null,
    });
    expect(shell[1]!.context).toMatchObject({ ...link, hostName: "studio-01" });
    expect(shell[2]!.context).toMatchObject({ ...link, by: "transport" });
    expect(shell[3]!.context).toMatchObject({
      hostId: "host-studio",
      previousSessionId: sessionId,
    });
    expect(shell[4]!.context).toMatchObject(link);
    expect(shell[5]!.context).toMatchObject({ ...link, reason: "client stopped", by: "local" });

    // Ids survive the logger's redaction, and nothing secret rides along.
    const written = JSON.stringify([...host, ...logged("main:LinkClient")]);
    expect(written).not.toContain("[redacted]");
    expect(written).not.toContain(server.token);
    expect(written).not.toContain(firstSecret);
  });

  it("resumes the same session id after a reconnect within the grace window", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server);
    const established: boolean[] = [];
    client.onSession((e) => established.push(e.resumed));
    await waitFor(() => seen.length === 1);
    const firstId = seen[0]!.sessionId;

    // Kill the stream from the host side without a GOODBYE.
    (seen[0]!.session as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => seen.length === 2 && client.getState().status === "connected");
    expect(seen[1]).toMatchObject({ sessionId: firstId, resumed: true });
    expect(established).toEqual([false, true]);
    expect(client.getState()).toMatchObject({ sessionId: firstId });
  });

  it("says a session detached the moment its link drops, before its grace window ends", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    const detached: string[] = [];
    const stillAttached: boolean[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionDetached((info) => {
      detached.push(info.sessionId);
      stillAttached.push(server.sessions.some((ctx) => ctx.sessionId === info.sessionId));
    });
    server.onSessionExpired((info) => expired.push(info.sessionId));
    const client = startClient(server, { backoff: { initialMs: 5_000, maxMs: 5_000, jitter: 0 } });
    await waitFor(() => seen.length === 1);
    const firstId = seen[0]!.sessionId;
    (seen[0]!.session as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => detached.includes(firstId));
    // Already gone from the attached sessions when listeners hear of it.
    expect(stillAttached).toEqual([false]);
    expect(expired).toEqual([]);
    void client;
  });

  it("ends a superseded session at once when parked, or the moment it parks (#13392)", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    const detached: string[] = [];
    const expired: Array<{ sessionId: string; cause: string }> = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionDetached((info) => detached.push(info.sessionId));
    server.onSessionExpired((info) =>
      expired.push({ sessionId: info.sessionId, cause: info.cause })
    );
    const client = startClient(server, { backoff: { initialMs: 5_000, maxMs: 5_000, jitter: 0 } });
    await waitFor(() => seen.length === 1);
    const firstId = seen[0]!.sessionId;
    // Still attached: nothing ends now, but it won't be held once its link dies.
    expect(server.supersede(firstId)).toBe(false);
    expect(expired).toEqual([]);
    (seen[0]!.session as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => detached.includes(firstId));
    await waitFor(() => expired.length === 1);
    expect(expired).toEqual([{ sessionId: firstId, cause: "session-replaced" }]);
    expect(server.supersede(firstId)).toBe(false);
    void client;
  });

  it("starts a fresh session once the grace window has passed", async () => {
    const server = await startServer({ resumeGraceMs: 20 });
    const seen: HostSessionContext[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionExpired((info) => expired.push(info.sessionId));
    const client = startClient(server, { backoff: { initialMs: 200, maxMs: 200, jitter: 0 } });
    await waitFor(() => seen.length === 1);
    // Keep the session long enough that its loss triggers a backoff retry.
    const firstId = seen[0]!.sessionId;
    seen[0]!.session.close("test drop");
    await waitFor(() => expired.includes(firstId));
    await waitFor(() => seen.length === 2);
    expect(seen[1]!.resumed).toBe(false);
    expect(seen[1]!.sessionId).not.toBe(firstId);
    // Both ends say the old session is gone, and why the host gave it up.
    const host = logged("main:HostServer");
    expect(host).toContainEqual({
      message: "Remote session expired",
      context: { sessionId: firstId, clientId: "client-a", cause: "grace-expired" },
    });
    expect(host).toContainEqual(
      expect.objectContaining({
        message: "Remote session started; the previous one could not be resumed",
        context: expect.objectContaining({
          sessionId: seen[1]!.sessionId,
          previousSessionId: firstId,
          resumeRefused: "session-unknown",
        }),
      })
    );
    await waitFor(() => client.getState().status === "connected");
    expect(logged("main:LinkClient")).toContainEqual(
      expect.objectContaining({
        message: "Remote host started a new session; the previous one was not resumed",
        context: expect.objectContaining({
          sessionId: seen[1]!.sessionId,
          previousSessionId: firstId,
        }),
      })
    );
  });

  it("names its process alike on every session and through a Host mode toggle, so only a restart reads as one (#14184)", async () => {
    let server = await startServer({ resumeGraceMs: 20 });
    const seen: HostSessionContext[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionExpired((info) => expired.push(info.sessionId));
    // Slower to redial than the grace window, so the dropped session expires first.
    const client = startClient(server, { backoff: { initialMs: 200, maxMs: 200, jitter: 0 } });
    const restarted: boolean[] = [];
    const sessions: Array<{ sessionId: string; resumed: boolean }> = [];
    client.onSession(({ hostRestarted, sessionId, resumed }) => {
      restarted.push(hostRestarted);
      sessions.push({ sessionId, resumed });
    });
    await waitFor(() => restarted.length === 1);

    // A session that expired while this process stayed up.
    const firstId = seen[0]!.sessionId;
    seen[0]!.session.close("test drop");
    await waitFor(() => expired.includes(firstId));
    await waitFor(() => restarted.length === 2);
    expect(sessions[1]).toMatchObject({ resumed: false });
    expect(sessions[1]!.sessionId).not.toBe(firstId);

    // Host mode off and on again: a new server, the same process and terminals.
    await server.close();
    server = await startServer();
    await waitFor(() => restarted.length === 3);

    // Another process listening at the same place: the host restarted.
    await server.close();
    await startServer({ launchId: "another-process" });
    await waitFor(() => restarted.length === 4);

    expect(restarted).toEqual([false, false, false, true]);
    expect(logged("main:LinkClient")).toContainEqual(
      expect.objectContaining({
        message: "Remote host restarted; the previous session ended with it",
      })
    );
  });

  it("tells a Shell how its previous process ended only when it restarted (#14368)", async () => {
    const previousEnd = {
      crashCause: "external-kill" as const,
      cause: "watchdog-deadlock" as const,
      watchdogKillReason: "unresponsive-under-pressure" as const,
      missedBeats: 12,
      at: 1_000,
    };
    // The process this Shell first meets recorded an unclean end before it:
    // nothing ended under this Shell, so it says nothing of it.
    let server = await startServer({ launchId: "first", previousEnd });
    const client = startClient(server);
    const ends: Array<{ restarted: boolean; previousEnd: unknown }> = [];
    client.onSession(({ hostRestarted, previousEnd: end }) =>
      ends.push({ restarted: hostRestarted, previousEnd: end })
    );
    await waitFor(() => ends.length === 1);

    // Killed, and the next process recorded how.
    await server.close();
    server = await startServer({ launchId: "second", previousEnd });
    await waitFor(() => ends.length === 2);

    // A planned restart leaves no record.
    await server.close();
    await startServer({ launchId: "third" });
    await waitFor(() => ends.length === 3);

    expect(ends).toEqual([
      { restarted: false, previousEnd: undefined },
      { restarted: true, previousEnd },
      { restarted: true, previousEnd: undefined },
    ]);
  });

  it("does not resume a session for a different client id", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    startClient(server);
    await waitFor(() => seen.length === 1);
    const raw = await rawConnect();
    raw.socket.write(
      encodeFrame(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.HELLO,
          body: {
            handshake: TEST_HANDSHAKE,
            token: server.token,
            client: { clientId: "intruder", clientName: "n", platform: "linux" },
            resumeSessionId: seen[0]!.sessionId,
          },
        })
      )
    );
    await waitFor(() => seen.length === 2);
    expect(seen[1]!.resumed).toBe(false);
    expect(seen[1]!.sessionId).not.toBe(seen[0]!.sessionId);
    expect(seen[0]!.session.isOpen).toBe(true);
    expect(logged("main:HostServer")).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          clientId: "intruder",
          previousSessionId: seen[0]!.sessionId,
          resumeRefused: "secret-mismatch",
        }),
      })
    );
    raw.socket.destroy();
  });

  it("does not resume a session for its own client id without the secret its WELCOME carried", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    startClient(server);
    await waitFor(() => seen.length === 1);
    const { clientId } = seen[0]!.client;
    for (const resumeSecret of [undefined, null, "guess"]) {
      const raw = await rawConnect();
      raw.socket.write(
        encodeFrame(
          messageToFrame({
            lane: Lane.CONTROL,
            kind: ControlKind.HELLO,
            body: {
              handshake: TEST_HANDSHAKE,
              token: server.token,
              client: { clientId, clientName: "n", platform: "linux" },
              resumeSessionId: seen[0]!.sessionId,
              ...(resumeSecret === undefined ? {} : { resumeSecret }),
            },
          })
        )
      );
      await waitFor(() => seen.length > 1);
      const taken = seen.pop()!;
      expect(taken.resumed).toBe(false);
      expect(taken.sessionId).not.toBe(seen[0]!.sessionId);
      expect(seen[0]!.session.isOpen).toBe(true);
      raw.socket.destroy();
    }
  });

  it("resumes only for the same client with the current secret, never a replayed one", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const hello = async (clientId: string, resume: { id: string; secret: string } | null) => {
      const raw = await rawConnect();
      raw.socket.write(
        encodeFrame(
          messageToFrame({
            lane: Lane.CONTROL,
            kind: ControlKind.HELLO,
            body: {
              handshake: TEST_HANDSHAKE,
              token: server.token,
              client: { clientId, clientName: "n", platform: "linux" },
              resumeSessionId: resume?.id ?? null,
              resumeSecret: resume?.secret ?? null,
            },
          })
        )
      );
      await waitFor(() => raw.frames.some((f) => frameToMessage(f)?.kind === ControlKind.WELCOME));
      const welcome = raw.frames
        .map((frame) => frameToMessage(frame))
        .find((m) => m?.kind === ControlKind.WELCOME)!.body as {
        sessionId: string;
        resumed: boolean;
        resumeSecret: string;
      };
      return { raw, welcome };
    };
    const drop = async (raw: { socket: net.Socket }) => {
      const before = seen.length;
      raw.socket.destroy();
      await closedSocket(raw.socket);
      await waitFor(() => !seen[before - 1]!.session.isOpen);
    };

    const first = await hello("shell-a", null);
    await drop(first.raw);
    const resume = { id: first.welcome.sessionId, secret: first.welcome.resumeSecret };

    const intruder = await hello("shell-b", resume);
    expect(intruder.welcome.resumed).toBe(false);
    intruder.raw.socket.destroy();

    const back = await hello("shell-a", resume);
    expect(back.welcome).toMatchObject({ sessionId: resume.id, resumed: true });
    expect(back.welcome.resumeSecret).not.toBe(resume.secret);
    // The Shell speaks on the resumed session: it has the new secret, and the old one is spent.
    const resumedSession = seen.at(-1)!.session;
    ping(back.raw);
    await waitFor(() => resumedSession.framesSinceOpen > 0);
    await drop(back.raw);

    const replay = await hello("shell-a", resume);
    expect(replay.welcome.resumed).toBe(false);
    replay.raw.socket.destroy();
  });

  it("still resumes with the previous secret when the WELCOME carrying the new one was lost", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const first = await helloOn(server, "shell-a", null);
    first.raw.socket.destroy();
    await waitFor(() => !seen[0]!.session.isOpen);
    const resume = { id: first.welcome.sessionId, secret: first.welcome.resumeSecret };

    // Resumed, but the link dies before the Shell reads the WELCOME: it still holds the old secret.
    const lost = await helloOn(server, "shell-a", resume);
    expect(lost.welcome.resumed).toBe(true);
    lost.raw.socket.destroy();
    await waitFor(() => !seen[1]!.session.isOpen);

    const again = await helloOn(server, "shell-a", resume);
    expect(again.welcome).toMatchObject({ sessionId: resume.id, resumed: true });
    again.raw.socket.destroy();
  });

  it("closes connections past the cap on sockets waiting to say HELLO", async () => {
    await startServer();
    const waiting = [];
    for (let i = 0; i < MAX_PENDING_HANDSHAKES; i++) waiting.push(await rawConnect());
    const extra = await rawConnect();
    await closedSocket(extra.socket);
    for (const raw of waiting) expect(raw.socket.destroyed).toBe(false);
    for (const raw of waiting) raw.socket.destroy();
  });

  it("never buffers a large frame from a socket that hasn't said HELLO", async () => {
    await startServer();
    const raw = await rawConnect();
    const big = encodeFrame(
      {
        lane: Lane.CONTROL,
        kind: ControlKind.HELLO,
        streamId: 0,
        payload: new Uint8Array(HANDSHAKE_MAX_FRAME_BYTES + 1),
      },
      HANDSHAKE_MAX_FRAME_BYTES * 2
    );
    // Only the header goes: the host refuses on the length, before any body arrives.
    raw.socket.write(big.subarray(0, 16));
    await closedSocket(raw.socket);
    const goodbye = raw.frames
      .map((frame) => frameToMessage(frame))
      .find((m) => m?.kind === ControlKind.GOODBYE);
    expect(String((goodbye?.body as { reason?: string } | undefined)?.reason)).toMatch(
      /frame length/
    );
  });

  it("refuses anything but a handshake kind before HELLO, without decoding it", async () => {
    await startServer();
    const raw = await rawConnect();
    raw.socket.write(
      encodeFrame({ lane: Lane.RPC, kind: 1, streamId: 0, payload: new Uint8Array(8) })
    );
    await closedSocket(raw.socket);
    const goodbye = raw.frames
      .map((frame) => frameToMessage(frame))
      .find((m) => m?.kind === ControlKind.GOODBYE);
    expect(String((goodbye?.body as { reason?: string } | undefined)?.reason)).toMatch(
      /before handshake/
    );
  });

  it("refuses the client id this host's own windows go by", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const raw = await rawHello(server.token, "local");
    await closedSocket(raw.socket);
    expect(seen).toHaveLength(0);
    const reject = raw.frames
      .map((frame) => frameToMessage(frame))
      .find((m) => m?.kind === ControlKind.REJECT);
    expect(reject?.body).toMatchObject({ reason: "protocol" });
  });

  it("expires a session at once when the client leaves with GOODBYE", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionExpired((info) => expired.push(info.sessionId));
    const client = startClient(server);
    await waitFor(() => seen.length === 1);
    // The host has its session before the client has read WELCOME; this is
    // the stop of a connected Shell, not of one still dialling.
    await waitFor(() => client.getState().status === "connected");
    await client.stop();
    await waitFor(() => expired.length === 1);
    expect(expired).toEqual([seen[0]!.sessionId]);
  });

  it("sends GOODBYE to every session on close", async () => {
    const server = await startServer();
    const client = startClient(server);
    await waitFor(() => client.getState().status === "connected");
    const session = client.session!;
    const closed = new Promise((r) => session.onClose(r));
    await server.close();
    await expect(closed).resolves.toEqual({ reason: "shutting-down", by: "remote" });
  });
});

describe("HostServer and a Shell that gives up on a resume handshake (#15877)", () => {
  /** A connected Shell loses its link, and its redial, asking to resume, reaches a stalled host. */
  async function resumeIntoAStall(options: { stalledDialGivesUpAfterMs?: number } = {}) {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    const detached: string[] = [];
    const expired: Array<{ sessionId: string; cause: string }> = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionDetached((info) => detached.push(info.sessionId));
    server.onSessionExpired((info) =>
      expired.push({ sessionId: info.sessionId, cause: info.cause })
    );
    const stalling = await stallingTransport();
    const client = startClient(server, {
      transport: stalling.transport,
      session: {
        pingIntervalMs: 0,
        idleTimeoutMs: 0,
        // Read per dial: only the one that reaches the stalled host gives up
        // early, so CI load can't time out the healthy dials around it.
        get handshakeTimeoutMs() {
          return stalling.lastDialStalled()
            ? (options.stalledDialGivesUpAfterMs ?? 10_000)
            : 10_000;
        },
      },
    });
    const states: LinkClientState[] = [];
    client.onStateChange((state) => states.push(state));
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");
    const sessionId = seen[0]!.sessionId;
    stalling.stall();
    (seen[0]!.session as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => stalling.sent().length > 0);
    expect(stalling.sent()[0]).toMatchObject({
      kind: ControlKind.HELLO,
      body: { resumeSessionId: sessionId },
    });
    return { client, stalling, sessionId, seen, detached, expired, states };
  }

  /** The host catches up on the abandoned dial, and the Shell's next dial goes through. */
  async function catchUp(run: Awaited<ReturnType<typeof resumeIntoAStall>>) {
    await waitFor(() => run.stalling.abandoned());
    await run.stalling.deliver();
    // It resumed the session on the abandoned HELLO and lost that link in turn.
    await waitFor(() => run.seen.length === 2 && run.detached.length === 2);
    expect(run.seen[1]).toMatchObject({ sessionId: run.sessionId, resumed: true });
    run.stalling.resume();
  }

  it("keeps the session a timed-out handshake resumed, for the next dial to resume", async () => {
    const run = await resumeIntoAStall({ stalledDialGivesUpAfterMs: 100 });
    await catchUp(run);
    expect(run.states).toContainEqual(
      expect.objectContaining({ status: "unreachable", detail: "handshake timed out" })
    );
    await waitFor(() => run.seen.length === 3 && run.client.getState().status === "connected");
    expect(run.seen[2]).toMatchObject({ sessionId: run.sessionId, resumed: true });
    expect(run.expired).toEqual([]);
  });

  it("keeps the session a handshake abandoned for a restart resumed, for the next dial to resume", async () => {
    const run = await resumeIntoAStall();
    run.client.retryNow({ restart: true });
    await catchUp(run);
    await waitFor(() => run.seen.length === 3 && run.client.getState().status === "connected");
    expect(run.seen[2]).toMatchObject({ sessionId: run.sessionId, resumed: true });
    expect(run.expired).toEqual([]);
  });

  it("still ends the session at once when the Shell is stopped during a resume handshake", async () => {
    const run = await resumeIntoAStall();
    await run.client.stop();
    await catchUp(run);
    await waitFor(() => run.expired.length === 1);
    expect(run.expired).toEqual([{ sessionId: run.sessionId, cause: "goodbye" }]);
  });
});

describe("HostServer listen/close serialization", () => {
  it("shares one start between concurrent listen() calls", async () => {
    const server = new HostServer({ location, handshake: TEST_HANDSHAKE, hostName: "h" });
    servers.push(server);
    const a = server.listen();
    const b = server.listen();
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(server.isListening).toBe(true);
    await expect(server.listen()).resolves.toBeUndefined();
  });

  it("waits for a start in flight on close and removes its listener and discovery file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rename = fs.rename.bind(fs);
    const reached = vi.fn();
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === location.discoveryPath) {
        reached();
        await gate;
      }
    });
    const server = new HostServer({ location, handshake: TEST_HANDSHAKE, hostName: "h" });
    servers.push(server);
    const listening = server.listen();
    const settled = listening.catch((err: unknown) => err);
    await waitFor(() => reached.mock.calls.length === 1);
    expect(existsSync(location.discoveryPath)).toBe(true);

    let closed = false;
    const closing = server.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(await settled).toBeInstanceOf(Error);
    expect(server.isListening).toBe(false);
    expect(existsSync(location.discoveryPath)).toBe(false);
    expect(existsSync(location.socketPath)).toBe(false);

    vi.restoreAllMocks();
    await server.listen();
    expect(server.isListening).toBe(true);
  });

  it("tears down a start whose close() lands while the socket lock is being released", async () => {
    const server = new HostServer({ location, handshake: TEST_HANDSHAKE, hostName: "h" });
    servers.push(server);
    const realUnlink = fs.unlink.bind(fs);
    let closing: Promise<void> | null = null;
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (!closing && String(target).endsWith(".lock")) closing = server.close();
      return realUnlink(target);
    });
    await server.listen();
    expect(closing).not.toBeNull();
    await closing;
    expect(server.isListening).toBe(false);
    expect(existsSync(location.socketPath)).toBe(false);
    expect(existsSync(location.discoveryPath)).toBe(false);
  });

  it("starts again cleanly when listen() follows close() before it finished", async () => {
    const server = await startServer();
    const closing = server.close();
    const relisten = server.listen();
    await closing;
    await relisten;
    expect(server.isListening).toBe(true);
    expect((await readDiscoveryFile(location.discoveryPath))?.token).toBe(server.token);
  });
});

describe("HostServer session cap", () => {
  it("counts parked sessions against maxSessions and expires the oldest parked first", async () => {
    const server = await startServer({ maxSessions: 2 });
    const seen: HostSessionContext[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionExpired((info) => expired.push(info.sessionId));
    const resumable = (server as unknown as { resumable: Map<string, object> }).resumable;

    const one = await rawHello(server.token, "c1");
    await waitFor(() => seen.length === 1);
    const two = await rawHello(server.token, "c2");
    await waitFor(() => seen.length === 2);
    one.socket.destroy();
    await waitFor(() => resumable.size === 1);
    // A few identifiers and a timer are parked, never the dropped session; the
    // Shell's name stays so its session's end can still name it.
    expect(Object.keys(resumable.get(seen[0]!.sessionId)!).sort()).toEqual([
      "clientId",
      "clientName",
      "parkedAt",
      "sessionId",
      "timer",
    ]);

    const three = await rawHello(server.token, "c3");
    await waitFor(() => seen.length === 3);
    expect(expired).toEqual([seen[0]!.sessionId]);
    expect(resumable.size).toBe(0);
    expect(logged("main:HostServer")).toContainEqual({
      message: "Remote session expired",
      context: { sessionId: seen[0]!.sessionId, clientId: "c1", cause: "session-cap" },
    });

    const four = await rawHello(server.token, "c4");
    await closedSocket(four.socket);
    expect(four.frames.map((f) => frameToMessage(f).body)).toContainEqual({
      reason: "busy",
      handshake: null,
      detail: null,
    });
    expect(seen).toHaveLength(3);
    two.socket.destroy();
    three.socket.destroy();
  });
});

describe("HostServer and a relaunched Shell (#13909)", () => {
  const INSTALL = "5b1f6c3e-8d2a-4f4e-9c1b-0a7e2d9f3c41";
  const OTHER_INSTALL = "c0e9a1d2-3b4c-4d5e-8f6a-7b8c9d0e1f2a";

  async function watched(server: HostServer) {
    const seen: HostSessionContext[] = [];
    const parked: string[] = [];
    const expired: Array<{ sessionId: string; clientId: string; cause: string }> = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionDetached((info) => parked.push(info.sessionId));
    server.onSessionExpired((info) =>
      expired.push({ sessionId: info.sessionId, clientId: info.clientId, cause: info.cause })
    );
    const park = async (opened: Awaited<ReturnType<typeof helloOn>>) => {
      opened.raw.socket.destroy();
      await waitFor(() => parked.includes(opened.welcome.sessionId));
    };
    return { seen, expired, park };
  }

  it("ends the install's parked session as soon as it starts a fresh one", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const { expired, park } = await watched(server);
    const crashed = await helloOn(server, "launch-1", null, INSTALL);
    await park(crashed);
    expect(expired).toEqual([]);

    const relaunched = await helloOn(server, "launch-2", null, INSTALL);
    expect(relaunched.welcome.resumed).toBe(false);
    expect(expired).toEqual([
      { sessionId: crashed.welcome.sessionId, clientId: "launch-1", cause: "session-replaced" },
    ]);

    // Ended for good: its secret resumes nothing.
    const late = await helloOn(server, "launch-1", {
      id: crashed.welcome.sessionId,
      secret: crashed.welcome.resumeSecret,
    });
    expect(late.welcome.resumed).toBe(false);
    expect(expired).toHaveLength(1);
    relaunched.raw.socket.destroy();
    late.raw.socket.destroy();
  });

  it("leaves other installs, Shells that name none, and a live session of the same install alone", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const { seen, expired, park } = await watched(server);
    const otherInstall = await helloOn(server, "ana-launch", null, OTHER_INSTALL);
    await park(otherInstall);
    const unnamed = await helloOn(server, "old-shell", null);
    await park(unnamed);
    const stale = [
      await helloOn(server, "launch-0", null, INSTALL),
      await helloOn(server, "launch-1", null, INSTALL),
    ];
    for (const opened of stale) await park(opened);
    const sibling = await helloOn(server, "sibling-launch", null, INSTALL);
    const siblingSession = seen.at(-1)!.session;

    const relaunched = await helloOn(server, "launch-2", null, INSTALL);
    expect(expired.map((info) => [info.clientId, info.cause])).toEqual([
      ["launch-0", "session-replaced"],
      ["launch-1", "session-replaced"],
    ]);
    expect(siblingSession.isOpen).toBe(true);
    // Nothing marked it to end once it parks either: it is held for resume.
    await park(sibling);
    expect(expired).toHaveLength(2);

    const back = await helloOn(server, "ana-launch", {
      id: otherInstall.welcome.sessionId,
      secret: otherInstall.welcome.resumeSecret,
    });
    expect(back.welcome.resumed).toBe(true);
    relaunched.raw.socket.destroy();
    back.raw.socket.destroy();
  });

  it("ends nothing for a resume or a refused HELLO naming the install", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const { expired, park } = await watched(server);
    // Two launches sharing the install's id, both attached before either drops.
    const one = await helloOn(server, "launch-1", null, INSTALL);
    const two = await helloOn(server, "launch-2", null, INSTALL);
    await park(one);
    await park(two);

    const intruder = await rawConnect();
    intruder.socket.write(
      encodeFrame(
        messageToFrame({
          lane: Lane.CONTROL,
          kind: ControlKind.HELLO,
          body: {
            handshake: TEST_HANDSHAKE,
            token: "not-the-token",
            client: { clientId: "launch-x", clientName: "n", platform: "linux", deviceId: INSTALL },
            resumeSessionId: null,
          },
        })
      )
    );
    await closedSocket(intruder.socket);
    expect(intruder.frames.map((f) => frameToMessage(f)?.body)).toContainEqual(
      expect.objectContaining({ reason: "unauthorized" })
    );
    expect(expired).toEqual([]);

    // One resuming leaves the other's parked session to it.
    const resumed = await helloOn(
      server,
      "launch-1",
      { id: one.welcome.sessionId, secret: one.welcome.resumeSecret },
      INSTALL
    );
    expect(resumed.welcome.resumed).toBe(true);
    expect(expired).toEqual([]);
    const back = await helloOn(
      server,
      "launch-2",
      { id: two.welcome.sessionId, secret: two.welcome.resumeSecret },
      INSTALL
    );
    expect(back.welcome.resumed).toBe(true);
    expect(expired).toEqual([]);
    resumed.raw.socket.destroy();
    back.raw.socket.destroy();
  });
});

describe("HostServer link history", () => {
  it("records when it started listening, and forgets it once closed", async () => {
    const before = Date.now();
    const server = await startServer();
    expect(server.listeningSince).toBeGreaterThanOrEqual(before);
    await server.close();
    expect(server.listeningSince).toBeNull();
  });

  it("records a drop held for resume, the resume, and the session ending", async () => {
    const server = await startServer({ resumeGraceMs: 60_000 });
    const seen: HostSessionContext[] = [];
    server.onSession((ctx) => seen.push(ctx));
    const client = startClient(server);
    // Only a Shell that has its WELCOME can ask to resume.
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");
    const sessionId = seen[0]!.sessionId;
    (seen[0]!.session as unknown as { socket: net.Socket }).socket.destroy();
    await waitFor(() => seen.length === 2 && client.getState().status === "connected");
    await client.stop();
    await waitFor(() => server.linkHistory().events.length === 4);

    const who = { clientId: "client-a", clientName: "greg-mbp", sessionId };
    expect(server.linkHistory()).toEqual({
      truncated: false,
      events: [
        expect.objectContaining({
          ...who,
          kind: "session-ended",
          cause: "goodbye",
          reason: expect.any(String),
        }),
        expect.objectContaining({ ...who, kind: "session-resumed", overLiveLink: false }),
        expect.objectContaining({
          ...who,
          kind: "link-dropped",
          reason: "socket closed",
          by: "transport",
        }),
        expect.objectContaining({ ...who, kind: "session-started", previousNotResumed: null }),
      ],
    });
  });

  it("names why a Shell's previous session wasn't resumed on the session it got instead", async () => {
    const server = await startServer({ resumeGraceMs: 20 });
    const seen: HostSessionContext[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionExpired((info) => expired.push(info.sessionId));
    const client = startClient(server, { backoff: { initialMs: 200, maxMs: 200, jitter: 0 } });
    await waitFor(() => seen.length === 1 && client.getState().status === "connected");
    const firstId = seen[0]!.sessionId;
    seen[0]!.session.close("test drop");
    await waitFor(() => expired.includes(firstId));
    await waitFor(() => seen.length === 2);

    const kinds = server
      .linkHistory()
      .events.map((event) =>
        event.kind === "session-started"
          ? [event.kind, event.sessionId, event.previousNotResumed]
          : event.kind === "session-ended"
            ? [event.kind, event.sessionId, event.cause]
            : event.kind === "link-dropped"
              ? [event.kind, event.sessionId, event.reason]
              : [event.kind]
      );
    expect(kinds).toEqual([
      ["session-started", seen[1]!.sessionId, "session-unknown"],
      ["session-ended", firstId, "grace-expired"],
      ["link-dropped", firstId, "test drop"],
      ["session-started", firstId, null],
    ]);
  });

  it("counts a launch retrying into the same refusal on one entry, never keeping the token", async () => {
    const server = await startServer();
    for (let i = 0; i < 3; i++) {
      const raw = await rawHello("f".repeat(64), "c1");
      await closedSocket(raw.socket);
    }
    const accepted = await rawHello(server.token, "c1");
    await waitFor(() => server.sessions.length === 1);
    const again = await rawHello("f".repeat(64), "c1");
    await closedSocket(again.socket);

    const { events } = server.linkHistory();
    expect(
      events.map((event) => [event.kind, event.kind === "refused" ? event.count : null])
    ).toEqual([
      ["refused", 1],
      ["session-started", null],
      ["refused", 3],
    ]);
    expect(events[2]).toMatchObject({
      kind: "refused",
      reason: "unauthorized",
      clientId: "c1",
      clientName: "n",
      detail: null,
    });
    expect(JSON.stringify(events)).not.toContain(server.token);
    expect(JSON.stringify(events)).not.toContain("f".repeat(64));
    accepted.socket.destroy();
  });
});
