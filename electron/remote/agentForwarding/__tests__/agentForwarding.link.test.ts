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
import { AgentMessageReader, frameAgentMessage } from "../protocol.js";

const HOST_ID = "studio-01";
const PROJECT = "project-a";
const SESSION_ID = "session-1";

const IDENTITIES_ANSWER = Uint8Array.of(12, 0, 0, 0, 0);
const SIGN_RESPONSE = Uint8Array.of(14, 0, 0, 0, 1, 7);

let dir: string;
let host: LinkSession;
let client: LinkSession;
let agentPath: string;
let agentServer: net.Server;
/** Request types the fake agent on the Shell received, in order. */
let agentSaw: number[];
let signDelay: Promise<void>;
let target: DriveTarget;
let leaseListeners: Array<(state: { projectId: string }) => void>;
let switchOn: boolean;
let registryListeners: Array<() => void>;
let hostSide: HostAgentForwarding;
let shellSide: AgentForwardingClient;
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

function startFakeAgent(socketPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    const reader = new AgentMessageReader();
    socket.on("data", async (chunk) => {
      for (const body of reader.push(chunk)) {
        agentSaw.push(body[0]!);
        if (body[0] === 13) await signDelay;
        socket.write(frameAgentMessage(body[0] === 11 ? IDENTITIES_ANSWER : SIGN_RESPONSE));
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
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
  agentSaw = [];
  signDelay = Promise.resolve();
  agentPath = path.join(dir, "fa.sock");
  agentServer = await startFakeAgent(agentPath);
  target = liveTarget();
  leaseListeners = [];
  switchOn = true;
  registryListeners = [];

  hostSide = installHostAgentForwarding({
    server: {
      sessions: [{ sessionId: SESSION_ID, session: host }],
      onSession: () => () => {},
    },
    lease: {
      getDriveTarget: () => target,
      onChange(listener) {
        leaseListeners.push(listener);
        return () => {};
      },
    },
    socketDir: path.join(dir, "agent"),
    readSshConfig: async () => "user me\nidentityagent SSH_AUTH_SOCK\n",
  });
  shellSide = installAgentForwardingClient({
    manager: {
      onSessionOpened(listener) {
        listener(HOST_ID, client);
        return () => {};
      },
    },
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
    sessionFor: () => client,
    readSshConfig: async () => `identityagent ${agentPath}\n`,
    platform: "darwin",
    env: {},
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  shellSide.dispose();
  await hostSide.dispose();
  host.close("test over");
  client.close("test over");
  await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  await removeTempDir(dir);
});

/** What a spawn would be handed once the host has heard the Shell's latest switch. */
async function spawnSocket(expectSocket: boolean): Promise<string | null> {
  for (let i = 0; i < 200; i++) {
    const socketPath = await hostSide.socketForSpawn(PROJECT);
    if ((socketPath !== null) === expectSocket) return socketPath;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(expectSocket ? "no socket for the project" : "still handed a socket");
}

async function projectSocket(): Promise<string> {
  return (await spawnSocket(true))!;
}

describe("agent forwarding over a link", () => {
  it("carries a request to the driving Shell's agent and returns its reply", async () => {
    const agent = await connectAgentClient(await projectSocket());

    expect(await agent.ask([11])).toEqual([...IDENTITIES_ANSWER]);
    expect(agentSaw).toEqual([11]);
  });

  it("keeps the socket owner-only, at a path that stays the project's", async () => {
    const socketPath = await projectSocket();

    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect(await hostSide.socketForSpawn(PROJECT)).toBe(socketPath);
  });

  it("refuses requests to change keys on the Shell, in order with the ones it forwards", async () => {
    const agent = await connectAgentClient(await projectSocket());
    let releaseSign!: () => void;
    signDelay = new Promise((resolve) => (releaseSign = resolve));

    // A slow signature, then an add, a remove-all and a lock queued behind it.
    agent.send([13, 0, 0, 0, 0], [17, 1, 2], [19], [22, 0, 0, 0, 0]);
    await waitFor(() => agentSaw.length === 1);
    expect(agent.replies).toEqual([]);
    releaseSign();
    await waitFor(() => agent.replies.length === 4);

    expect(agent.replies).toEqual([[...SIGN_RESPONSE], [5], [5], [5]]);
    expect(agentSaw).toEqual([13]);
  });

  it("refuses every extension but session-bind", async () => {
    const agent = await connectAgentClient(await projectSocket());
    const extension = (name: string) => [27, 0, 0, 0, name.length, ...Buffer.from(name)];

    expect(await agent.ask(extension("query"))).toEqual([5]);
    expect(await agent.ask(extension("session-bind@openssh.comX"))).toEqual([5]);
    expect(await agent.ask(extension("session-bind@openssh.com"))).toEqual([...SIGN_RESPONSE]);
    expect(agentSaw).toEqual([27]);
  });

  it("hands no socket to a spawn until the Shell's switch is on", async () => {
    setSwitch(false);
    expect(await spawnSocket(false)).toBeNull();

    setSwitch(true);

    expect(await projectSocket()).toContain(path.join(dir, "agent"));
  });

  it("answers an agent failure when nobody forwards an agent, instead of hanging", async () => {
    const socketPath = await projectSocket();
    setTarget({ kind: "vacant" });
    const agent = await connectAgentClient(socketPath);

    expect(await agent.ask([11])).toEqual([5]);
    expect(await agent.ask([13, 0, 0, 0, 0])).toEqual([5]);
    expect(agentSaw).toEqual([]);
  });

  it("answers a failure when the driver is this machine's own window", async () => {
    const socketPath = await projectSocket();
    setTarget({
      ...liveTarget(),
      endpoint: { kind: "local-view" } as ClientEndpoint,
    } as DriveTarget);
    const agent = await connectAgentClient(socketPath);

    expect(await agent.ask([11])).toEqual([5]);
  });

  it("closes a connection once its Shell stops driving the project", async () => {
    const agent = await connectAgentClient(await projectSocket());
    expect(await agent.ask([11])).toEqual([...IDENTITIES_ANSWER]);

    setTarget(liveTarget("another-session"));

    await waitFor(() => agent.isClosed());
  });

  it("closes connections and refuses at once when the Shell's switch goes off", async () => {
    const socketPath = await projectSocket();
    const open = await connectAgentClient(socketPath);
    expect(await open.ask([11])).toEqual([...IDENTITIES_ANSWER]);

    setSwitch(false);

    await waitFor(() => open.isClosed());
    const fresh = await connectAgentClient(socketPath);
    expect(await fresh.ask([11])).toEqual([5]);
    expect(agentSaw).toEqual([11]);
  });

  it("closes a connection whose link goes down", async () => {
    const agent = await connectAgentClient(await projectSocket());
    expect(await agent.ask([11])).toEqual([...IDENTITIES_ANSWER]);

    client.close("gone");

    await waitFor(() => agent.isClosed());
  });

  it("closes a connection that sends a length over the agent's ceiling", async () => {
    const socketPath = await projectSocket();
    const agent = await connectAgentClient(socketPath);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(256 * 1024 + 1, 0);

    sockets.at(-1)!.write(header);

    await waitFor(() => agent.isClosed());
  });

  it("reports the host's IdentityAgent and whether this computer has an agent", async () => {
    expect(await shellSide.check(HOST_ID)).toEqual({
      localAgent: true,
      hostIdentityAgent: "SSH_AUTH_SOCK",
    });
  });

  it("removes the project's socket when it stops", async () => {
    const socketPath = await projectSocket();

    await hostSide.dispose();

    await expect(fs.lstat(socketPath)).rejects.toThrow();
  });
});
