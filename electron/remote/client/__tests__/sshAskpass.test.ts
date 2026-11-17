import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readOneLine, runAskpassClient, type AskpassRequest } from "../sshAskpass.js";

vi.mock("electron", () => ({ app: { dock: { hide: vi.fn() } } }));

let dir: string;
let server: net.Server | null = null;
const accepted = new Set<net.Socket>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "askp-"));
});

afterEach(async () => {
  const listening = server;
  server = null;
  // A test that failed mid-way may leave a helper connected, which would hold close() open.
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  if (listening) await new Promise<void>((resolve) => listening.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the sign-in's socket: records each request and answers it as `respond` says. */
async function relay(
  respond: (request: AskpassRequest, socket: net.Socket) => void
): Promise<{ socketPath: string; requests: AskpassRequest[] }> {
  const socketPath = path.join(dir, "s");
  const requests: AskpassRequest[] = [];
  server = net.createServer((socket) => {
    accepted.add(socket);
    socket.on("error", () => {});
    readOneLine(socket, 64 * 1024, (line) => {
      if (line === null) return;
      const request = JSON.parse(line) as AskpassRequest;
      requests.push(request);
      respond(request, socket);
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(socketPath, resolve));
  return { socketPath, requests };
}

describe.skipIf(process.platform === "win32")("runAskpassClient", () => {
  it("sends the prompt with the sign-in's token and prints the answer it gets back", async () => {
    const { socketPath, requests } = await relay((_request, socket) =>
      socket.end(`${JSON.stringify({ answer: "correct horse" })}\n`)
    );
    const writeAnswer = vi.fn(() => Promise.resolve());
    const client = runAskpassClient({
      socketPath,
      token: "t0ken",
      prompt: "Enter passphrase for key '/Users/g/.ssh/id_ed25519':",
      hint: "",
      writeAnswer,
    });
    expect(await client.done).toBe(0);
    expect(writeAnswer).toHaveBeenCalledWith("correct horse");
    expect(requests).toEqual([
      { token: "t0ken", prompt: "Enter passphrase for key '/Users/g/.ssh/id_ed25519':", hint: "" },
    ]);
  });

  it("exits non-zero without printing when the sign-in refuses the prompt", async () => {
    const { socketPath } = await relay((_request, socket) =>
      socket.end(`${JSON.stringify({ refuse: true })}\n`)
    );
    const writeAnswer = vi.fn(() => Promise.resolve());
    const client = runAskpassClient({
      socketPath,
      token: "t",
      prompt: "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
      hint: "",
      writeAnswer,
    });
    expect(await client.done).toBe(1);
    expect(writeAnswer).not.toHaveBeenCalled();
  });

  it("exits non-zero when the sign-in goes away without answering", async () => {
    const { socketPath } = await relay((_request, socket) => socket.destroy());
    const writeAnswer = vi.fn(() => Promise.resolve());
    const client = runAskpassClient({
      socketPath,
      token: "t",
      prompt: "Password:",
      hint: "",
      writeAnswer,
    });
    expect(await client.done).toBe(1);
    expect(writeAnswer).not.toHaveBeenCalled();
  });

  it("exits non-zero when there is no sign-in to reach", async () => {
    const client = runAskpassClient({
      socketPath: path.join(dir, "nothing-here"),
      token: "t",
      prompt: "Password:",
      hint: "",
      writeAnswer: () => Promise.resolve(),
    });
    expect(await client.done).toBe(1);
  });

  it("holds a notice until ssh stops it, and lets go of the connection then", async () => {
    let held: net.Socket | null = null;
    const { socketPath, requests } = await relay((_request, socket) => {
      held = socket;
    });
    const closed = new Promise<void>((resolve) =>
      server!.once("connection", (socket) => socket.once("close", () => resolve()))
    );
    const client = runAskpassClient({
      socketPath,
      token: "t",
      prompt: "Confirm user presence for key ECDSA-SK SHA256:abc",
      hint: "none",
      writeAnswer: () => Promise.resolve(),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.hint).toBe("none");
    expect(held).not.toBeNull();
    client.stop();
    expect(await client.done).toBe(1);
    await closed;
  });
});

describe.skipIf(process.platform === "win32")("--ssh-askpass", () => {
  const saved = { ...process.env };
  const consoleMethods = { ...console };
  afterEach(() => {
    // The helper sends console output to stderr for good; the worker gets its own back.
    Object.assign(console, consoleMethods);
    for (const key of [
      "DAINTREE_ASKPASS_SOCKET",
      "DAINTREE_ASKPASS_TOKEN",
      "DAINTREE_ASKPASS_PROMPT",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (saved.SSH_ASKPASS_PROMPT === undefined) delete process.env.SSH_ASKPASS_PROMPT;
    else process.env.SSH_ASKPASS_PROMPT = saved.SSH_ASKPASS_PROMPT;
  });

  it("lets go of a notice when ssh sends SIGTERM, printing nothing", async () => {
    const { socketPath, requests } = await relay(() => {});
    process.env.DAINTREE_ASKPASS_SOCKET = socketPath;
    process.env.DAINTREE_ASKPASS_TOKEN = "t0ken";
    process.env.DAINTREE_ASKPASS_PROMPT = "Confirm user presence for key ED25519-SK SHA256:abc";
    process.env.SSH_ASKPASS_PROMPT = "none";
    const write = vi.spyOn(process.stdout, "write");
    onTestFinished(() => write.mockRestore());
    const closed = new Promise<void>((resolve) =>
      server!.once("connection", (socket) => socket.once("close", () => resolve()))
    );
    const before = new Set(process.listeners("SIGTERM"));
    const { runSshAskpassCli } = await import("../sshAskpassCli.js");
    const exited = runSshAskpassCli();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      token: "t0ken",
      prompt: "Confirm user presence for key ED25519-SK SHA256:abc",
      hint: "none",
    });
    // What ssh's SIGTERM reaches: the helper's own handler, not the test worker's.
    const added = process.listeners("SIGTERM").filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);
    added[0]!("SIGTERM");
    expect(await exited).toBe(1);
    await closed;
    expect(write).not.toHaveBeenCalled();
    expect(process.listeners("SIGTERM")).not.toContain(added[0]);
  });

  it("prints the answer for ssh and nothing else", async () => {
    const { socketPath } = await relay((_request, socket) =>
      socket.end(`${JSON.stringify({ answer: "hunter2" })}\n`)
    );
    process.env.DAINTREE_ASKPASS_SOCKET = socketPath;
    process.env.DAINTREE_ASKPASS_TOKEN = "t0ken";
    process.env.DAINTREE_ASKPASS_PROMPT = "Password:";
    delete process.env.SSH_ASKPASS_PROMPT;
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string,
      callback?: (error?: Error | null) => void
    ) => {
      written.push(String(chunk));
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    onTestFinished(() => write.mockRestore());
    const { runSshAskpassCli } = await import("../sshAskpassCli.js");
    expect(await runSshAskpassCli()).toBe(0);
    expect(written).toEqual(["hunter2\n"]);
  });
});
