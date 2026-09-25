import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation } from "../../host/hostSocketPath.js";
import { LinkClient, type LinkClientState } from "../LinkClient.js";
import {
  PROBE_COMMAND,
  SshTransport,
  buildCatArgs,
  buildForwardArgs,
  buildMuxForwardArgs,
  buildProbeArgs,
  controlPathFor,
  isValidSshTarget,
  parseProbeOutput,
  type SshChild,
  type SshSpawner,
} from "../sshTransport.js";
import { TransportError } from "../transport.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";

const COMMON = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=10m",
  "-o",
  "ControlPath=/cp/cm-%C",
];

describe("ssh argument construction", () => {
  it("builds the probe, discovery read and forward commands", () => {
    expect(buildProbeArgs("studio", "/cp/cm-%C")).toEqual([
      ...COMMON,
      "--",
      "studio",
      PROBE_COMMAND,
    ]);
    expect(
      buildCatArgs(
        "greg@studio",
        "/cp/cm-%C",
        "/Users/g/Library/Application Support/Daintree/host.json"
      )
    ).toEqual([
      ...COMMON,
      "--",
      "greg@studio",
      "cat -- '/Users/g/Library/Application Support/Daintree/host.json'",
    ]);
    expect(
      buildMuxForwardArgs("studio", "/cp/cm-%C", "/l/l.sock", "/run/user/1/daintree/host.sock")
    ).toEqual([
      "-o",
      "ControlPath=/cp/cm-%C",
      "-O",
      "forward",
      "-L",
      "/l/l.sock:/run/user/1/daintree/host.sock",
      "--",
      "studio",
    ]);
    expect(buildForwardArgs("studio", "/l/l.sock", "/run/user/1/daintree/host.sock")).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlPath=none",
      "-o",
      "StreamLocalBindUnlink=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      "/l/l.sock:/run/user/1/daintree/host.sock",
      "--",
      "studio",
    ]);
  });

  it("single-quotes the remote path and refuses ones it cannot quote portably", () => {
    expect(buildCatArgs("s", "/cp", "/home/o'brien/$(x)").at(-1)).toBe(
      "cat -- '/home/o'\\''brien/$(x)'"
    );
    expect(() => buildCatArgs("s", "/cp", "relative/x")).toThrow(TransportError);
    expect(() => buildCatArgs("s", "/cp", "/a\\b")).toThrow(TransportError);
    expect(() => buildCatArgs("s", "/cp", "/a\nb")).toThrow(TransportError);
  });

  it("only accepts targets that cannot be read as options", () => {
    expect(isValidSshTarget("greg@studio-01.tailnet.ts.net")).toBe(true);
    expect(isValidSshTarget("studio")).toBe(true);
    expect(isValidSshTarget("-oProxyCommand=evil")).toBe(false);
    expect(isValidSshTarget("a b")).toBe(false);
    expect(() => new SshTransport({ target: "-x", clientDir: "/tmp/x" })).toThrow(TransportError);
  });

  it("uses cm-%C when it fits and a short hash when it would not", () => {
    expect(controlPathFor("/Users/g/.config/Daintree/ssh", "studio", "darwin")).toBe(
      "/Users/g/.config/Daintree/ssh/cm-%C"
    );
    const long = "/Users/somebody/Library/Application Support/Daintree/ssh";
    const hashed = controlPathFor(long, "studio", "darwin");
    expect(hashed).toMatch(/\/cm-[0-9a-f]{16}$/);
    expect(controlPathFor(long, "studio", "darwin")).toBe(hashed);
    expect(controlPathFor(long, "other", "darwin")).not.toBe(hashed);
  });
});

describe("probe parsing", () => {
  it("reads platform, uid and home from the last three lines", () => {
    expect(parseProbeOutput("Linux\n1000\n/home/greg\n")).toEqual({
      platform: "linux",
      uid: 1000,
      home: "/home/greg",
    });
    expect(parseProbeOutput("welcome banner\r\nDarwin\r\n501\r\n/Users/greg\r\n")).toEqual({
      platform: "darwin",
      uid: 501,
      home: "/Users/greg",
    });
  });

  it("rejects anything it does not recognise", () => {
    expect(parseProbeOutput("")).toBeNull();
    expect(parseProbeOutput("FreeBSD\n1000\n/home/g\n")).toBeNull();
    expect(parseProbeOutput("Linux\nroot\n/root\n")).toBeNull();
    expect(parseProbeOutput("Linux\n0\nrelative\n")).toBeNull();
    expect(parseProbeOutput("Linux\n0\n/home/o\\b\n")).toBeNull();
  });
});

/** Stand in for an ssh `-L` forward: a local socket piped to the host socket. */
function fakeForward(args: string[]): net.Server {
  const spec = args[args.indexOf("-L") + 1]!;
  const [local, remote] = spec.split(":") as [string, string];
  const proxy = net.createServer((conn) => {
    const upstream = net.connect(remote);
    conn.pipe(upstream).pipe(conn);
    conn.on("error", () => upstream.destroy());
    upstream.on("error", () => conn.destroy());
  });
  proxy.listen(local);
  return proxy;
}

class FakeChild extends EventEmitter implements SshChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  finish(code: number, stdout = "", stderr = ""): void {
    setImmediate(() => {
      this.stdout.end(stdout);
      this.stderr.end(stderr);
      this.emit("exit", code, null);
    });
  }
}

let root: string;
let server: HostServer | null = null;
let client: LinkClient | null = null;

