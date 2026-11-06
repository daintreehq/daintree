import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  openRelayDeployHost,
  parseResult,
  relayDeployEndpoint,
  type RelayDeployHost,
  type RelayDeployHostEvents,
  type RelayDeployHostOptions,
} from "../relayDeployHost.js";
import type { RelayDeployPrefill } from "../relayDeployPrefill.js";

const HELLO = { v: 1, type: "hello", cli: "0.3.0", versions: [1] };
const PREFILL: RelayDeployPrefill = {
  transcription: { provider: "xai" },
  keys: { xai: "xai-key-0123456789" },
};
const RESULT = {
  v: 1,
  type: "result",
  status: "completed",
  url: "https://daintree-decisions-0a1b2c3d.me.workers.dev",
  claim_secret: "claim-secret-0123456789abcdef",
  claim_state: "unclaimed",
};

const line = (message: unknown) => `${JSON.stringify(message)}\n`;
/** The Unix socket's private directory exists only off Windows, where the channel is a named pipe. */
const UNIX = process.platform !== "win32";

/** Whether the run's socket directory is gone (a pipe has none). */
function directoryGone(host: RelayDeployHost): boolean {
  return !UNIX || !existsSync(path.dirname(host.channelPath));
}

/** The CLI's end: what the host sends, line by line, and when it closes. */
class Client {
  readonly lines: unknown[] = [];
  readonly closed: Promise<void>;
  private waiters: Array<() => void> = [];

  constructor(readonly socket: Socket) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        this.lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    socket.on("error", () => {});
    this.closed = new Promise((resolve) => socket.on("close", () => resolve()));
  }

  static connect(channelPath: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(channelPath);
      socket.once("connect", () => resolve(new Client(socket)));
      socket.once("error", reject);
    });
  }

  async next(): Promise<unknown> {
    const at = this.lines.length;
    await vi.waitFor(() => expect(this.lines.length).toBeGreaterThan(at), { timeout: 2_000 });
    return this.lines[at];
  }

  send(text: string): void {
    this.socket.write(text);
  }
}

interface Recorded extends RelayDeployHostEvents {
  log: string[];
}

function recorder(prefill: () => RelayDeployPrefill = () => PREFILL): Recorded {
  const log: string[] = [];
  return {
    log,
    readPrefill: vi.fn(() => {
      log.push("readPrefill");
      return prefill();
    }),
    onRunning: vi.fn(() => log.push("running")),
    onResult: vi.fn((result) => log.push(`result:${result.status}`)),
    onInterrupted: vi.fn((reason) => log.push(`interrupted:${reason}`)),
  };
}

const hosts: RelayDeployHost[] = [];
const clients: Client[] = [];

async function open(events: RelayDeployHostEvents, options: RelayDeployHostOptions = {}) {
  const host = await openRelayDeployHost(events, { tmpRoot: os.tmpdir(), ...options });
  hosts.push(host);
  return host;
}

async function connect(host: RelayDeployHost): Promise<Client> {
  const client = await Client.connect(host.channelPath);
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.socket.destroy();
  for (const host of hosts.splice(0)) host.dispose();
});

