import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir, waitFor } from "../../link/__tests__/linkTestUtils.js";
import {
  ATTACH_EXIT,
  formatAttachPreamble,
  parseAttachPreamble,
  runAttachStdioBridge,
} from "../attachStdio.js";
import { writeDiscoveryFile } from "../discoveryFile.js";

const TOKEN = "ab".repeat(32);

let root: string;
let server: net.Server | null = null;
const accepted: net.Socket[] = [];

beforeEach(async () => {
  root = await makeTempDir();
});

afterEach(async () => {
  for (const socket of accepted.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await removeTempDir(root);
});

async function listen(
  onConnection: (socket: net.Socket) => void,
  options: net.ServerOpts = {}
): Promise<string> {
  const socketPath = path.join(root, "host.sock");
  server = net.createServer(options, (socket) => {
    accepted.push(socket);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  const discoveryPath = path.join(root, "host.json");
  await writeDiscoveryFile(discoveryPath, { version: 1, socketPath, token: TOKEN, pid: 1 });
  return discoveryPath;
}

function collect(stream: PassThrough): () => Buffer {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

describe("attach preamble", () => {
  it("round-trips the token and refuses anything else", () => {
    const line = formatAttachPreamble(TOKEN);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseAttachPreamble(line.slice(0, -1))).toBe(TOKEN);
    expect(parseAttachPreamble(`${line.slice(0, -1)}\r`)).toBe(TOKEN);
    expect(parseAttachPreamble("Welcome to Ubuntu")).toBeNull();
    expect(parseAttachPreamble("daintree-attach 1 short")).toBeNull();
    expect(parseAttachPreamble(`daintree-attach 2 ${TOKEN}`)).toBeNull();
  });
});

describe("runAttachStdioBridge", () => {
  it("says no host is listening when there is no discovery file", async () => {
    const errors = new PassThrough();
    const said = collect(errors);
    const code = await runAttachStdioBridge({
      discoveryPath: path.join(root, "missing.json"),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput: errors,
    });
    expect(code).toBe(ATTACH_EXIT.noHost);
    expect(said().toString()).toContain("no host is listening here");
  });

  it("reports what connecting to the socket said", async () => {
    const discoveryPath = path.join(root, "host.json");
    await writeDiscoveryFile(discoveryPath, {
      version: 1,
      socketPath: path.join(root, "gone.sock"),
      token: TOKEN,
      pid: 1,
    });
    const errors = new PassThrough();
    const said = collect(errors);
    const code = await runAttachStdioBridge({
      discoveryPath,
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput: errors,
    });
    expect(code).toBe(ATTACH_EXIT.connectFailed);
    expect(said().toString()).toMatch(/could not connect to .*gone\.sock: .*ENOENT/);
  });

  it("writes the preamble, then carries bytes both ways until the host closes", async () => {
    const fromShell: Buffer[] = [];
    let hostSide: net.Socket | null = null;
    const discoveryPath = await listen((socket) => {
      hostSide = socket;
      socket.on("data", (chunk: Buffer) => fromShell.push(chunk));
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const received = collect(output);
    const done = runAttachStdioBridge({ discoveryPath, input, output });

    await waitFor(() => hostSide !== null);
    const binary = Buffer.from([0, 1, 2, 0x0a, 0xff, 0xfe]);
    input.write(binary);
    await waitFor(() => Buffer.concat(fromShell).equals(binary));
    hostSide!.write(Buffer.from([9, 8, 7]));
    await waitFor(() => received().byteLength === formatAttachPreamble(TOKEN).length + 3);
    const bytes = received();
    expect(bytes.subarray(0, bytes.byteLength - 3).toString()).toBe(formatAttachPreamble(TOKEN));
    expect([...bytes.subarray(-3)]).toEqual([9, 8, 7]);

    hostSide!.end();
    expect(await done).toBe(ATTACH_EXIT.ok);
    expect(output.writableEnded).toBe(true);
  });

  it("tells the host when the Shell's side closes, and exits once it does", async () => {
    let sawEnd = false;
    const discoveryPath = await listen((socket) => {
      socket.on("data", () => {});
      socket.on("end", () => {
        sawEnd = true;
      });
    });
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const done = runAttachStdioBridge({ discoveryPath, input, output });
    await waitFor(() => accepted.length === 1);
    input.end();
    expect(await done).toBe(ATTACH_EXIT.ok);
    expect(sawEnd).toBe(true);
  });

  it("exits after the grace period when the host never closes its side", async () => {
    // A host that sees our end but keeps its own side open.
    const discoveryPath = await listen(
      (socket) => {
        socket.on("data", () => {});
      },
      { allowHalfOpen: true }
    );
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const done = runAttachStdioBridge({ discoveryPath, input, output, endGraceMs: 50 });
    await waitFor(() => accepted.length === 1);
    input.end();
    expect(await done).toBe(ATTACH_EXIT.ok);
  });
});
