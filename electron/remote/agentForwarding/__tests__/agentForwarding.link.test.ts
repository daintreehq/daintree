import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import type { DriveTarget } from "../../../services/DriveLeaseService.js";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { installAgentForwardingClient, type AgentForwardingClient } from "../clientInstall.js";
import {
  _resetIssuedAgentSocketsForTest,
  installHostAgentForwarding,
  type HostAgentForwarding,
} from "../hostForwarder.js";
import { AgentForwardMethod } from "../linkMethods.js";
import { AgentMessageReader, frameAgentMessage } from "../protocol.js";

const HOST_ID = "studio-01";
const PROJECT = "project-a";
const SESSION_ID = "session-1";
const OTHER_SESSION_ID = "session-2";

const IDENTITIES_ANSWER = [12, 0, 0, 0, 0];
const SIGN_RESPONSE = [14, 0, 0, 0, 1, 7];
const SESSION_BIND = [
  27,
  ...[0, 0, 0, 24],
  ...Buffer.from("session-bind@openssh.com"),
  ...[0, 0, 0, 2, 9, 9],
];

interface FakeAgent {
  path: string;
  server: net.Server;
  /** Every request body it received, with the connection it came on. */
  saw: Array<{ connection: number; body: number[] }>;
  open: Set<net.Socket>;
  /** Connections it ever accepted. */
  accepted: () => number;
}

let dir: string;
let host: LinkSession;
let client: LinkSession;
let agent: FakeAgent;
let signDelay: Promise<void>;
let sshConfigGate: Promise<void>;
let target: DriveTarget;
let leaseListeners: Array<(state: { projectId: string }) => void>;
let switchOn: boolean;
let views: boolean;
let registryListeners: Array<() => void>;
type HostSessionCtx = { sessionId: string; session: LinkSession };
let hostSessions: HostSessionCtx[];
let sessionListeners: Array<(ctx: HostSessionCtx) => void>;
let routeListeners: Array<() => void>;
let hostSide: HostAgentForwarding;
let shellSide: AgentForwardingClient;
const cleanups: Array<() => unknown> = [];
const sockets: net.Socket[] = [];

function liveTarget(linkSessionId = SESSION_ID): DriveTarget {
  return {
    kind: "live",
    holder: {
      leaseId: 1,
      endpointId: `remote:${linkSessionId}:e1`,
      clientId: "shell",
      clientName: "shell",
      isHostLocal: false,
      acquiredAt: 0,
    },
    endpoint: { kind: "remote-view", linkSessionId } as ClientEndpoint,
  };
}

function setTarget(next: DriveTarget): void {
  target = next;
  for (const listener of leaseListeners) listener({ projectId: PROJECT });
}

function setSwitch(on: boolean): void {
  switchOn = on;
  for (const listener of registryListeners) listener();
}

