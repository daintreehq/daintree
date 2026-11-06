import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation, remoteHostSocketLocation } from "../../host/hostSocketPath.js";
import { LinkClient, type LinkClientState } from "../LinkClient.js";
import { bridgeChild, type BridgeChild } from "../../__tests__/harness/bridgeChild.js";
import {
  PROBE_COMMAND,
  SSH_COMMAND_TIMEOUT_MS,
  SshTransport,
  attachCommandFor,
  buildAttachArgs,
  buildCancelArgs,
  buildCatArgs,
  closeSshMaster,
  closeSshMasters,
  isStreamLocalRefusal,
  buildForwardArgs,
  buildMuxForwardArgs,
  buildProbeArgs,
  buildStreamLocalCheckArgs,
  controlPathFor,
  controlPathOption,
  exitStaleSshMasters,
  isForwardablePath,
  isValidSshTarget,
  parseDiscoveryRead,
  parseProbeOutput,
  type SshChild,
  type SshSpawner,
  type SshStreamSpawner,
} from "../sshTransport.js";
import { remoteShellArgs, scpArgs } from "../remoteShell.js";
import { HostModeOffError, SshAccessError, TransportError } from "../transport.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";

const COMMON = [
  "-o",
  "IgnoreUnknown=*",
  "-o",
  "RemoteCommand=none",
  "-o",
  "RequestTTY=no",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=10m",
  "-o",
  'ControlPath="/cp/cm-%C"',
];

