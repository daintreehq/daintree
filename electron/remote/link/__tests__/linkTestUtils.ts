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

export interface LinkConditions {
  /** Added to every byte's trip, in each direction. */
  oneWayDelayMs: number;
  /** Each direction's rate; unlimited when absent. */
  bytesPerSecond?: number;
  /**
   * Bytes a direction holds waiting for its rate before the sender is pushed
   * back, the way a full socket buffer pushes back.
   */
  queueBytes?: number;
}

const DEFAULT_QUEUE_BYTES = 256 * 1024;

/**
 * Carry one direction of a connection over an emulated link: each chunk leaves
 * once the rate has serialized everything before it and arrives
 * `oneWayDelayMs` later, in order. Bytes in propagation never push back; only
 * a backlog behind the rate does, so latency alone doesn't cap throughput.
 */
function relayDirection(from: net.Socket, to: net.Socket, conditions: LinkConditions): void {
  const queue: Array<{ chunk: Buffer; at: number }> = [];
  const rate = conditions.bytesPerSecond ?? null;
  const limit = conditions.queueBytes ?? DEFAULT_QUEUE_BYTES;
  let wireFreeAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const deliver = () => {
    timer = null;
    const now = performance.now();
    while (queue.length > 0 && queue[0]!.at <= now) to.write(queue.shift()!.chunk);
    arm();
  };
  const arm = () => {
    if (timer || queue.length === 0 || to.destroyed) return;
    timer = setTimeout(deliver, Math.max(0, queue[0]!.at - performance.now()));
  };
  from.on("data", (chunk: Buffer) => {
    const now = performance.now();
    wireFreeAt = Math.max(now, wireFreeAt) + (rate ? (chunk.byteLength / rate) * 1000 : 0);
    const at = wireFreeAt + conditions.oneWayDelayMs;
    if (queue.length === 0 && at <= now) to.write(chunk);
    else {
      queue.push({ chunk, at });
      arm();
    }
    if (!rate || resumeTimer) return;
    const backlog = ((wireFreeAt - now) * rate) / 1000;
    if (backlog <= limit) return;
    from.pause();
    resumeTimer = setTimeout(
      () => {
        resumeTimer = null;
        from.resume();
      },
      ((backlog - limit / 2) / rate) * 1000
    );
  });
  from.once("close", () => {
    if (timer) clearTimeout(timer);
    if (resumeTimer) clearTimeout(resumeTimer);
    queue.length = 0;
    to.destroy();
  });
}

/**
 * Two ends of one connection that runs through an emulated link with the given
 * delay and rate in each direction (two real Unix sockets joined by a relay).
 */
export async function conditionedSocketPair(
  dir: string,
  conditions: LinkConditions
): Promise<{ a: net.Socket; b: net.Socket }> {
  const near = await socketPair(dir);
  const far = await socketPair(dir);
  // The relay's own ends: a reset while one side tears down closes both, never throws.
  for (const [end, other] of [
    [near.b, far.a],
    [far.a, near.b],
  ] as const) {
    end.on("error", () => {
      end.destroy();
      other.destroy();
    });
  }
  relayDirection(near.b, far.a, conditions);
  relayDirection(far.a, near.b, conditions);
  return { a: near.a, b: far.b };
}

type Extra = Omit<LinkSessionOptions, "role">;

/**
 * A host and client session over a real socket, opened without a handshake
 * but as one would leave them (each reading the other's message fragments);
 * over an emulated link when `conditions` are given.
 */
export async function openSessionPair(
  dir: string,
  hostOptions: Extra = {},
  clientOptions: Extra = {},
  conditions?: LinkConditions
): Promise<{ host: LinkSession; client: LinkSession }> {
  const { a, b } = conditions
    ? await conditionedSocketPair(dir, conditions)
    : await socketPair(dir);
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
  host.open({ peerReadsFragments: true });
  client.open({ peerReadsFragments: true });
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
