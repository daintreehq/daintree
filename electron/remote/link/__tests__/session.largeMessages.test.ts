import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type net from "node:net";
import { FrameDecoder, Lane, type LinkFrame } from "../frames.js";
import { ControlKind, InteractiveKind } from "../messages.js";
import { LinkSession } from "../session.js";
import { makeTempDir, removeTempDir, socketPair, waitFor } from "./linkTestUtils.js";

let dir: string;
const sessions: LinkSession[] = [];
const sockets: net.Socket[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close("test done");
  for (const s of sockets.splice(0)) s.destroy();
  await removeTempDir(dir);
});

/** Far larger than any socket buffer, so the sender stalls partway through it. */
const BIG = "x".repeat(4 * 1024 * 1024);

/**
 * A host and client that both read message fragments, over a real socket
 * whose client end starts paused: whatever the host writes stalls until the
 * test resumes it.
 */
async function stalledPair() {
  const { a, b } = await socketPair(dir);
  sockets.push(a, b);
  const options = { pingIntervalMs: 0, idleTimeoutMs: 0 } as const;
  const host = new LinkSession(a, { ...options, role: "host" });
  const client = new LinkSession(b, { ...options, role: "client" });
  sessions.push(host, client);
  host.open({ peerReadsFragments: true });
  client.open({ peerReadsFragments: true });
  b.pause();
  return { host, client, a, b };
}

function postOutput(session: LinkSession, terminalId: string, data: string): void {
  session.post({
    lane: Lane.INTERACTIVE,
    kind: InteractiveKind.TERMINAL_OUT,
    body: { endpointId: "e1", terminalId, incarnation: 1, seq: 1, message: { type: "data", data } },
  });
}

describe("LinkSession large messages (#15892)", () => {
  it("writes a ping and another terminal's output ahead of a multi-megabyte snapshot already being written", async () => {
    const { host, client, a, b } = await stalledPair();
    const seen: string[] = [];
    let pingBeforeReset: boolean | null = null;
    let snapshotData: string | null = null;
    client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_OUT, (body) => {
      seen.push(`out:${body.terminalId}`);
    });
    client.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_RESET, (body) => {
      seen.push(`reset:${body.terminalId}`);
      pingBeforeReset = client.peerPingNonce !== null;
      snapshotData = body.snapshot?.data ?? null;
    });

    host.post({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.TERMINAL_RESET,
      body: {
        endpointId: "e1",
        terminalId: "t1",
        incarnation: 1,
        snapshot: { data: BIG, cols: 80, rows: 24 },
        seq: 0,
      },
    });
    await waitFor(() => a.writableNeedDrain);
    host.ping();
    postOutput(host, "t2", "echo");
    b.resume();

    await waitFor(() => seen.includes("reset:t1"));
    expect(seen).toEqual(["out:t2", "reset:t1"]);
    expect(pingBeforeReset).toBe(true);
    expect(snapshotData).toBe(BIG);
  });

  it("writes a ping and a small interactive frame ahead of a multi-megabyte RPC result already being written", async () => {
    const { host, client, a, b } = await stalledPair();
    host.setInvokeHandler(async () => ({ __daintreeIpcEnvelope: true, ok: true, data: BIG }));
    const decoder = new FrameDecoder();
    const frames: LinkFrame[] = [];
    b.on("data", (chunk: Buffer) => frames.push(...decoder.push(chunk)));

    const result = client.invoke("e1", "review:compare", []);
    await waitFor(() => a.writableNeedDrain);
    host.ping();
    postOutput(host, "t1", "echo");
    b.resume();

    const envelope = await result;
    expect(envelope).toEqual({ __daintreeIpcEnvelope: true, ok: true, data: BIG });
    const pingAt = frames.findIndex((f) => f.lane === Lane.CONTROL && f.kind === ControlKind.PING);
    const echoAt = frames.findIndex(
      (f) => f.lane === Lane.INTERACTIVE && f.kind === InteractiveKind.TERMINAL_OUT
    );
    const resultEndsAt = frames.findLastIndex((f) => f.lane === Lane.RPC);
    expect(pingAt).toBeGreaterThanOrEqual(0);
    expect(echoAt).toBeGreaterThanOrEqual(0);
    expect(pingAt).toBeLessThan(resultEndsAt);
    expect(echoAt).toBeLessThan(resultEndsAt);
  });
});
