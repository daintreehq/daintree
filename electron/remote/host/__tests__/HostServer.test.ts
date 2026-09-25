import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, Lane, type LinkFrame } from "../../link/frames.js";
import { ControlKind, frameToMessage, messageToFrame } from "../../link/messages.js";
import { LinkClient, type LinkClientState } from "../../client/LinkClient.js";
import { createDirectTransport } from "../../client/transport.js";
import { HostServer, type HostSessionContext } from "../HostServer.js";
import {
  SocketPathTooLongError,
  hostSocketLocation,
  type HostSocketLocation,
} from "../hostSocketPath.js";
import { readDiscoveryFile, removeDiscoveryFile, writeDiscoveryFile } from "../discoveryFile.js";
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

beforeEach(async () => {
  root = await makeTempDir();
  location = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "ud") });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const s of servers.splice(0)) await s.close();
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

function closedSocket(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
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
    });
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

  it("rejects a different build and the client reports the mismatch without retrying", async () => {
    const server = await startServer();
    const other = { ...TEST_HANDSHAKE, commit: "def456" };
    let attempts = 0;
    const client = startClient(server, { handshake: other });
    client.onStateChange((s) => {
      if (s.status === "connecting") attempts++;
    });
    await waitFor(() => client.getState().status === "version-mismatch");
    expect(client.getState()).toEqual({
      status: "version-mismatch",
      mismatch: { kind: "commit", local: "def456", remote: "abc123" },
      local: other,
      remote: TEST_HANDSHAKE,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(client.getState().status).toBe("version-mismatch");
    expect(attempts).toBe(0);
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
    void client;
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
    raw.socket.destroy();
  });

  it("expires a session at once when the client leaves with GOODBYE", async () => {
    const server = await startServer();
    const seen: HostSessionContext[] = [];
    const expired: string[] = [];
    server.onSession((ctx) => seen.push(ctx));
    server.onSessionExpired((info) => expired.push(info.sessionId));
    const client = startClient(server);
    await waitFor(() => seen.length === 1);
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
