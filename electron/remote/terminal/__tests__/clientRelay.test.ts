import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lane } from "../../link/frames.js";
import { InteractiveKind } from "../../link/messages.js";
import type { LinkSession } from "../../link/session.js";
import {
  makeTempDir,
  openSessionPair,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import { ClientTerminalRelay, type ClientTerminalRelayOptions } from "../ClientTerminalRelay.js";
import {
  MAX_RESUME_TERMINALS,
  TERMINAL_RESUME_METHOD,
  TerminalResumeRequestSchema,
  type TerminalResumeRequest,
} from "../protocol.js";
import { FakePeer } from "./streamTestUtils.js";

const ENDPOINT = "view-11";

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await removeTempDir(dir);
});

interface Harness {
  relay: ClientTerminalRelay;
  renderer: () => FakePeer | null;
  host: LinkSession;
  client: LinkSession;
  resumes: TerminalResumeRequest[];
  inputs: Array<Record<string, unknown>>;
  emit(id: string, seq: number, incarnation?: number): void;
  reset(id: string, seq: number): void;
  connect(): Promise<void>;
}

async function setup(options: Partial<ClientTerminalRelayOptions> = {}): Promise<Harness> {
  let rendererPeer: FakePeer | null = null;
  const relay = new ClientTerminalRelay({
    endpointId: ENDPOINT,
    hostId: "studio-01",
    openRendererPort: () => {
      rendererPeer = new FakePeer();
      return rendererPeer.port;
    },
    ...options,
  });
  cleanups.push(() => {
    relay.dispose();
    rendererPeer?.close();
  });
  const h: Harness = {
    relay,
    renderer: () => rendererPeer,
    host: null as unknown as LinkSession,
    client: null as unknown as LinkSession,
    resumes: [],
    inputs: [],
    emit(id, seq, incarnation = 1) {
      const data = new TextEncoder().encode(`${id}:${seq}`);
      h.host.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_OUT,
        body: {
          endpointId: ENDPOINT,
          terminalId: id,
          incarnation,
          seq,
          message: { type: "data", id, data, bytes: data.byteLength },
        },
      });
    },
    reset(id, seq) {
      h.host.post({
        lane: Lane.INTERACTIVE,
        kind: InteractiveKind.TERMINAL_RESET,
        body: {
          endpointId: ENDPOINT,
          terminalId: id,
          incarnation: 1,
          seq,
          snapshot: { data: "SNAP", cols: 120, rows: 40 },
        },
      });
    },
    async connect() {
      const { host, client } = await openSessionPair(dir);
      cleanups.push(() => {
        host.close("test done");
        client.close("test done");
      });
      h.host = host;
      h.client = client;
      host.registerCallHandler(TERMINAL_RESUME_METHOD, TerminalResumeRequestSchema, (request) => {
        h.resumes.push(request);
        return {
          terminals: request.terminals.map((t) => ({ id: t.id, outcome: "replayed" as const })),
        };
      });
      host.on(Lane.INTERACTIVE, InteractiveKind.TERMINAL_IN, (body) => {
        h.inputs.push(body.message as Record<string, unknown>);
      });
      relay.attach(client);
      await waitFor(() => h.resumes.length > 0 && !relay.resumeInFlight);
    },
  };
  return h;
}

async function dropLink(h: Harness): Promise<void> {
  const closed = new Promise((resolve) => h.host.onClose(resolve));
  h.client.close("network gone");
  await closed;
  await waitFor(() => !h.relay.isAttached);
}

