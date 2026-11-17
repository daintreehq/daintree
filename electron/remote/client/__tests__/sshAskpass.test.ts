import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOneLine, runAskpassClient, type AskpassRequest } from "../sshAskpass.js";

let dir: string;
let server: net.Server | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "askp-"));
});

afterEach(async () => {
  const listening = server;
  server = null;
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

describe("runAskpassClient", () => {
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
