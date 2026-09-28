import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeChild, type BridgeChild } from "../../__tests__/harness/bridgeChild.js";
import { formatAttachPreamble } from "../../host/attachStdio.js";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation } from "../../host/hostSocketPath.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import {
  ChildStdioDuplex,
  createCommandStreamTransport,
  type StreamCommandChild,
} from "../commandStreamTransport.js";
import { LinkClient } from "../LinkClient.js";
import { TransportError } from "../transport.js";

const TOKEN = "cd".repeat(32);

/** A child whose stdio the test drives by hand. */
class FakeStreamChild extends EventEmitter implements StreamCommandChild {
  stdin: Writable;
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Buffer[] = [];
  killed: NodeJS.Signals[] = [];

  constructor(stdin?: Writable) {
    super();
    this.stdin =
      stdin ??
      new Writable({
        write: (chunk: Buffer, _enc, callback) => {
          this.written.push(chunk);
          callback();
        },
      });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }

  exit(code: number, stderr = ""): void {
    this.stderr.end(stderr);
    this.stdout.end();
    setImmediate(() => this.emit("exit", code, null));
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

const signal = () => new AbortController().signal;

describe("createCommandStreamTransport", () => {
  it("skips startup noise, reads the token and keeps the bytes that follow the preamble", async () => {
    const child = new FakeStreamChild();
    const transport = createCommandStreamTransport(() => child);
    const opening = transport.open(signal());
    child.stdout.write("Last login: Tue\nWelcome to Ubuntu\n");
    child.stdout.write(
      Buffer.concat([Buffer.from(formatAttachPreamble(TOKEN)), Buffer.from([1, 2])])
    );
    const connection = await opening;
    expect(connection.token).toBe(TOKEN);

    const read: Buffer[] = [];
    connection.socket.on("data", (chunk: Buffer) => read.push(chunk));
    child.stdout.write(Buffer.from([3]));
    await waitFor(() => Buffer.concat(read).byteLength === 3);
    expect([...Buffer.concat(read)]).toEqual([1, 2, 3]);

    connection.socket.write(Buffer.from("hello"));
    await waitFor(() => child.written.length === 1);
    expect(Buffer.concat(child.written).toString()).toBe("hello");

    // Letting go closes the command's stdin; it is stopped only if it doesn't exit.
    let stdinEnded = false;
    child.stdin.on("finish", () => (stdinEnded = true));
    await connection.dispose();
    await waitFor(() => stdinEnded);
    expect(child.killed).toEqual([]);
  });

  it("reports the command's own stderr when it exits before the preamble", async () => {
    const child = new FakeStreamChild();
    const opening = createCommandStreamTransport(() => child).open(signal());
    child.exit(2, "daintree: no host is listening here\n");
    await expect(opening).rejects.toMatchObject({
      name: "TransportError",
      detail: "daintree: no host is listening here",
    });
  });

  it("gives up on a command that never answers, and on one that prints too much", async () => {
    const silent = new FakeStreamChild();
    await expect(
      createCommandStreamTransport(() => silent, { preambleTimeoutMs: 20 }).open(signal())
    ).rejects.toMatchObject({ message: "The host's attach bridge did not start in time" });
    expect(silent.killed).toContain("SIGTERM");

    const chatty = new FakeStreamChild();
    const opening = createCommandStreamTransport(() => chatty, { maxPreambleBytes: 64 }).open(
      signal()
    );
    chatty.stdout.write(`${"x".repeat(100)}\n`);
    await expect(opening).rejects.toBeInstanceOf(TransportError);
  });

  it("stops when cancelled, and refuses a command it could not start", async () => {
    const child = new FakeStreamChild();
    const controller = new AbortController();
    const opening = createCommandStreamTransport(() => child).open(controller.signal);
    controller.abort();
    await expect(opening).rejects.toMatchObject({ message: "Connection cancelled" });

    await expect(
      createCommandStreamTransport(() => {
        throw new Error("spawn ENOENT");
      }).open(signal())
    ).rejects.toMatchObject({ detail: "spawn ENOENT" });
  });
});

describe("ChildStdioDuplex", () => {
  it("holds writes until the command's stdin takes them (backpressure)", async () => {
    const pending: Array<() => void> = [];
    const stdin = new Writable({
      highWaterMark: 1,
      write: (_chunk, _enc, callback) => pending.push(callback),
    });
    const child = new FakeStreamChild(stdin);
    const duplex = new ChildStdioDuplex(child, null);
    const chunk = Buffer.alloc(8 * 1024);
    let accepted = 0;
    while (duplex.write(chunk)) accepted++;
    // Bounded by the duplex's own high-water mark while stdin sat on one chunk.
    expect((accepted + 1) * chunk.byteLength).toBeLessThanOrEqual(
      duplex.writableHighWaterMark + chunk.byteLength
    );
    expect(pending.length).toBe(1);
    const drained = new Promise<void>((resolve) => duplex.once("drain", resolve));
    const release = async () => {
      while (duplex.writableLength > 0) {
        pending.shift()?.();
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await Promise.all([drained, release()]);
    duplex.destroy();
  });

  it("pauses the command's stdout while nobody reads", async () => {
    const child = new FakeStreamChild();
    const duplex = new ChildStdioDuplex(child, null);
    const big = Buffer.alloc(64 * 1024);
    for (let i = 0; i < 8; i++) child.stdout.write(big);
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.stdout.isPaused()).toBe(true);
    let read = 0;
    duplex.on("data", (chunk: Buffer) => (read += chunk.byteLength));
    await waitFor(() => read === 8 * big.byteLength);
    duplex.destroy();
  });

  it("closes when the command's stdout ends, and stops a command that outlives it", async () => {
    const child = new FakeStreamChild();
    const duplex = new ChildStdioDuplex(child, null);
    duplex.resume();
    const closed = new Promise<void>((resolve) => duplex.once("close", resolve));
    child.exit(0);
    await closed;

    vi.useFakeTimers();
    try {
      const other = new FakeStreamChild();
      new ChildStdioDuplex(other, null).destroy();
      vi.advanceTimersByTime(1_999);
      expect(other.killed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(other.killed).toEqual(["SIGTERM"]);

      const polite = new FakeStreamChild();
      const duplex = new ChildStdioDuplex(polite, null);
      polite.emit("exit", 0, null);
      duplex.destroy();
      vi.advanceTimersByTime(5_000);
      expect(polite.killed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a link over the attach bridge", () => {
  it("handshakes with the real host through the bridge and closes cleanly", async () => {
    const hostLoc = hostSocketLocation({ platform: "darwin", userDataDir: path.join(root, "h") });
    server = new HostServer({ location: hostLoc, handshake: TEST_HANDSHAKE, hostName: "studio" });
    await server.listen();
    const children: BridgeChild[] = [];
    client = new LinkClient({
      transport: createCommandStreamTransport(() => {
        const child = bridgeChild(hostLoc.discoveryPath);
        children.push(child);
        return child;
      }),
      handshake: TEST_HANDSHAKE,
      client: { clientId: "c1", clientName: "mbp", platform: "darwin" },
      session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    });
    client.start();
    await waitFor(() => client!.getState().status === "connected");
    expect(server.sessions.length).toBe(1);
    await client.stop();
    client = null;
    expect(await children[0]!.exited).toBe(0);
    await waitFor(() => server!.sessions.length === 0);
  });
});