describe("ssh argument construction", () => {
  it("quotes the control path so ssh keeps a path with spaces as one value", () => {
    expect(controlPathOption("/Users/g/Library/Application Support/Daintree/rh/cm-%C")).toBe(
      'ControlPath="/Users/g/Library/Application Support/Daintree/rh/cm-%C"'
    );
    expect(controlPathOption('/tmp/a"b\\c/cm-%C')).toBe('ControlPath="/tmp/a\\"b\\\\c/cm-%C"');
  });

  it("overrides the user's RemoteCommand and RequestTTY on every call that names a command", () => {
    const calls = [
      buildProbeArgs("studio", "/cp/cm-%C"),
      buildCatArgs("studio", "/cp/cm-%C", "/home/g/host.json"),
      buildAttachArgs("studio", "/cp/cm-%C", "daintree --attach-stdio"),
      buildStreamLocalCheckArgs("studio", "/cp/cm-%C", "/run/user/1/daintree/host.sock"),
      remoteShellArgs("studio", "/cp/cm-%C", "true"),
      scpArgs("studio", "/cp/cm-%C", "/tmp/a", "/tmp/b", "ssh"),
    ];
    for (const args of calls) {
      const ignore = args.indexOf("IgnoreUnknown=*");
      expect(ignore).toBeGreaterThan(-1);
      expect(args.indexOf("RemoteCommand=none")).toBeGreaterThan(ignore);
      expect(args).toContain("RequestTTY=no");
    }
  });

  // ssh's connect timeout applies per address, so a host whose IPv6 and IPv4
  // routes both drop packets takes two of them: both must end before the
  // command deadline, or the deadline cuts ssh off before it says why.
  it("lets ssh give up on an unreachable host before the command deadline, on every call that can dial", () => {
    const calls = [
      buildProbeArgs("studio", "/cp/cm-%C"),
      buildCatArgs("studio", "/cp/cm-%C", "/home/g/host.json"),
      buildAttachArgs("studio", "/cp/cm-%C", "daintree --attach-stdio"),
      buildStreamLocalCheckArgs("studio", "/cp/cm-%C", "/run/user/1/daintree/host.sock"),
      buildForwardArgs("studio", "/l/l.sock", "/run/user/1/daintree/host.sock"),
      remoteShellArgs("studio", "/cp/cm-%C", "true"),
      scpArgs("studio", "/cp/cm-%C", "/tmp/a", "/tmp/b", "ssh"),
    ];
    for (const args of calls) {
      const timeouts = args
        .filter((arg) => arg.startsWith("ConnectTimeout="))
        .map((arg) => Number(arg.slice("ConnectTimeout=".length)));
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeGreaterThan(0);
      expect(2 * timeouts[0]! * 1000).toBeLessThan(SSH_COMMAND_TIMEOUT_MS);
    }
  });

  it("builds the probe, discovery read and forward commands", () => {
    expect(buildProbeArgs("studio", "/cp/cm-%C")).toEqual([
      ...COMMON,
      "--",
      "studio",
      PROBE_COMMAND,
    ]);
    const read = buildCatArgs(
      "greg@studio",
      "/cp/cm-%C",
      "/Users/g/Library/Application Support/Daintree/host.json"
    );
    expect(read.slice(0, -1)).toEqual([...COMMON, "--", "greg@studio"]);
    // One quoted script with no quote of its own, and the path as its argument.
    expect(read.at(-1)).toMatch(
      /^sh -c '[^']*' sh '\/Users\/g\/Library\/Application Support\/Daintree\/host\.json'$/
    );
    expect(
      buildMuxForwardArgs("studio", "/cp/cm-%C", "/l/l.sock", "/run/user/1/daintree/host.sock")
    ).toEqual([
      "-o",
      'ControlPath="/cp/cm-%C"',
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
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=4",
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
    expect(buildCatArgs("s", "/cp", "/home/o'brien/$(x)").at(-1)).toMatch(
      / sh '\/home\/o'\\''brien\/\$\(x\)'$/
    );
    expect(() => buildCatArgs("s", "/cp", "relative/x")).toThrow(TransportError);
    expect(() => buildCatArgs("s", "/cp", "/a\\b")).toThrow(TransportError);
    expect(() => buildCatArgs("s", "/cp", "/a\nb")).toThrow(TransportError);
  });

  it("refuses remote socket paths ssh would expand against this machine's environment", () => {
    expect(isForwardablePath("/run/user/1/daintree/host.sock")).toBe(true);
    expect(isForwardablePath("/Users/g/Library/Application Support/Daintree/host.sock")).toBe(true);
    const unsafe = [
      "/x/${OPENAI_API_KEY}/host.sock",
      "/x/%u/host.sock",
      "/x:y",
      "relative/host.sock",
      "/x\\y",
      "/x\ny",
      "/x\ry",
      "/x\ty",
      "/x\u0000y",
      "/x\u007fy",
    ];
    for (const bad of unsafe) {
      expect(isForwardablePath(bad)).toBe(false);
      expect(() => buildStreamLocalCheckArgs("s", "/cp", bad)).toThrow(TransportError);
      expect(() => buildMuxForwardArgs("s", "/cp", "/l.sock", bad)).toThrow(TransportError);
      expect(() => buildForwardArgs("s", "/l.sock", bad)).toThrow(TransportError);
      expect(() => buildCancelArgs("s", "/cp", "/l.sock", bad)).toThrow(TransportError);
    }
  });

  it("only accepts targets that cannot be read as options", () => {
    expect(isValidSshTarget("greg@studio-01.tailnet.ts.net")).toBe(true);
    expect(isValidSshTarget("studio")).toBe(true);
    expect(isValidSshTarget("-oProxyCommand=evil")).toBe(false);
    expect(isValidSshTarget("a b")).toBe(false);
    expect(() => new SshTransport({ target: "-x", clientDir: "/tmp/x" })).toThrow(TransportError);
  });

  it("uses cm3-%C when it fits and a short hash when it would not", () => {
    expect(controlPathFor("/Users/g/.config/Daintree/ssh", "studio", "darwin")).toBe(
      "/Users/g/.config/Daintree/ssh/cm3-%C"
    );
    const long = "/Users/somebody/Library/Application Support/Daintree/ssh";
    const hashed = controlPathFor(long, "studio", "darwin");
    expect(hashed).toMatch(/\/cm3-[0-9a-f]{16}$/);
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

describe("discovery read parsing", () => {
  const info = {
    version: 1,
    socketPath: "/run/user/1000/daintree/host.sock",
    token: "a".repeat(64),
    pid: 7,
  };
  const framed = `\n@@dt:discovery\n${JSON.stringify(info)}\n@@dt:discovery-end\n`;

  it("reads the file between its markers, whatever the shell printed around them", () => {
    expect(parseDiscoveryRead(framed)).toEqual(info);
    expect(parseDiscoveryRead(`Welcome to studio\r\nloaded .zshenv\n${framed}`)).toEqual(info);
    expect(parseDiscoveryRead(`no newline after this${framed}`)).toEqual(info);
    expect(parseDiscoveryRead(`${framed}logout: bye\n`)).toEqual(info);
    // Startup output comes first, so the read's own frame is the last one.
    const echoed = `\n@@dt:discovery\n${JSON.stringify({ ...info, pid: 1 })}\n@@dt:discovery-end\n`;
    expect(parseDiscoveryRead(`${echoed}${framed}`)).toEqual(info);
  });

  it("rejects a read that didn't arrive whole between its markers", () => {
    expect(parseDiscoveryRead("")).toBeNull();
    expect(parseDiscoveryRead(JSON.stringify(info))).toBeNull();
    expect(parseDiscoveryRead(framed.slice(0, framed.indexOf("\n@@dt:discovery-end")))).toBeNull();
    expect(
      parseDiscoveryRead(`\n@@dt:discovery-end\n${JSON.stringify(info)}\n@@dt:discovery\n`)
    ).toBeNull();
    expect(parseDiscoveryRead("\n@@dt:discovery\n\n@@dt:discovery-end\n")).toBeNull();
    expect(parseDiscoveryRead('\n@@dt:discovery\n{"version":1}\n@@dt:discovery-end\n')).toBeNull();
  });
});

/**
 * Where the client expects each fake host's socket, from what its probe
 * answers. The test servers listen in a temp dir; the fake forward maps the
 * expected path onto it.
 */
const LINUX_SOCKET = remoteHostSocketLocation({
  platform: "linux",
  uid: 4242,
  home: "/home/greg",
}).socketPath;
const DARWIN_SOCKET = remoteHostSocketLocation({
  platform: "darwin",
  uid: 501,
  home: "/Users/g",
}).socketPath;

/**
 * Stand in for an ssh `-L` forward: a local socket piped to the test host's
 * real socket, once the forward is checked to name the expected remote path.
 */
function fakeForward(args: string[], expectedRemote: string, realSocket: string): net.Server {
  const spec = args[args.indexOf("-L") + 1]!;
  const parts = spec.split(":");
  expect(parts).toHaveLength(2);
  const [local, remote] = parts as [string, string];
  expect(remote).toBe(expectedRemote);
  const proxy = net.createServer((conn) => {
    const upstream = net.connect(realSocket);
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

/** The discovery read: the one command that names the host's discovery file. */
function isDiscoveryRead(command: string | undefined): boolean {
  return command?.startsWith("sh -c ") === true && command.endsWith("host.json'");
}

/** What the read prints for a discovery file holding `info`: the file between its markers. */
function discoveryReply(info: object): string {
  return `\n@@dt:discovery\n${JSON.stringify(info)}\n@@dt:discovery-end\n`;
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
  it("reports a refused login as one retrying won't fix, and never tries to start the host", async () => {
    const calls: string[][] = [];
    const ensureRunning = vi.fn(async () => true);
    const spawner: SshSpawner = (args) => {
      calls.push(args);
      const child = new FakeChild();
      child.finish(255, "", "greg@studio: Permission denied (publickey).\n");
      return child;
    };
    const transport = new SshTransport({
      target: "greg@studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
      ensureRunning,
    });
    const opened = transport.open(new AbortController().signal);
    await expect(opened).rejects.toBeInstanceOf(SshAccessError);
    await expect(opened).rejects.toMatchObject({
      detail: "greg@studio: Permission denied (publickey).",
    });
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("leaves an ordinary unreachable host to the usual retries", async () => {
    const spawner: SshSpawner = () => {
      const child = new FakeChild();
      child.finish(255, "", "ssh: connect to host studio port 22: Connection refused\n");
      return child;
    };
    const transport = new SshTransport({
      target: "greg@studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
    });
    const error = await transport.open(new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(SshAccessError);
  });

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
      } else if (isDiscoveryRead(command)) {
        expect(command.endsWith(" sh '/run/user/4242/daintree/host.json'")).toBe(true);
        child.finish(
          0,
          discoveryReply({
            version: 1,
            socketPath: LINUX_SOCKET,
            token: server!.token,
            pid: 1,
          })
        );
      } else if (args[0] === "-G") {
        child.finish(0, "controlpath /cp/cm1-resolved\n");
      } else if (args.includes("forward")) {
        proxies.push(fakeForward(args, LINUX_SOCKET, hostLoc.socketPath));
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
    // One channel to the host socket first: the server's answer decides the route.
    expect(calls[2]).toEqual(
      buildStreamLocalCheckArgs(
        "greg@studio",
        controlPathFor(clientDir, "greg@studio"),
        LINUX_SOCKET
      )
    );
    expect(calls[3]).toEqual([
      "-G",
      "-o",
      controlPathOption(controlPathFor(clientDir, "greg@studio")),
      "--",
      "greg@studio",
    ]);
    // The forward names the master by its expanded path and reads no config,
    // so the user's own forwards for this host aren't sent with it.
    expect(calls[4]!.slice(0, 7)).toEqual([
      "-F",
      "/dev/null",
      "-o",
      'ControlPath="/cp/cm1-resolved"',
      "-O",
      "forward",
      "-L",
    ]);
    const spec = calls[4]![7]!;
    expect(spec).toMatch(new RegExp(`^${clientDir}/l-[0-9a-f]{8}-[0-9a-f]{8}\\.sock:`));
    expect(spec.endsWith(`:${LINUX_SOCKET}`)).toBe(true);

    await client.stop();
    client = null;
    // Dispose cancels exactly that forward through the control master.
    const cancel = calls.find((a) => a.includes("-O") && a.includes("cancel"));
    expect(cancel?.slice(0, 7)).toEqual([
      "-F",
      "/dev/null",
      "-o",
      'ControlPath="/cp/cm1-resolved"',
      "-O",
      "cancel",
      "-L",
    ]);
    expect(cancel?.[7]).toBe(spec);
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
      else if (isDiscoveryRead(command))
        child.finish(
          0,
          discoveryReply({
            version: 1,
            socketPath: DARWIN_SOCKET,
            token: server!.token,
            pid: 1,
          })
        );
      else if (args.includes("forward")) child.finish(255, "", "no master\n");
      else if (args.includes("-N"))
        proxies.push(fakeForward(args, DARWIN_SOCKET, hostLoc.socketPath));
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

  it("cancels the forward an attempt abandoned mid-request may have left on the master", async () => {
    const calls: string[][] = [];
    const abort = new AbortController();
    const spawner: SshSpawner = (args) => {
      calls.push(args);
      const child = new FakeChild();
      const command = args.at(-1)!;
      if (command === PROBE_COMMAND) child.finish(0, "Darwin\n501\n/Users/g\n");
      else if (isDiscoveryRead(command))
        child.finish(
          0,
          discoveryReply({ version: 1, socketPath: DARWIN_SOCKET, token: "a".repeat(64), pid: 1 })
        );
      // The master takes the forward; its answer never reaches the abandoned attempt.
      else if (args.includes("forward")) setImmediate(() => abort.abort());
      else child.finish(0);
      return child;
    };
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
    });
    await expect(transport.open(abort.signal)).rejects.toThrow("Connection cancelled");
    const forward = calls.find((args) => args.includes("forward"))!;
    const cancel = calls.find((args) => args.includes("cancel"));
    expect(cancel?.at(-3)).toBe(forward.at(-3));
    // Nor does it start a dedicated forward for an attempt nobody is waiting on.
    expect(calls.some((args) => args.includes("-N"))).toBe(false);
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
      else if (isDiscoveryRead(command))
        child.finish(
          0,
          discoveryReply({ version: 1, socketPath: DARWIN_SOCKET, token: "a".repeat(64), pid: 1 })
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

  it("refuses a discovery file whose socket isn't beside it, and never hands ssh a path it would expand", async () => {
    const open = (
      home: string,
      socketPath: string,
      launch = ["/Applications/Daintree.app/Contents/MacOS/Daintree"]
    ) => {
      const after: string[][] = [];
      const streams: string[][] = [];
      const ensureRunning = vi.fn(async () => true);
      const spawner: SshSpawner = (args) => {
        const child = new FakeChild();
        const command = args.at(-1)!;
        if (command === PROBE_COMMAND) child.finish(0, `Darwin\n501\n${home}\n`);
        else if (isDiscoveryRead(command))
          child.finish(
            0,
            discoveryReply({
              version: 1,
              socketPath,
              token: "a".repeat(64),
              pid: 1,
              command: launch,
            })
          );
        else {
          after.push(args);
          child.finish(0);
        }
        return child;
      };
      const transport = new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: spawner,
        spawnStream: (args) => {
          streams.push(args);
          return bridgeChild("/nonexistent/host.json");
        },
        ensureRunning,
      });
      return {
        opened: transport.open(new AbortController().signal),
        after,
        streams,
        ensureRunning,
      };
    };
    const expectRefused = async (attempt: ReturnType<typeof open>, detail: string) => {
      await expect(attempt.opened).rejects.toMatchObject({
        message: "Host discovery file is not valid",
        detail: expect.stringContaining(detail),
      });
      // Nothing else reached ssh, and the host wasn't restarted over it.
      expect(attempt.after).toEqual([]);
      expect(attempt.streams).toEqual([]);
      expect(attempt.ensureRunning).not.toHaveBeenCalled();
    };

    // A socket somewhere other than beside the discovery file, plain or expanding.
    await expectRefused(open("/Users/g", "/tmp/other.sock"), "not beside it");
    await expectRefused(open("/Users/g", "/x/${OPENAI_API_KEY}/host.sock"), "not beside it");

    // A host can't get an expansion in through its $HOME either: a home like
    // that is reached over the attach bridge, which never names the socket to
    // ssh, and refused when the host gives no bridge to start.
    for (const home of ["/Users/${OPENAI_API_KEY}", "/Users/%u"]) {
      const socket = remoteHostSocketLocation({ platform: "darwin", uid: 501, home }).socketPath;
      const bridged = open(home, socket);
      await bridged.opened.catch(() => {});
      // No forward was set up; every attempt went over the bridge, never naming the socket.
      expect(bridged.after).toEqual([]);
      expect(bridged.streams.length).toBeGreaterThan(0);
      for (const args of bridged.streams) {
        expect(args.some((arg) => arg.includes(socket))).toBe(false);
        expect(args.at(-1)).toBe(
          "'/Applications/Daintree.app/Contents/MacOS/Daintree' --attach-stdio"
        );
      }

      await expectRefused(open(home, socket, ["relative/Daintree"]), "can't forward as written");
    }
  });

  it("accepts a home with a bare $, which ssh leaves alone", () => {
    const socket = remoteHostSocketLocation({
      platform: "darwin",
      uid: 501,
      home: "/Users/g$literal",
    }).socketPath;
    expect(isForwardablePath(socket)).toBe(true);
  });

  /** Open against a host whose probe answers and whose discovery read ends with `code`. */
  const openWithRead = async (code: number, stdout: string, stderr: string) => {
    const reads: string[] = [];
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: (args) => {
        const child = new FakeChild();
        if (args.at(-1) === PROBE_COMMAND) child.finish(0, "Linux\n1000\n/home/g\n");
        else {
          if (isDiscoveryRead(args.at(-1))) reads.push(args.at(-1)!);
          child.finish(code, stdout, stderr);
        }
        return child;
      },
    });
    const error = await transport.open(new AbortController().signal).catch((e: unknown) => e);
    return { error, reads };
  };

  it("reports a missing discovery file as Daintree not hosting there, whatever the host says", async () => {
    for (const stderr of [
      "",
      "cat: /run/user/1000/daintree/host.json: No such file or directory\n",
      "bash: Warnung: setlocale: LC_ALL: Kann die Locale nicht ändern (de_DE.UTF-8)\ncat: /run/user/1000/daintree/host.json: Datei oder Verzeichnis nicht gefunden\n",
    ]) {
      const { error, reads } = await openWithRead(3, "Welcome to studio\n", stderr);
      expect(reads).toHaveLength(1);
      expect(error).toBeInstanceOf(HostModeOffError);
      expect(error).toMatchObject({
        detail: "Daintree isn't running in Host mode there (no host.json).",
      });
    }
  });

  it("takes neither cat's nor ssh's words for a missing file", async () => {
    // The file went between the check and the read: the next attempt sees it missing.
    const vanished = "cat: /run/user/1000/daintree/host.json: No such file or directory";
    const sshItself = "Control socket connect(/c/cm): No such file or directory";
    for (const [code, stderr] of [
      [1, vanished],
      [255, sshItself],
    ] as const) {
      const { error, reads } = await openWithRead(code, "", `${stderr}\n`);
      expect(reads).toHaveLength(1);
      expect(error).toBeInstanceOf(TransportError);
      expect(error).not.toBeInstanceOf(HostModeOffError);
      expect(error).toMatchObject({ detail: stderr });
    }
  });

  describe("a host whose Daintree isn't running", () => {
    const missingDiscovery =
      (reads: { count: number }): SshSpawner =>
      (args) => {
        const child = new FakeChild();
        if (args.at(-1) === PROBE_COMMAND) child.finish(0, "Darwin\n501\n/Users/g\n");
        else if (isDiscoveryRead(args.at(-1))) {
          reads.count++;
          child.finish(3);
        } else child.finish(0);
        return child;
      };

    it("asks once to start it after ssh reached the host, then tries again", async () => {
      const reads = { count: 0 };
      const ensureRunning = vi.fn(async () => true);
      const transport = new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: missingDiscovery(reads),
        ensureRunning,
      });
      await expect(transport.open(new AbortController().signal)).rejects.toBeInstanceOf(
        HostModeOffError
      );
      expect(ensureRunning).toHaveBeenCalledTimes(1);
      expect(reads.count).toBe(2);
      // A dial that says the host may be started asks the same way.
      await expect(
        transport.open(new AbortController().signal, { mayStart: true })
      ).rejects.toBeInstanceOf(HostModeOffError);
      expect(ensureRunning).toHaveBeenCalledTimes(2);
      expect(reads.count).toBe(4);
    });

    it("never asks while the dial says the host may not be started (it said it is restarting)", async () => {
      const reads = { count: 0 };
      const ensureRunning = vi.fn(async () => true);
      const transport = new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: missingDiscovery(reads),
        ensureRunning,
      });
      for (let dial = 0; dial < 3; dial++) {
        await expect(
          transport.open(new AbortController().signal, { mayStart: false })
        ).rejects.toBeInstanceOf(HostModeOffError);
      }
      expect(ensureRunning).not.toHaveBeenCalled();
      expect(reads.count).toBe(3);
    });

    it("never asks when ssh itself couldn't reach the host", async () => {
      const ensureRunning = vi.fn(async () => true);
      const spawner: SshSpawner = () => {
        const child = new FakeChild();
        child.finish(255, "", "ssh: connect to host studio port 22: Connection refused\n");
        return child;
      };
      const transport = new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: spawner,
        ensureRunning,
      });
      await expect(transport.open(new AbortController().signal)).rejects.toBeInstanceOf(
        TransportError
      );
      expect(ensureRunning).not.toHaveBeenCalled();
    });

    it("reports why it couldn't be started, and leaves it there when it can't be", async () => {
      const reads = { count: 0 };
      const refused = new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: missingDiscovery(reads),
        ensureRunning: async () => {
          throw new TransportError("Log in on studio once", "Log in on studio once");
        },
      });
      await expect(refused.open(new AbortController().signal)).rejects.toMatchObject({
        detail: "Log in on studio once",
      });
      const notStartable = new SshTransport({
        target: "studio",
        clientDir: path.join(root, "c"),
        spawn: missingDiscovery(reads),
        ensureRunning: async () => false,
      });
      reads.count = 0;
      const error = await notStartable.open(new AbortController().signal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostModeOffError);
      expect(error).toMatchObject({
        detail: "Daintree isn't running in Host mode there (no host.json).",
      });
      expect(reads.count).toBe(1);
    });
  });
});