describe("openRelayDeployHost", () => {
  it("answers a hello with the prefill, and keeps the result before confirming it", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);

    client.send(line(HELLO));
    expect(await client.next()).toEqual({ v: 1, type: "prefill", answers: PREFILL });
    expect(events.log).toEqual(["readPrefill", "running"]);

    client.send(line(RESULT));
    expect(await client.next()).toEqual({ v: 1, type: "received" });
    expect(events.onResult).toHaveBeenCalledExactlyOnceWith({
      status: "completed",
      url: RESULT.url,
      claimSecret: RESULT.claim_secret,
      claimState: "unclaimed",
    });
    await client.closed;
    expect(events.onInterrupted).not.toHaveBeenCalled();
  });

  it("reads the voice settings only once the CLI says hello", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.readPrefill).not.toHaveBeenCalled();
    client.send(line(HELLO));
    await client.next();
    expect(events.readPrefill).toHaveBeenCalledOnce();
  });

  it("reads lines split across writes and several in one", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    const hello = line(HELLO);

    client.send(hello.slice(0, 7));
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.send(hello.slice(7));
    await client.next();
    client.send(`\n${line(RESULT)}`);

    expect(await client.next()).toEqual({ v: 1, type: "received" });
    expect(events.onResult).toHaveBeenCalledOnce();
  });

  it("prefills nothing when the settings can't be read, and still runs", async () => {
    const events = recorder(() => {
      throw new Error("store unreadable");
    });
    const host = await open(events);
    const client = await connect(host);

    client.send(line(HELLO));

    expect(await client.next()).toEqual({ v: 1, type: "prefill", answers: { keys: {} } });
  });

  it.each([
    ["a message in another contract version", { ...HELLO, v: 2 }],
    ["a CLI that doesn't speak version 1", { ...HELLO, versions: [2] }],
    ["no version list", { v: 1, type: "hello", cli: "0.3.0" }],
    ["a hello-shaped message of another type", { ...HELLO, type: "greeting" }],
    ["a message that isn't a hello", RESULT],
  ])("sends no prefill for %s, and ends the channel", async (_label, hello) => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);

    client.send(line(hello));
    await client.closed;

    expect(client.lines).toEqual([]);
    expect(events.readPrefill).not.toHaveBeenCalled();
    expect(events.onInterrupted).toHaveBeenCalledExactlyOnceWith("handshake");
  });

  it("sends no prefill for text that isn't JSON", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);

    client.send("hello\n");
    await client.closed;

    expect(client.lines).toEqual([]);
    expect(events.onInterrupted).toHaveBeenCalledExactlyOnceWith("handshake");
  });

  it("drops a second connection that reached the socket at the same time, unanswered", async () => {
    const events = recorder();
    const host = await open(events);
    const settled = await Promise.allSettled([
      Client.connect(host.channelPath),
      Client.connect(host.channelPath),
    ]);
    // The one not taken is either refused outright or closed before it hears anything.
    const connected = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : []
    );
    clients.push(...connected);
    for (const client of connected) client.send(line(HELLO));

    await vi.waitFor(() =>
      expect(connected.filter((client) => client.lines.length > 0)).toHaveLength(1)
    );
    const answered = connected.find((client) => client.lines.length > 0)!;
    for (const dropped of connected.filter((client) => client !== answered)) {
      await dropped.closed;
      expect(dropped.lines).toEqual([]);
    }
    expect(answered.socket.destroyed).toBe(false);
    expect(events.readPrefill).toHaveBeenCalledOnce();
  });

  it("takes one connection: a later client is refused", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    // A pipe's client can connect before the server has accepted it.
    client.send(line(HELLO));
    expect(await client.next()).toEqual({ v: 1, type: "prefill", answers: PREFILL });
    await vi.waitFor(() => expect(UNIX ? existsSync(host.channelPath) : false).toBe(false));

    const later = Client.connect(host.channelPath).then(
      (other) => {
        clients.push(other);
        return "connected";
      },
      () => "refused"
    );
    // Windows retains the pipe until the accepted connection closes.
    client.send(line(RESULT));
    expect(await client.next()).toEqual({ v: 1, type: "received" });
    await client.closed;
    expect(await later).toBe("refused");
    expect(events.onInterrupted).not.toHaveBeenCalled();
  });

  it("ends the channel on anything but a result once the questions are running", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    client.send(line(HELLO));
    await client.next();

    client.send(line({ v: 1, type: "progress" }));
    await client.closed;

    expect(events.onResult).not.toHaveBeenCalled();
    expect(events.onInterrupted).toHaveBeenCalledExactlyOnceWith("protocol");
  });

  it.each([
    ["still unterminated", "x".repeat(64 * 1024 + 1)],
    // A valid result but for its size, so only the length limit refuses it.
    ["terminated", line({ ...RESULT, padding: "x".repeat(64 * 1024) })],
  ])("ends the channel on a line longer than the contract allows, %s", async (_label, text) => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    client.send(line(HELLO));
    await client.next();

    client.send(text);
    await client.closed;

    expect(events.onInterrupted).toHaveBeenCalledExactlyOnceWith("protocol");
  });

  it("says a CLI that stopped before its result stopped, with nothing kept", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    client.send(line(HELLO));
    await client.next();

    client.socket.end();

    await vi.waitFor(() => expect(events.onInterrupted).toHaveBeenCalledWith("closed"));
    expect(events.onResult).not.toHaveBeenCalled();
  });

  it("stops waiting for a CLI that never starts, and removes its socket", async () => {
    const events = recorder();
    const host = await open(events, { launchTimeoutMs: 20 });

    await vi.waitFor(() => expect(events.onInterrupted).toHaveBeenCalledWith("not-started"));
    await vi.waitFor(() => expect(directoryGone(host)).toBe(true));
  });

  it("gives a connected CLI the contract's time to say hello, and no more", async () => {
    const events = recorder();
    const host = await open(events, { helloTimeoutMs: 20 });
    const client = await connect(host);

    await client.closed;

    expect(events.onInterrupted).toHaveBeenCalledExactlyOnceWith("handshake");
  });

  it("never times out the person answering the questions", async () => {
    const events = recorder();
    const host = await open(events, { helloTimeoutMs: 20, launchTimeoutMs: 20 });
    const client = await connect(host);
    client.send(line(HELLO));
    await client.next();

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events.onInterrupted).not.toHaveBeenCalled();
    expect(client.socket.destroyed).toBe(false);
  });

  it.skipIf(!UNIX)(
    "keeps its socket in a directory only this user can open, under the path limit",
    async () => {
      const host = await open(recorder());

      expect(Buffer.byteLength(host.channelPath)).toBeLessThanOrEqual(100);
      expect(host.channelPath).toMatch(/^[A-Za-z0-9._/-]+$/);
      expect(statSync(path.dirname(host.channelPath)).mode & 0o777).toBe(0o700);
    }
  );

  it("tells nobody when it's disposed, and takes its socket with it, however often", async () => {
    const events = recorder();
    const host = await open(events);
    const client = await connect(host);
    client.send(line(HELLO));
    await client.next();

    host.dispose();
    host.dispose();
    await client.closed;

    expect(events.onInterrupted).not.toHaveBeenCalled();
    expect(directoryGone(host)).toBe(true);
  });

  it("takes its socket with it when disposed before the CLI connected", async () => {
    const events = recorder();
    const host = await open(events);
    expect(UNIX ? existsSync(host.channelPath) : true).toBe(true);

    host.dispose();

    await vi.waitFor(() => expect(directoryGone(host)).toBe(true));
    expect(events.onInterrupted).not.toHaveBeenCalled();
  });
});