beforeEach(async () => {
  root = await makeTempDir();
});

afterEach(async () => {
  await client?.stop();
  await server?.close();
  client = null;
  server = null;
  await removeTempDir(root);
});

describe("SshTransport with an injected ssh", () => {
  it("probes, reads the discovery file, forwards the socket and connects", async () => {
    const hostLoc = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "h") });
    server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: "studio" });
    await server.listen();
    const calls: string[][] = [];
    const proxies: net.Server[] = [];
    const spawner: SshSpawner = (args) => {
      calls.push(args);
      const child = new FakeChild();
      const command = args.at(-1)!;
      if (command === PROBE_COMMAND) {
        child.finish(0, "Linux\n4242\n/home/greg\n");
      } else if (command.startsWith("cat -- ")) {
        expect(command).toBe("cat -- '/run/user/4242/daintree/host.json'");
        child.finish(
          0,
          JSON.stringify({
            version: 1,
            socketPath: hostLoc.socketPath,
            token: server!.token,
            pid: 1,
          })
        );
      } else if (args.includes("forward")) {
        proxies.push(fakeForward(args));
        child.finish(0);
      } else {
        child.finish(0);
      }
      return child;
    };
    const clientDir = path.join(root, "c");
    client = new LinkClient({
      transport: new SshTransport({ target: "greg@studio", clientDir, spawn: spawner }),
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c1", clientName: "mbp", platform: "darwin" },
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    });
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    expect(calls[0]).toEqual(
      buildProbeArgs("greg@studio", controlPathFor(clientDir, "greg@studio"))
    );
    expect(calls[2]!.slice(0, 5)).toEqual([
      "-o",
      `ControlPath=${controlPathFor(clientDir, "greg@studio")}`,
      "-O",
      "forward",
      "-L",
    ]);
    expect(calls[2]![5]).toMatch(new RegExp(`^${clientDir}/l-[0-9a-f]{8}-[0-9a-f]{8}\\.sock:`));

    await client.stop();
    client = null;
    // Dispose cancels the forward through the control master.
    expect(calls.some((a) => a.includes("-O") && a.includes("cancel"))).toBe(true);
    for (const p of proxies) p.close();
  });

  it("falls back to a dedicated forward when no master is running", async () => {
    const hostLoc = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "h") });
    server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: "studio" });
    await server.listen();
    const proxies: net.Server[] = [];
    const children: FakeChild[] = [];
    const spawner: SshSpawner = (args) => {
      const child = new FakeChild();
      children.push(child);
      const command = args.at(-1)!;
      if (command === PROBE_COMMAND) child.finish(0, "Darwin\n501\n/Users/g\n");
      else if (command.startsWith("cat -- "))
        child.finish(
          0,
          JSON.stringify({
            version: 1,
            socketPath: hostLoc.socketPath,
            token: server!.token,
            pid: 1,
          })
        );
      else if (args.includes("forward")) child.finish(255, "", "no master\n");
      else if (args.includes("-N")) proxies.push(fakeForward(args));
      else child.finish(0);
      return child;
    };
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
    });
    const conn = await transport.open(new AbortController().signal);
    expect(conn.token).toBe(server.token);
    const dedicated = children.at(-1)!;
    expect(dedicated.killed).toBe(false);
    await conn.dispose();
    expect(dedicated.killed).toBe(true);
    for (const p of proxies) p.close();
  });

  it("reports ssh's own stderr when the host cannot be reached", async () => {
    const stderr = "ssh: connect to host studio port 22: Connection refused";
    const spawner: SshSpawner = () => {
      const child = new FakeChild();
      child.finish(255, "", `${stderr}\n`);
      return child;
    };
    client = new LinkClient({
      transport: new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: spawner,
      }),
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c1", clientName: "mbp", platform: "darwin" },
      backoff: { initialMs: 60_000 },
    });
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    const state = client.getState() as Extract<LinkClientState, { status: "unreachable" }>;
    expect(state.detail).toBe(stderr);
    expect(state.lastSeenAt).toBeNull();
  });

  it("reports the forward's stderr when the forward fails", async () => {
    const spawner: SshSpawner = (args) => {
      const child = new FakeChild();
      const command = args.at(-1)!;
      if (command === PROBE_COMMAND) child.finish(0, "Darwin\n501\n/Users/g\n");
      else if (command.startsWith("cat -- "))
        child.finish(
          0,
          JSON.stringify({ version: 1, socketPath: "/x/host.sock", token: "a".repeat(64), pid: 1 })
        );
      else if (args.includes("forward"))
        child.finish(255, "", "Control socket connect(/c/cm): No such file or directory\n");
      else if (args.includes("-N"))
        child.finish(255, "", "Error: remote port forwarding failed for listen path\n");
      else child.finish(0);
      return child;
    };
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
    });
    await expect(transport.open(new AbortController().signal)).rejects.toMatchObject({
      detail: "Error: remote port forwarding failed for listen path",
    });
  });

  it("reports a missing discovery file with ssh's stderr", async () => {
    const spawner: SshSpawner = (args) => {
      const child = new FakeChild();
      if (args.at(-1) === PROBE_COMMAND) child.finish(0, "Linux\n1000\n/home/g\n");
      else
        child.finish(1, "", "cat: /run/user/1000/daintree/host.json: No such file or directory\n");
      return child;
    };
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
    });
    await expect(transport.open(new AbortController().signal)).rejects.toMatchObject({
      detail: "cat: /run/user/1000/daintree/host.json: No such file or directory",
    });
  });
});