// ssh hands a command to the remote user's login shell as `$SHELL -c`. These
// run the discovery read through real local shells instead, whose startup
// files print the way a `~/.zshenv` echo or a `~/.bashrc` line above its
// interactive guard does over ssh.
describe.skipIf(process.platform === "win32")(
  "reading the discovery file through the host user's shell",
  () => {
    const TARGET = "studio";
    const printsAtStartup = (dir: string) => {
      writeFileSync(path.join(dir, "bashenv"), `echo "Welcome to ${TARGET}"; printf 'bashenv'\n`);
      writeFileSync(path.join(dir, ".zshenv"), `echo "Welcome to ${TARGET}"; printf 'zshenv'\n`);
      writeFileSync(path.join(dir, ".cshrc"), `echo "Welcome to ${TARGET}"; printf 'cshrc'\n`);
      return { BASH_ENV: path.join(dir, "bashenv"), ZDOTDIR: dir, HOME: dir };
    };
    const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/csh"].filter((shell) =>
      existsSync(shell)
    );

    /** A `cat` that reports a missing file in German, as cat does under a German locale. */
    const germanCat = (dir: string) => {
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(
        path.join(bin, "cat"),
        [
          "#!/bin/sh",
          "for f; do :; done",
          'if [ -e "$f" ]; then exec /bin/cat "$@"; fi',
          'echo "cat: $f: Datei oder Verzeichnis nicht gefunden" >&2',
          "exit 1",
        ].join("\n") + "\n",
        { mode: 0o755 }
      );
      return bin;
    };

    /** The probe answers as a Mac whose home is `home`; the read runs through `shell`. */
    const hostShell = (
      shell: string,
      home: string,
      env: NodeJS.ProcessEnv,
      onForward: (args: string[]) => void = () => {}
    ): SshSpawner => {
      return (args) => {
        const command = args.at(-1)!;
        if (command === PROBE_COMMAND) {
          const child = new FakeChild();
          child.finish(0, `Darwin\n501\n${home}\n`);
          return child;
        }
        if (args.at(-3) === "--" && args.at(-2) === TARGET) {
          return spawn(shell, ["-c", command], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          }) as SshChild;
        }
        const child = new FakeChild();
        if (args[0] === "-G") child.finish(0, "controlpath /cp/cm1-resolved\n");
        else {
          if (args.includes("forward")) onForward(args);
          child.finish(0);
        }
        return child;
      };
    };

    it.each(SHELLS)("probes through %s when it prints at startup", (shell) => {
      const startup = path.join(root, "startup");
      mkdirSync(startup);
      const probe = spawnSync(shell, ["-c", PROBE_COMMAND], {
        env: { ...process.env, ...printsAtStartup(startup) },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(probe.status, probe.error?.message ?? probe.stderr).toBe(0);
      expect(parseProbeOutput(probe.stdout)).toEqual({
        platform: process.platform === "darwin" ? "darwin" : "linux",
        uid: process.getuid!(),
        home: startup,
      });
    });

    it.each(SHELLS)(
      "reads the file when %s prints at startup, from a home that needs quoting",
      async (shell) => {
        const hostLoc = hostSocketLocation({
          platform: "darwin",
          userDataDir: path.join(root, "h"),
        });
        server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: TARGET });
        await server.listen();
        const remoteHome = path.join(root, "o'brien $(x)");
        const remote = remoteHostSocketLocation({ platform: "darwin", uid: 501, home: remoteHome });
        mkdirSync(path.dirname(remote.discoveryPath), { recursive: true });
        writeFileSync(
          remote.discoveryPath,
          JSON.stringify({ version: 1, socketPath: remote.socketPath, token: server.token, pid: 1 })
        );
        const startup = path.join(root, "startup");
        mkdirSync(startup);
        const env = {
          ...process.env,
          ...printsAtStartup(startup),
          PATH: `${germanCat(root)}:${process.env.PATH ?? ""}`,
        };
        const proxies: net.Server[] = [];
        const transport = new SshTransport({
          target: TARGET,
          clientDir: path.join(root, "c"),
          spawn: hostShell(shell, remoteHome, env, (args) =>
            proxies.push(fakeForward(args, remote.socketPath, hostLoc.socketPath))
          ),
        });
        try {
          const connection = await transport.open(new AbortController().signal);
          try {
            expect(connection.token).toBe(server.token);
            expect(transport.route).toBe("forward");
          } finally {
            connection.socket.destroy();
            await connection.dispose();
          }
        } finally {
          await Promise.all(
            proxies.map((proxy) => new Promise<void>((resolve) => proxy.close(() => resolve())))
          );
        }
      }
    );

    it.each(SHELLS)(
      "reports a missing file as Host mode off through %s on a host whose cat speaks German",
      async (shell) => {
        const startup = path.join(root, "startup");
        mkdirSync(startup);
        const env = {
          ...process.env,
          ...printsAtStartup(startup),
          PATH: `${germanCat(root)}:${process.env.PATH ?? ""}`,
        };
        const transport = new SshTransport({
          target: TARGET,
          clientDir: path.join(root, "c"),
          spawn: hostShell(shell, path.join(root, "home"), env),
        });
        const error = await transport.open(new AbortController().signal).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HostModeOffError);
      }
    );
  }
);

