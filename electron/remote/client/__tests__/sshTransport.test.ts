import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
  isForwardablePath,
  isValidSshTarget,
  parseProbeOutput,
  type SshChild,
  type SshSpawner,
  type SshStreamSpawner,
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

  it("uses cm1-%C when it fits and a short hash when it would not", () => {
    expect(controlPathFor("/Users/g/.config/Daintree/ssh", "studio", "darwin")).toBe(
      "/Users/g/.config/Daintree/ssh/cm1-%C"
    );
    const long = "/Users/somebody/Library/Application Support/Daintree/ssh";
    const hashed = controlPathFor(long, "studio", "darwin");
    expect(hashed).toMatch(/\/cm1-[0-9a-f]{16}$/);
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
      else if (command.startsWith("cat -- "))
        child.finish(
          0,
          JSON.stringify({
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
          JSON.stringify({ version: 1, socketPath: DARWIN_SOCKET, token: "a".repeat(64), pid: 1 })
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

  it("refuses a discovery file whose socket isn't beside it, or that ssh would expand", async () => {
    const open = (home: string, socketPath: string) => {
      const after: string[][] = [];
      const streams: string[][] = [];
      const ensureRunning = vi.fn(async () => true);
      const spawner: SshSpawner = (args) => {
        const child = new FakeChild();
        const command = args.at(-1)!;
        if (command === PROBE_COMMAND) child.finish(0, `Darwin\n501\n${home}\n`);
        else if (command.startsWith("cat -- "))
          child.finish(
            0,
            JSON.stringify({
              version: 1,
              socketPath,
              token: "a".repeat(64),
              pid: 1,
              command: ["/Applications/Daintree.app/Contents/MacOS/Daintree"],
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

    // A host can't get an expansion in through its $HOME either.
    for (const home of ["/Users/${OPENAI_API_KEY}", "/Users/%u"]) {
      const socket = remoteHostSocketLocation({ platform: "darwin", uid: 501, home }).socketPath;
      await expectRefused(open(home, socket), "can't forward as written");
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

  describe("a host whose Daintree isn't running", () => {
    const missingDiscovery =
      (reads: { count: number }): SshSpawner =>
      (args) => {
        const child = new FakeChild();
        if (args.at(-1) === PROBE_COMMAND) child.finish(0, "Darwin\n501\n/Users/g\n");
        else if (args.at(-1)?.startsWith("cat -- ")) {
          reads.count++;
          child.finish(1, "", "cat: host.json: No such file or directory\n");
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
      await expect(transport.open(new AbortController().signal)).rejects.toMatchObject({
        detail: "cat: host.json: No such file or directory",
      });
      expect(ensureRunning).toHaveBeenCalledTimes(1);
      expect(reads.count).toBe(2);
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
      await expect(notStartable.open(new AbortController().signal)).rejects.toMatchObject({
        detail: "cat: host.json: No such file or directory",
      });
      expect(reads.count).toBe(1);
    });
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
      else if (command.startsWith("cat -- "))
        child.finish(
          0,
          JSON.stringify({
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
    first.socket.destroy();
    await waitFor(() => first.socket.destroyed);
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