describe("relayDeployEndpoint", () => {
  it("names a random pipe on Windows, spelled for a command line with forward slashes", async () => {
    const first = await relayDeployEndpoint("win32", os.tmpdir());
    const second = await relayDeployEndpoint("win32", os.tmpdir());

    const name = first.listenPath.replace(/^\\\\\.\\pipe\\/, "");
    expect(name).toMatch(/^daintree-decisions-deploy-[0-9a-f]{32}$/);
    expect(first.channelPath).toBe(`//./pipe/${name}`);
    expect(first.directory).toBeNull();
    expect(second.listenPath).not.toBe(first.listenPath);
  });

  it.skipIf(!UNIX)(
    "falls back to /tmp when the temp folder's path is too long for a socket",
    async () => {
      const endpoint = await relayDeployEndpoint("darwin", `/${"long-folder-name/".repeat(8)}`);
      try {
        expect(path.dirname(endpoint.listenPath).startsWith("/tmp/daintree-deploy-")).toBe(true);
        expect(endpoint.channelPath).toBe(endpoint.listenPath);
      } finally {
        await rm(endpoint.directory!, { recursive: true, force: true });
      }
    }
  );
});

describe("parseResult", () => {
  it("ignores a field a later contract adds, and trims and bounds the error", () => {
    expect(
      parseResult({ ...RESULT, status: "failed", error: `  ${"e".repeat(5000)} `, extra: 1 })
    ).toEqual({
      status: "failed",
      url: RESULT.url,
      claimSecret: RESULT.claim_secret,
      claimState: "unclaimed",
      error: "e".repeat(4096),
    });
  });

  it("trims a short error", () => {
    expect(parseResult({ ...RESULT, status: "failed", error: "  wrangler exited 1 \n" })).toEqual(
      expect.objectContaining({ error: "wrangler exited 1" })
    );
  });

  it("takes a result with neither a URL nor a secret", () => {
    expect(parseResult({ ...RESULT, status: "cancelled", url: null, claim_secret: null })).toEqual({
      status: "cancelled",
      url: null,
      claimSecret: null,
      claimState: "unclaimed",
    });
  });

  it.each([
    ["another version", { ...RESULT, v: 2 }],
    ["an unknown status", { ...RESULT, status: "done" }],
    ["an unknown claim state", { ...RESULT, claim_state: "maybe" }],
    ["a URL that isn't http", { ...RESULT, url: "file:///etc/passwd" }],
    ["a claim secret shorter than the relay allows", { ...RESULT, claim_secret: "short" }],
    ["a claim secret that isn't text", { ...RESULT, claim_secret: 42 }],
    ["an error that isn't text", { ...RESULT, status: "failed", error: { message: "x" } }],
  ])("refuses %s", (_label, message) => {
    expect(parseResult(message)).toBeNull();
  });
});