describe("reconnecting to a host the transport already knows", () => {
  const isProbe = (args: string[]) => args.at(-1) === PROBE_COMMAND;
  const isRead = (args: string[]) => isDiscoveryRead(args.at(-1));
  const isResolve = (args: string[]) => args[0] === "-G";
  const isMuxForward = (args: string[]) => args.includes("-O") && args.includes("forward");

  /**
   * A Mac host whose discovery read returns whatever its HostServer has on
   * disk (exit 3 once it removed the file), and whose master forwards onto
   * the real socket. `forwardFails` makes the master refuse the next forwards.
   */
  async function knownHost() {
    const hostLoc = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "h") });
    server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: "studio" });
    await server.listen();
    const calls: string[][] = [];
    const proxies: net.Server[] = [];
    const links: net.Socket[] = [];
    const state = { forwardFails: 0 };
    const spawner: SshSpawner = (args) => {
      calls.push(args);
      const child = new FakeChild();
      if (isProbe(args)) child.finish(0, "Darwin\n501\n/Users/g\n");
      else if (isRead(args)) {
        if (existsSync(hostLoc.discoveryPath)) {
          // Named where the client expects it; the forward maps it onto the real one.
          const info = JSON.parse(readFileSync(hostLoc.discoveryPath, "utf8")) as object;
          child.finish(0, discoveryReply({ ...info, socketPath: DARWIN_SOCKET }));
        } else child.finish(3);
      } else if (isResolve(args)) child.finish(0, "controlpath /cp/cm3-resolved\n");
      else if (isMuxForward(args)) {
        if (state.forwardFails > 0) {
          state.forwardFails--;
          child.finish(255, "", "Control socket connect(/cp/cm3-resolved): No such file\n");
        } else {
          const proxy = fakeForward(args, DARWIN_SOCKET, hostLoc.socketPath);
          proxy.on("connection", (conn) => links.push(conn));
          proxies.push(proxy);
          child.finish(0);
        }
      } else child.finish(0);
      return child;
    };
    const relaunch = async () => {
      await server!.close();
      server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: "studio" });
      await server.listen();
    };
    const closeProxies = () => {
      for (const proxy of proxies) proxy.close();
    };
    return { hostLoc, calls, links, state, spawner, relaunch, closeProxies };
  }

  const linkClient = (transport: SshTransport) =>
    new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c1", clientName: "mbp", platform: "darwin" },
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      backoff: { initialMs: 10, jitter: 0 },
    });

  it("forwards straight away on the next dial: no probe, no discovery read, no ssh -G", async () => {
    const host = await knownHost();
    const clientDir = path.join(root, "c");
    const transport = new SshTransport({ target: "greg@studio", clientDir, spawn: host.spawner });
    client = linkClient(transport);
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    expect(host.calls.filter(isProbe)).toHaveLength(1);
    expect(host.calls.filter(isRead)).toHaveLength(1);
    expect(host.calls.filter(isResolve)).toHaveLength(1);

    // The link drops (a blip) while ssh and the host stay up.
    const before = host.calls.length;
    for (const link of host.links) link.destroy();
    await waitFor(() => client!.getState().status !== "connected");
    await waitFor(() => client!.getState().status === "connected");
    const redial = host.calls.slice(before);
    expect(redial.filter(isProbe)).toEqual([]);
    expect(redial.filter(isRead)).toEqual([]);
    expect(redial.filter(isResolve)).toEqual([]);
    // Through the master by the path `ssh -G` gave the first time.
    const forward = redial.find(isMuxForward)!;
    expect(forward.slice(0, 4)).toEqual([
      "-F",
      "/dev/null",
      "-o",
      'ControlPath="/cp/cm3-resolved"',
    ]);
    expect(transport.route).toBe("forward");

    await client.stop();
    client = null;
    host.closeProxies();
  });

  it("reads the host afresh when the token it remembered is refused, and connects", async () => {
    const host = await knownHost();
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: host.spawner,
    });
    client = linkClient(transport);
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    await client.stop();

    // Daintree on the host relaunched while the link was down: same socket, new token.
    const oldToken = server!.token;
    await host.relaunch();
    expect(server!.token).not.toBe(oldToken);
    const states: LinkClientState[] = [];
    client.onStateChange((state) => states.push(state));
    const before = host.calls.length;
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    const redial = host.calls.slice(before);
    // The remembered forward first, then the full dial: probe, read, -G, forward.
    expect(redial.findIndex(isMuxForward)).toBeLessThan(redial.findIndex(isProbe));
    expect(redial.filter(isProbe)).toHaveLength(1);
    expect(redial.filter(isRead)).toHaveLength(1);
    // The refused token never showed as a failure.
    expect(states.some((state) => state.status === "unreachable")).toBe(false);

    await client.stop();
    client = null;
    host.closeProxies();
  });

  it("reports Host mode off as it always has once nothing listens where it remembered", async () => {
    const host = await knownHost();
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: host.spawner,
    });
    client = linkClient(transport);
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    await client.stop();

    await server!.close();
    server = null;
    expect(existsSync(host.hostLoc.discoveryPath)).toBe(false);
    const before = host.calls.length;
    client.start();
    await waitFor(() => client!.getState().status === "unreachable");
    expect(client.getState()).toMatchObject({ status: "unreachable", hostModeOff: true });
    expect(host.calls.slice(before).filter(isRead)).toHaveLength(1);

    await client.stop();
    client = null;
    host.closeProxies();
  });

  it("dials afresh when the master it forwarded through is gone, never settling for a dedicated forward", async () => {
    const host = await knownHost();
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: host.spawner,
    });
    const first = await transport.open(new AbortController().signal);
    first.socket.destroy();
    await first.dispose();

    host.state.forwardFails = 1;
    const before = host.calls.length;
    const second = await transport.open(new AbortController().signal);
    expect(second.token).toBe(server!.token);
    const redial = host.calls.slice(before);
    const kind = (args: string[]) =>
      isMuxForward(args)
        ? "forward"
        : isProbe(args)
          ? "probe"
          : isRead(args)
            ? "read"
            : isResolve(args)
              ? "-G"
              : args.includes("-N")
                ? "dedicated"
                : null;
    // The stream-local check (`-W`) may run on either path; it isn't what this is about.
    expect(redial.map(kind).filter((k) => k !== null)).toEqual([
      "forward",
      "probe",
      "read",
      "-G",
      "forward",
    ]);
    second.socket.destroy();
    await second.dispose();
    host.closeProxies();
  });

  it("asks the host for everything again when the dial says fresh", async () => {
    const host = await knownHost();
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: host.spawner,
    });
    const first = await transport.open(new AbortController().signal);
    expect(first.remembered).toBeUndefined();
    await first.dispose();
    const second = await transport.open(new AbortController().signal);
    expect(second.remembered).toBe(true);
    await second.dispose();

    const before = host.calls.length;
    const third = await transport.open(new AbortController().signal, { fresh: true });
    expect(third.remembered).toBeUndefined();
    const redial = host.calls.slice(before);
    expect(redial.filter(isProbe)).toHaveLength(1);
    expect(redial.filter(isRead)).toHaveLength(1);
    expect(redial.filter(isResolve)).toHaveLength(1);
    // The server's answer on socket forwarding is asked again too.
    expect(redial.filter((args) => args.includes("-W"))).toHaveLength(1);
    await third.dispose();
    host.closeProxies();
  });

  it("dials afresh once the ssh config may point the alias somewhere else", async () => {
    const host = await knownHost();
    const config = path.join(root, "ssh_config");
    writeFileSync(config, "Host studio\n  HostName a.example\n");
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: host.spawner,
      sshConfigFiles: [config, path.join(root, "no-system-config")],
    });
    const first = await transport.open(new AbortController().signal);
    await first.dispose();
    const second = await transport.open(new AbortController().signal);
    expect(second.remembered).toBe(true);
    await second.dispose();

    // The master still open to a.example would otherwise keep carrying the link.
    writeFileSync(config, "Host studio\n  HostName b.example.org\n");
    const before = host.calls.length;
    const third = await transport.open(new AbortController().signal);
    expect(third.remembered).toBeUndefined();
    const redial = host.calls.slice(before);
    expect(redial.filter(isProbe)).toHaveLength(1);
    expect(redial.filter(isResolve)).toHaveLength(1);
    await third.dispose();
    // What that dial learned holds while the config stays as it is now.
    const fourth = await transport.open(new AbortController().signal);
    expect(fourth.remembered).toBe(true);
    await fourth.dispose();
    host.closeProxies();
  });

  it("starts no fresh dial for a remembered one that was cancelled", async () => {
    const host = await knownHost();
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: (args) => {
        // The master never answers this forward; the dial is cancelled meanwhile.
        if (isMuxForward(args) && host.calls.some(isMuxForward)) {
          host.calls.push(args);
          setImmediate(() => abort.abort());
          return new FakeChild();
        }
        return host.spawner(args);
      },
    });
    const first = await transport.open(new AbortController().signal);
    await first.dispose();
    const abort = new AbortController();
    const before = host.calls.length;
    await expect(transport.open(abort.signal)).rejects.toThrow("Connection cancelled");
    const redial = host.calls.slice(before);
    expect(redial.filter(isProbe)).toEqual([]);
    expect(redial.filter(isRead)).toEqual([]);
    // The forward the master may have taken is cancelled all the same.
    const forward = redial.find(isMuxForward)!;
    const cancel = redial.find((args) => args.includes("cancel"));
    expect(cancel?.at(-3)).toBe(forward.at(-3));
    host.closeProxies();
  });
});