async function startFakeAgent(socketPath: string): Promise<FakeAgent> {
  let nextConnection = 1;
  const fake: FakeAgent = {
    path: socketPath,
    server: null!,
    saw: [],
    open: new Set(),
    accepted: () => nextConnection - 1,
  };
  fake.server = net.createServer((socket) => {
    const connection = nextConnection++;
    fake.open.add(socket);
    socket.on("close", () => fake.open.delete(socket));
    // A reply the relay stopped waiting for lands on a closed socket.
    socket.on("error", () => {});
    const reader = new AgentMessageReader();
    socket.on("data", async (chunk) => {
      for (const body of reader.push(chunk)) {
        fake.saw.push({ connection, body: [...body] });
        if (body[0] === 13) await signDelay;
        const reply = body[0] === 11 ? IDENTITIES_ANSWER : SIGN_RESPONSE;
        socket.write(frameAgentMessage(Uint8Array.from(reply)));
      }
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(socketPath, () => resolve()));
  return fake;
}

function installShell(
  session: LinkSession,
  agentPath: string,
  readConfig: (target: string) => Promise<string> = async () => `identityagent ${agentPath}\n`,
  env: NodeJS.ProcessEnv = {}
): AgentForwardingClient {
  const installed = installAgentForwardingClient({
    manager: {
      onSessionOpened(listener) {
        listener(HOST_ID, session);
        return () => {};
      },
    },
    windowShowing: () => views,
    registry: {
      get: (hostId) =>
        hostId === HOST_ID
          ? ({
              id: HOST_ID,
              connection: { kind: "ssh", target: "me@studio" },
              forwardSshAgent: switchOn,
            } as HostDescriptor)
          : null,
      onChange(listener) {
        registryListeners.push(listener);
        return () => {};
      },
    },
    sessionFor: () => session,
    readSshConfig: async (configTarget) => {
      await sshConfigGate;
      return readConfig(configTarget);
    },
    platform: "darwin",
    env,
  });
  cleanups.push(() => installed.dispose());
  return installed;
}

function installHost(socketDir = path.join(dir, "agent")): HostAgentForwarding {
  const installed = installHostAgentForwarding({
    server: {
      sessions: hostSessions,
      onSession(listener) {
        sessionListeners.push(listener);
        return () => {};
      },
    },
    lease: {
      getDriveTarget: () => target,
      onChange(listener) {
        leaseListeners.push(listener);
        return () => {};
      },
    },
    socketDir,
    fallbackSocketDir: path.join(dir, "fb"),
    onRouteMaybeChanged(listener) {
      routeListeners.push(listener);
      return () => {};
    },
    readSshConfig: async (_destination, env) =>
      `user me\nidentityagent ${env?.SSH_AUTH_SOCK ?? "none"}\n`,
  });
  cleanups.push(() => installed.dispose());
  return installed;
}

/** A client of the host's project socket, like ssh on the host. */
async function connectAgentClient(socketPath: string) {
  const socket = net.connect(socketPath);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = new AgentMessageReader();
  const replies: number[][] = [];
  let closed = false;
  socket.on("data", (chunk) => {
    for (const body of reader.push(chunk)) replies.push([...body]);
  });
  socket.on("close", () => (closed = true));
  socket.on("error", () => {});
  return {
    socket,
    replies,
    isClosed: () => closed,
    send(...bodies: number[][]) {
      socket.write(Buffer.concat(bodies.map((body) => frameAgentMessage(Uint8Array.from(body)))));
    },
    async ask(body: number[]): Promise<number[]> {
      const before = replies.length;
      this.send(body);
      await waitFor(() => replies.length > before || closed);
      if (replies.length === before) throw new Error("closed without a reply");
      return replies[before]!;
    },
  };
}

beforeEach(async () => {
  _resetIssuedAgentSocketsForTest();
  dir = await makeTempDir();
  ({ host, client } = await openSessionPair(dir));
  signDelay = Promise.resolve();
  sshConfigGate = Promise.resolve();
  agent = await startFakeAgent(path.join(dir, "fa.sock"));
  target = liveTarget();
  leaseListeners = [];
  switchOn = true;
  views = true;
  registryListeners = [];
  hostSessions = [{ sessionId: SESSION_ID, session: host }];
  sessionListeners = [];
  routeListeners = [];
  hostSide = installHost();
  shellSide = installShell(client, agent.path);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.close("test over");
  client.close("test over");
  await new Promise<void>((resolve) => agent.server.close(() => resolve()));
  await removeTempDir(dir);
});

/** What a spawn would be handed once the host has heard the Shell's latest switch. */
async function spawnSocket(expectSocket: boolean, projectId = PROJECT): Promise<string | null> {
  for (let i = 0; i < 200; i++) {
    const socketPath = await hostSide.socketForSpawn(projectId);
    if ((socketPath !== null) === expectSocket) return socketPath;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(expectSocket ? "no socket for the project" : "still handed a socket");
}

async function projectSocket(projectId = PROJECT): Promise<string> {
  return (await spawnSocket(true, projectId))!;
}

/** A request straight over the link, as a host would send it. */
function relayDirect(connectionId: number, body: number[]): Promise<unknown> {
  return host.call(AgentForwardMethod.REQUEST, { connectionId, message: Uint8Array.from(body) });
}

describe("agent forwarding over a link", () => {
  it("carries requests to the driving Shell's agent, whole and on one agent connection", async () => {
    const ssh = await connectAgentClient(await projectSocket());

    expect(await ssh.ask([11])).toEqual(IDENTITIES_ANSWER);
    expect(await ssh.ask(SESSION_BIND)).toEqual(SIGN_RESPONSE);
    expect(await ssh.ask([13, 0, 0, 0, 3, 1, 2, 3])).toEqual(SIGN_RESPONSE);

    expect(agent.saw).toEqual([
      { connection: 1, body: [11] },
      { connection: 1, body: SESSION_BIND },
      { connection: 1, body: [13, 0, 0, 0, 3, 1, 2, 3] },
    ]);
  });

  it("gives each project its own owner-only socket, at a path that stays the project's", async () => {
    const socketPath = await projectSocket();
    const other = await projectSocket("project-b");

    expect(other).not.toBe(socketPath);
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect(await hostSide.socketForSpawn(PROJECT)).toBe(socketPath);
  });

  it("listens again on a socket it handed out when Host mode starts again", async () => {
    const socketPath = await projectSocket();
    await hostSide.dispose();
    await expect(fs.lstat(socketPath)).rejects.toThrow();

    hostSide = installHost();

    for (let i = 0; i < 200; i++) {
      if (
        await fs.lstat(socketPath).then(
          () => true,
          () => false
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // No link has said its switch is on to this new start yet: an answer, not a missing socket.
    const ssh = await connectAgentClient(socketPath);
    expect(await ssh.ask([11])).toEqual([5]);
  });

  it("refuses requests to change keys on the Shell, in order with the ones it forwards", async () => {
    const ssh = await connectAgentClient(await projectSocket());
    let releaseSign!: () => void;
    signDelay = new Promise((resolve) => (releaseSign = resolve));

    // A slow signature, then an add, a remove-all and a lock queued behind it.
    ssh.send([13, 0, 0, 0, 0], [17, 1, 2], [19], [22, 0, 0, 0, 0]);
    await waitFor(() => agent.saw.length === 1);
    expect(ssh.replies).toEqual([]);
    releaseSign();
    await waitFor(() => ssh.replies.length === 4);

    expect(ssh.replies).toEqual([SIGN_RESPONSE, [5], [5], [5]]);
    expect(agent.saw.map((request) => request.body[0])).toEqual([13]);
  });

  it("refuses a second request on a connection while one is still out", async () => {
    let releaseSign!: () => void;
    signDelay = new Promise((resolve) => (releaseSign = resolve));
    const first = relayDirect(7, [13, 0, 0, 0, 0]);
    await waitFor(() => agent.saw.length === 1);

    await expect(relayDirect(7, [11])).rejects.toMatchObject({ code: "VALIDATION" });
    releaseSign();
    expect(await first).toEqual({ message: Uint8Array.from(SIGN_RESPONSE) });
  });

  it("refuses every extension but session-bind", async () => {
    const ssh = await connectAgentClient(await projectSocket());
    const extension = (name: string) => [27, 0, 0, 0, name.length, ...Buffer.from(name)];

    expect(await ssh.ask(extension("query"))).toEqual([5]);
    expect(await ssh.ask(extension("session-bind@openssh.comX"))).toEqual([5]);
    expect(agent.saw).toEqual([]);
  });

  it("hands a spawn the socket only while the Shell's switch is on", async () => {
    const socketPath = await projectSocket();

    setSwitch(false);
    expect(await spawnSocket(false)).toBeNull();
    expect(hostSide.isForwarding(PROJECT)).toBe(false);

    setSwitch(true);
    expect(await spawnSocket(true)).toBe(socketPath);
    expect(hostSide.isForwarding(PROJECT)).toBe(true);
  });

  it("answers an agent failure when nobody forwards an agent, instead of hanging", async () => {
    const socketPath = await projectSocket();
    setTarget({ kind: "vacant" });
    const ssh = await connectAgentClient(socketPath);

    expect(await ssh.ask([11])).toEqual([5]);
    expect(await ssh.ask([13, 0, 0, 0, 0])).toEqual([5]);
    expect(agent.saw).toEqual([]);
  });

  it("answers a failure when the driver is this machine's own window", async () => {
    const socketPath = await projectSocket();
    setTarget({
      ...liveTarget(),
      endpoint: { kind: "local-view" } as ClientEndpoint,
    } as DriveTarget);
    const ssh = await connectAgentClient(socketPath);

    expect(await ssh.ask([11])).toEqual([5]);
  });

  it("closes a connection once its Shell stops driving, and sends new ones to the new driver", async () => {
    const pair = await openSessionPair(dir);
    cleanups.push(() => {
      pair.host.close("test over");
      pair.client.close("test over");
    });
    const otherAgent = await startFakeAgent(path.join(dir, "fb.sock"));
    cleanups.push(() => new Promise<void>((resolve) => otherAgent.server.close(() => resolve())));
    const other = { sessionId: OTHER_SESSION_ID, session: pair.host };
    hostSessions.push(other);
    for (const listener of sessionListeners) listener(other);
    installShell(pair.client, otherAgent.path);
    const socketPath = await projectSocket();
    const ssh = await connectAgentClient(socketPath);
    expect(await ssh.ask([11])).toEqual(IDENTITIES_ANSWER);
    expect(agent.open.size).toBe(1);

    setTarget(liveTarget(OTHER_SESSION_ID));

    await waitFor(() => ssh.isClosed() && agent.open.size === 0);
    const next = await connectAgentClient(socketPath);
    expect(await next.ask([11])).toEqual(IDENTITIES_ANSWER);
    expect(otherAgent.saw).toEqual([{ connection: 1, body: [11] }]);
    expect(agent.saw).toHaveLength(1);
  });

  it("closes the Shell's agent connections and refuses at once when its switch goes off", async () => {
    const socketPath = await projectSocket();
    const open = await connectAgentClient(socketPath);
    expect(await open.ask([11])).toEqual(IDENTITIES_ANSWER);
    // One the host's forwarder knows nothing of, so only the Shell can close it.
    expect(await relayDirect(42, [11])).toEqual({ message: Uint8Array.from(IDENTITIES_ANSWER) });
    expect(agent.open.size).toBe(2);

    setSwitch(false);

    await waitFor(() => agent.open.size === 0);
    await expect(relayDirect(42, [11])).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await relayDirect(99, [11])).toEqual({ message: Uint8Array.of(5) });
    await waitFor(() => open.isClosed());
    expect(agent.saw).toHaveLength(2);
  });

  it("keeps an answer the agent gave after the last window on the host closed", async () => {
    let releaseSign!: () => void;
    signDelay = new Promise((resolve) => (releaseSign = resolve));
    const pending = relayDirect(8, [13, 0, 0, 0, 0]).catch((error: unknown) => error);
    await waitFor(() => agent.saw.length === 1);

    views = false;
    releaseSign();

    expect(await pending).toMatchObject({ code: "CANCELLED" });
    await waitFor(() => agent.open.size === 0);
  });

  it("closes a connection the moment its driver's lease is only reserved, before the agent answers", async () => {
    const ssh = await connectAgentClient(await projectSocket());
    let releaseSign!: () => void;
    signDelay = new Promise((resolve) => (releaseSign = resolve));
    ssh.send([13, 0, 0, 0, 0]);
    await waitFor(() => agent.saw.length === 1);

    // The driver's view left: its lease is reserved, with no holder change to say so.
    const live = liveTarget() as Extract<DriveTarget, { kind: "live" }>;
    target = { kind: "reserved", holder: live.holder };
    for (const listener of routeListeners) listener();

    await waitFor(() => ssh.isClosed());
    releaseSign();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ssh.replies).toEqual([]);
  });

  it("signs nothing for a host none of this Shell's windows is on", async () => {
    views = false;

    expect(await relayDirect(5, [11])).toEqual({ message: Uint8Array.of(5) });
    expect(agent.saw).toEqual([]);
  });

  it("forwards nothing when this computer's ssh config can't be read", async () => {
    shellSide.dispose();
    const pair = await openSessionPair(dir);
    cleanups.push(() => {
      pair.host.close("test over");
      pair.client.close("test over");
    });
    installShell(
      pair.client,
      agent.path,
      async () => {
        throw new Error("ssh -G timed out");
      },
      // The default agent is right there: it still isn't used in place of the configured one.
      { SSH_AUTH_SOCK: agent.path }
    );

    const reply = await pair.host.call(AgentForwardMethod.REQUEST, {
      connectionId: 1,
      message: Uint8Array.of(11),
    });

    expect(reply).toEqual({ message: Uint8Array.of(5) });
    expect(agent.saw).toEqual([]);
  });

  it("never opens an agent connection for a host connection closed while it was opening", async () => {
    let releaseConfig!: () => void;
    sshConfigGate = new Promise((resolve) => (releaseConfig = resolve));
    const pending = relayDirect(3, [11]).catch((error: unknown) => error);

    await host.call(AgentForwardMethod.CLOSE, { connectionId: 3 });
    releaseConfig();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(agent.accepted()).toBe(0);
    expect(agent.saw).toEqual([]);
  });

  it("closes a host connection whose agent connection ended, rather than opening a fresh one", async () => {
    const ssh = await connectAgentClient(await projectSocket());
    expect(await ssh.ask([11])).toEqual(IDENTITIES_ANSWER);

    for (const socket of agent.open) socket.destroy();
    await waitFor(() => agent.open.size === 0);
    ssh.send([11]);

    await waitFor(() => ssh.isClosed());
    expect(agent.saw).toHaveLength(1);
  });

  it("closes a connection whose link goes down", async () => {
    const ssh = await connectAgentClient(await projectSocket());
    expect(await ssh.ask([11])).toEqual(IDENTITIES_ANSWER);

    client.close("gone");

    await waitFor(() => ssh.isClosed() && agent.open.size === 0);
  });

  it("closes a connection that sends a length over the agent's ceiling", async () => {
    const ssh = await connectAgentClient(await projectSocket());
    const header = Buffer.alloc(4);
    header.writeUInt32BE(256 * 1024 + 1, 0);

    ssh.socket.write(header);

    await waitFor(() => ssh.isClosed());
  });

  it("reports the host's IdentityAgent as a terminal there sees it, and whether this computer's agent answers", async () => {
    expect(await shellSide.check(HOST_ID)).toEqual({
      localAgent: true,
      hostIdentityAgent: "SSH_AUTH_SOCK",
    });
  });

  it("reports no local agent for a missing socket or one its agent left behind", async () => {
    // An agent that exits without closing its listener leaves the file behind.
    const stale = path.join(dir, "stale.sock");
    execFileSync(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(stale)}, () => process.exit(0))`,
    ]);
    expect((await fs.lstat(stale)).isSocket()).toBe(true);

    shellSide.dispose();
    const missing = installShell(client, path.join(dir, "nothing-here.sock"));
    expect((await missing.check(HOST_ID)).localAgent).toBe(false);
    missing.dispose();

    const crashed = installShell(client, stale);
    expect((await crashed.check(HOST_ID)).localAgent).toBe(false);
  });

  it("puts the socket in a short folder when the usual path wouldn't fit", async () => {
    await hostSide.dispose();
    hostSide = installHost(path.join(dir, "x".repeat(110)));
    // Said again to the new start, as a fresh link would.
    setSwitch(false);
    setSwitch(true);

    const socketPath = await projectSocket();

    expect(path.dirname(socketPath)).toBe(path.join(dir, "fb"));
    const ssh = await connectAgentClient(socketPath);
    expect(await ssh.ask([11])).toEqual(IDENTITIES_ANSWER);
  });

  it("refuses to check a host that isn't in the list", async () => {
    await expect(shellSide.check("nobody")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