describe("ClientTerminalRelay", () => {
  it("passes a reset's snapshot and grid through to the renderer unchanged", async () => {
    const h = await setup();
    h.relay.deliverPort();
    await h.connect();
    h.reset("t1", 7);
    await waitFor(() => h.renderer()!.ofType("reset").length === 1);
    expect(h.renderer()!.ofType("reset")[0]).toEqual({
      type: "reset",
      id: "t1",
      snapshot: { data: "SNAP", cols: 120, rows: 40 },
    });
    expect(h.relay.position("t1")).toEqual({ incarnation: 1, lastSeq: 7 });
  });

  it("does not count output as seen while the view has no port, and resets once one arrives", async () => {
    const h = await setup();
    h.relay.deliverPort();
    await h.connect();
    h.emit("t1", 1);
    await waitFor(() => h.relay.position("t1")?.lastSeq === 1);

    h.renderer()!.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.emit("t1", 2);
    h.emit("t1", 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Undelivered frames leave the position alone and ask for nothing yet.
    expect(h.relay.position("t1")).toEqual({ incarnation: 1, lastSeq: 1 });
    const before = h.resumes.length;

    h.relay.deliverPort();
    await waitFor(() => h.resumes.length === before + 1 && !h.relay.resumeInFlight);
    expect(h.resumes.at(-1)!.terminals).toEqual([
      { id: "t1", incarnation: 1, lastSeq: 1, reset: true },
    ]);
  });

  it("owes a reset for a port replaced while the link was down and asks for it on attach", async () => {
    const h = await setup();
    h.relay.deliverPort();
    await h.connect();
    h.emit("t1", 1);
    h.emit("t2", 1);
    await waitFor(() => h.relay.position("t2") !== null);
    await dropLink(h);

    h.relay.deliverPort();
    h.resumes.length = 0;
    await h.connect();
    expect(h.resumes[0]!.terminals).toEqual([
      { id: "t1", incarnation: 1, lastSeq: 1, reset: true },
      { id: "t2", incarnation: 1, lastSeq: 1, reset: true },
    ]);

    // Settled: the next reconnect is a plain resume.
    await dropLink(h);
    h.resumes.length = 0;
    await h.connect();
    expect(h.resumes[0]!.terminals.every((t) => t.reset === undefined)).toBe(true);
  });

  it("bounds input held while the link is down by messages, bytes and distinct resizes", async () => {
    const h = await setup({
      maxPendingInputMessages: 3,
      maxPendingInputBytes: 10,
      maxPendingResizes: 2,
    });
    h.relay.deliverPort();
    const renderer = h.renderer()!;
    for (let i = 0; i < 5; i++) renderer.post({ type: "write", id: "t1", data: "" });
    renderer.post({ type: "resize", id: "a", cols: 80, rows: 24 });
    renderer.post({ type: "resize", id: "b", cols: 80, rows: 24 });
    renderer.post({ type: "resize", id: "c", cols: 80, rows: 24 });
    renderer.post({ type: "resize", id: "b", cols: 100, rows: 30 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await h.connect();
    await waitFor(() => h.inputs.length === 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.inputs).toEqual([
      { type: "resize", id: "c", cols: 80, rows: 24 },
      { type: "resize", id: "b", cols: 100, rows: 30 },
      { type: "write", id: "t1", data: "" },
      { type: "write", id: "t1", data: "" },
      { type: "write", id: "t1", data: "" },
    ]);

    await dropLink(h);
    h.inputs.length = 0;
    renderer.post({ type: "write", id: "t1", data: "123456" });
    renderer.post({ type: "write", id: "t1", data: "7890ab" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.connect();
    await waitFor(() => h.inputs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.inputs).toEqual([{ type: "write", id: "t1", data: "123456" }]);
  });

  it("keeps a bounded set of positions as terminals come and go", async () => {
    const h = await setup();
    h.relay.deliverPort();
    await h.connect();
    const total = MAX_RESUME_TERMINALS + 500;
    for (let i = 0; i < total; i++) h.emit(`t${i}`, 1);
    await waitFor(() => h.relay.position(`t${total - 1}`) !== null, 20_000);
    expect(h.relay.trackedTerminals).toBe(MAX_RESUME_TERMINALS);
    // The least recently active went first.
    expect(h.relay.position("t0")).toBeNull();
    expect(h.relay.position(`t${total - 1}`)).not.toBeNull();
  }, 30_000);

  it("splits a resume across calls the host's schema accepts", async () => {
    const h = await setup({ maxTrackedTerminals: MAX_RESUME_TERMINALS * 2 });
    h.relay.deliverPort();
    await h.connect();
    const total = MAX_RESUME_TERMINALS + 10;
    for (let i = 0; i < total; i++) h.emit(`t${i}`, 1);
    await waitFor(() => h.relay.trackedTerminals === total, 20_000);
    await dropLink(h);

    h.resumes.length = 0;
    await h.connect();
    await waitFor(() => h.resumes.length === 2 && !h.relay.resumeInFlight);
    expect(h.resumes.map((r) => r.terminals.length).sort((a, b) => b - a)).toEqual([
      MAX_RESUME_TERMINALS,
      10,
    ]);
  }, 30_000);

  it("forgets a terminal the host no longer has", async () => {
    const h = await setup();
    h.relay.deliverPort();
    await h.connect();
    h.emit("t1", 1);
    await waitFor(() => h.relay.position("t1") !== null);
    await dropLink(h);

    const { host, client } = await openSessionPair(dir);
    cleanups.push(() => {
      host.close("test done");
      client.close("test done");
    });
    host.registerCallHandler(TERMINAL_RESUME_METHOD, TerminalResumeRequestSchema, (request) => ({
      terminals: request.terminals.map((t) => ({ id: t.id, outcome: "unknown" as const })),
    }));
    h.relay.attach(client);
    await waitFor(() => !h.relay.resumeInFlight && h.relay.position("t1") === null);
    expect(h.relay.trackedTerminals).toBe(0);
  });
});