describe("when the ssh server refuses socket forwarding", () => {
  const REFUSED_VIA_MASTER = "Stdio forwarding request failed: Session open refused by peer\n";

  it("recognises ssh's refusal wording, with and without a master", () => {
    expect(isStreamLocalRefusal(REFUSED_VIA_MASTER)).toBe(true);
    expect(
      isStreamLocalRefusal(
        "channel 0: open failed: administratively prohibited: open failed\nstdio forwarding failed"
      )
    ).toBe(true);
    expect(isStreamLocalRefusal("Bad stdio forwarding specification '/x/host.sock'")).toBe(false);
    expect(isStreamLocalRefusal("ssh: connect to host studio port 22: Connection refused")).toBe(
      false
    );
  });

  it("starts the bridge from the command the host published, quoted", () => {
    const info = { version: 1 as const, socketPath: "/s", token: "a".repeat(64), pid: 1 };
    expect(attachCommandFor({ ...info, command: ["/opt/Daintree/daintree"] })).toBe(
      "'/opt/Daintree/daintree' --attach-stdio"
    );
    expect(attachCommandFor({ ...info, command: ["/usr/bin/electron", "/home/g/it's/app"] })).toBe(
      "'/usr/bin/electron' '/home/g/it'\\''s/app' --attach-stdio"
    );
    expect(attachCommandFor(info)).toBeNull();
    expect(attachCommandFor({ ...info, command: ["daintree"] })).toBeNull();
    expect(attachCommandFor({ ...info, command: ["/bin/x\nrm"] })).toBeNull();
    // The profile a Host keeps its socket in rides along; nothing else may.
    expect(
      attachCommandFor({
        ...info,
        command: [
          "/Applications/Daintree.app/Contents/MacOS/Daintree",
          "--user-data-dir=/Users/g/Library/Application Support/Daintree",
        ],
      })
    ).toBe(
      "'/Applications/Daintree.app/Contents/MacOS/Daintree' '--user-data-dir=/Users/g/Library/Application Support/Daintree' --attach-stdio"
    );
    expect(
      attachCommandFor({ ...info, command: ["/opt/d", "--user-data-dir=relative/dir"] })
    ).toBeNull();
    expect(attachCommandFor({ ...info, command: ["--user-data-dir=/x"] })).toBeNull();
    expect(attachCommandFor({ ...info, command: ["/opt/d", "--inspect=9229"] })).toBeNull();
  });

  async function refusingHost(options: { publishCommand?: boolean; checkStderr?: string } = {}) {
    const hostLoc = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "h") });
    server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: "studio" });
    await server.listen();
    const calls: string[][] = [];
    const spawner: SshSpawner = (args) => {
      calls.push(args);
      const child = new FakeChild();
      const command = args.at(-1)!;
      if (command === PROBE_COMMAND) child.finish(0, "Darwin\n501\n/Users/g\n");
      else if (isDiscoveryRead(command))
        child.finish(
          0,
          discoveryReply({
            version: 1,
            socketPath: DARWIN_SOCKET,
            token: server!.token,
            pid: 1,
            ...(options.publishCommand !== false && {
              command: ["/Applications/Daintree.app/Contents/MacOS/Daintree"],
            }),
          })
        );
      else if (args.includes("-W"))
        child.finish(255, "", options.checkStderr ?? REFUSED_VIA_MASTER);
      else child.finish(0);
      return child;
    };
    const streams: string[][] = [];
    const bridges: BridgeChild[] = [];
    const spawnStream: SshStreamSpawner = (args) => {
      streams.push(args);
      const child = bridgeChild(hostLoc.discoveryPath);
      bridges.push(child);
      return child;
    };
    return { hostLoc, calls, spawner, streams, bridges, spawnStream };
  }

  it("carries the link over `ssh <target> -- <daintree> --attach-stdio` through the master", async () => {
    const host = await refusingHost();
    const clientDir = path.join(root, "c");
    const controlPath = controlPathFor(clientDir, "greg@studio");
    const transport = new SshTransport({
      target: "greg@studio",
      clientDir,
      spawn: host.spawner,
      spawnStream: host.spawnStream,
    });
    client = new LinkClient({
      transport,
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c1", clientName: "mbp", platform: "darwin" },
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
      backoff: { initialMs: 10 },
    });
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    expect(transport.route).toBe("attach-stdio");
    expect(host.streams).toEqual([
      buildAttachArgs(
        "greg@studio",
        controlPath,
        "'/Applications/Daintree.app/Contents/MacOS/Daintree' --attach-stdio"
      ),
    ]);
    // No socket forward was ever asked of the master.
    expect(host.calls.some((args) => args.includes("forward"))).toBe(false);
    expect(host.calls.filter((args) => args.includes("-W"))).toHaveLength(1);

    // A dropped bridge asks the server once more (ssh words a socket nobody
    // listens on as a refusal too), and a server that still refuses keeps the bridge.
    host.bridges[0]!.kill();
    await waitFor(() => host.streams.length === 2);
    await waitFor(() => client!.getState().status === "connected");
    expect(host.calls.filter((args) => args.includes("-W"))).toHaveLength(2);
    expect(transport.route).toBe("attach-stdio");
  });

  it("goes back to the socket forward once a host that was restarting listens again", async () => {
    // The first check lands while the restarted host's old socket file has no
    // listener, which ssh words exactly as a refusal; the next one goes through.
    const host = await refusingHost();
    let checks = 0;
    const proxies: net.Server[] = [];
    const spawner: SshSpawner = (args) => {
      if (args.includes("-W")) {
        checks += 1;
        const child = new FakeChild();
        if (checks === 1) child.finish(255, "", REFUSED_VIA_MASTER);
        else child.finish(0);
        return child;
      }
      if (args.includes("forward")) {
        proxies.push(fakeForward(args, DARWIN_SOCKET, host.hostLoc.socketPath));
        const child = new FakeChild();
        child.finish(0);
        return child;
      }
      return host.spawner(args);
    };
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
      spawnStream: host.spawnStream,
    });
    const first = await transport.open(new AbortController().signal);
    expect(transport.route).toBe("attach-stdio");
    // The bridge's close is what sends the next dial back to the check.
    const closed = new Promise((resolve) => first.socket.once("close", resolve));
    first.socket.destroy();
    await closed;
    const second = await transport.open(new AbortController().signal);
    expect(transport.route).toBe("forward");
    expect(checks).toBe(2);
    await first.dispose();
    await second.dispose();
    for (const p of proxies) p.close();
  });

  it("keeps the socket forward when the check failed for some other reason", async () => {
    const host = await refusingHost({
      checkStderr: "Bad stdio forwarding specification '/x/host.sock'\n",
    });
    const proxies: net.Server[] = [];
    const spawner: SshSpawner = (args) => {
      if (args.includes("forward")) {
        proxies.push(fakeForward(args, DARWIN_SOCKET, host.hostLoc.socketPath));
        const child = new FakeChild();
        child.finish(0);
        return child;
      }
      return host.spawner(args);
    };
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: spawner,
      spawnStream: host.spawnStream,
    });
    const conn = await transport.open(new AbortController().signal);
    expect(transport.route).toBe("forward");
    expect(host.streams).toEqual([]);
    await conn.dispose();
    for (const p of proxies) p.close();
  });

  it("says so when the host didn't publish how to start its bridge", async () => {
    const host = await refusingHost({ publishCommand: false });
    const transport = new SshTransport({
      target: "studio",
      clientDir: path.join(root, "c"),
      spawn: host.spawner,
      spawnStream: host.spawnStream,
    });
    await expect(transport.open(new AbortController().signal)).rejects.toMatchObject({
      message: expect.stringContaining("refuses socket forwarding"),
    });
    expect(host.streams).toEqual([]);
  });
});

