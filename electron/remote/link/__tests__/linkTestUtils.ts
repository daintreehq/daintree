import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { HostHandshakeInfo } from "../../../../shared/types/remoteHosts.js";
import { LinkSession, type LinkSessionOptions } from "../session.js";

export const TEST_HANDSHAKE: HostHandshakeInfo = {
  version: "1.2.3",
  commit: "abc123",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
};

/** A short temp directory: Unix socket paths are capped near 104 bytes. */
export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "dl-"));
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Two ends of one real Unix socket connection. */
export async function socketPair(dir: string): Promise<{ a: net.Socket; b: net.Socket }> {
  const socketPath = path.join(dir, `p${Math.random().toString(36).slice(2, 8)}.sock`);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  const b = net.connect(socketPath);
  await new Promise<void>((resolve) => b.once("connect", resolve));
  const a = await accepted;
  server.close();
  return { a, b };
}

type Extra = Omit<LinkSessionOptions, "role">;

/** A host and client session over a real socket, opened without a handshake. */
export async function openSessionPair(
  dir: string,
  hostOptions: Extra = {},
  clientOptions: Extra = {}
): Promise<{ host: LinkSession; client: LinkSession }> {
  const { a, b } = await socketPair(dir);
  const host = new LinkSession(a, {
    pingIntervalMs: 0,
    idleTimeoutMs: 0,
    ...hostOptions,
    role: "host",
  });
  const client = new LinkSession(b, {
    pingIntervalMs: 0,
    idleTimeoutMs: 0,
    ...clientOptions,
    role: "client",
  });
  host.open();
  client.open();
  return { host, client };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function closedPromise(session: LinkSession): Promise<{ reason: string; by: string }> {
  return new Promise((resolve) => session.onClose(resolve));
}