describe("closing masters when the app quits", () => {
  it("tells every master this process used to exit, once", async () => {
    await closeSshMasters();
    const exits: string[][] = [];
    const spawner: SshSpawner = (args) => {
      const child = new FakeChild();
      if (args.includes("exit")) exits.push(args);
      // "down" fails its probe: ssh may still have left a master behind.
      if (args.at(-1) === PROBE_COMMAND && !args.includes("down"))
        child.finish(0, "Darwin\n501\n/Users/g\n");
      else child.finish(255, "", "no\n");
      return child;
    };
    const clientDir = path.join(root, "c");
    for (const target of ["studio", "bigbox", "studio", "down"]) {
      const transport = new SshTransport({ target, clientDir, spawn: spawner });
      await expect(transport.open(new AbortController().signal)).rejects.toBeInstanceOf(
        TransportError
      );
    }
    expect(exits).toEqual([]);
    await closeSshMasters(1_000);
    expect(exits).toEqual([
      ["-o", controlPathOption(controlPathFor(clientDir, "studio")), "-O", "exit", "--", "studio"],
      ["-o", controlPathOption(controlPathFor(clientDir, "bigbox")), "-O", "exit", "--", "bigbox"],
      ["-o", controlPathOption(controlPathFor(clientDir, "down")), "-O", "exit", "--", "down"],
    ]);
    await closeSshMasters(1_000);
    expect(exits).toHaveLength(3);
  });

  it("keeps one entry per host when they share the %C template, and forgetting one host drops only its own", async () => {
    await closeSshMasters();
    // Short enough that every host gets the shared `cm-%C` spelling.
    const clientDir = mkdtempSync("/tmp/rhm-");
    try {
      expect(controlPathFor(clientDir, "studio")).toBe(controlPathFor(clientDir, "bigbox"));
      expect(controlPathFor(clientDir, "studio")).toContain("%C");
      const exits: string[] = [];
      const spawner: SshSpawner = (args) => {
        const child = new FakeChild();
        if (args.includes("exit")) exits.push(args.at(-1)!);
        child.finish(255, "", "no\n");
        return child;
      };
      for (const target of ["studio", "bigbox", "mini"]) {
        const transport = new SshTransport({ target, clientDir, spawn: spawner });
        await expect(transport.open(new AbortController().signal)).rejects.toBeInstanceOf(
          TransportError
        );
      }
      const forgotten: string[] = [];
      await closeSshMaster(
        async (_command, args) => {
          forgotten.push(args.at(-1)!);
          return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
        },
        clientDir,
        "bigbox",
        1_000
      );
      expect(forgotten).toEqual(["bigbox"]);
      await closeSshMasters(1_000);
      expect(exits.sort()).toEqual(["mini", "studio"]);
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  });
});

describe("exitStaleSshMasters", () => {
  it("tells every master a crashed launch left to exit, by its own socket, and removes the socket", async () => {
    // Short: a unix socket path has to fit sun_path.
    const clientDir = mkdtempSync(path.join(os.tmpdir(), "rh-"));
    const servers: net.Server[] = [];
    const socketAt = (name: string) =>
      new Promise<string>((resolve) => {
        const server = net.createServer();
        servers.push(server);
        const socketPath = path.join(clientDir, name);
        server.listen(socketPath, () => resolve(socketPath));
      });
    try {
      const current = await socketAt("cm2-7f3a");
      const older = await socketAt("cm1-9b1c");
      // A link's own forwarded socket is not a master.
      const linkSocket = await socketAt("l-1234abcd-0011.sock");
      writeFileSync(path.join(clientDir, "cm2-notes"), "not a socket");
      const runs: string[][] = [];

      await exitStaleSshMasters(
        async (_command, args) => {
          runs.push([...args]);
          return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
        },
        clientDir,
        1_000
      );

      expect(runs.map((args) => args[args.indexOf("-o") + 1]).sort()).toEqual(
        [controlPathOption(older), controlPathOption(current)].sort()
      );
      for (const args of runs) {
        // No user config: its own forwards and options would ride along.
        expect(args.slice(0, 2)).toEqual(["-F", "/dev/null"]);
        expect(args[args.indexOf("-O") + 1]).toBe("exit");
      }
      expect(existsSync(current)).toBe(false);
      expect(existsSync(older)).toBe(false);
      expect(existsSync(linkSocket)).toBe(true);
      expect(existsSync(path.join(clientDir, "cm2-notes"))).toBe(true);
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  it("keeps the socket of a master that wouldn't exit, so it can still be reached", async () => {
    const clientDir = mkdtempSync(path.join(os.tmpdir(), "rh-"));
    const server = net.createServer();
    try {
      const socketPath = path.join(clientDir, "cm2-7f3a");
      await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
      await exitStaleSshMasters(
        async () => ({ code: 255, stdout: "", stderr: "", spawnError: null, timedOut: false }),
        clientDir,
        1_000
      );
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(clientDir, { recursive: true, force: true });
    }
  });

  it("does nothing when there is no control directory yet", async () => {
    const run = vi.fn();
    await exitStaleSshMasters(run, path.join(os.tmpdir(), "rh-missing-dir-x"), 1_000);
    expect(run).not.toHaveBeenCalled();
  });
});
