import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ParseAuthority } from "../parseAuthority";
import {
  AuthorityEndpoint,
  IngestPortConsumer,
  createInThreadTransport,
} from "../parseTransport";
import type {
  AuthorityRequest,
  AuthorityResponse,
  AuthorityTransport,
  IngestPortMessage,
} from "../parseTransport";
import { WorkerParseSession } from "../WorkerParseSession";
import { LiveWorkerIngest } from "../LiveWorkerIngest";
import type { LiveWorkerIngestDeps } from "../LiveWorkerIngest";

function makeMirror(options: { cols?: number; rows?: number; scrollback?: number } = {}) {
  const terminal = new Terminal({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1000,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon as unknown as Parameters<Terminal["loadAddon"]>[0]);
  return { terminal, serializeAddon };
}

function bufferText(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\n+$/, "");
}

function drain(terminal: Terminal): Promise<void> {
  return new Promise((resolve) => terminal.write("", () => resolve()));
}

async function until(cond: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function expectOnceInOrder(text: string, markers: string[]): void {
  const positions = markers.map((marker) => text.indexOf(marker));
  expect(positions.every((index) => index >= 0)).toBe(true);
  expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  for (const marker of markers) {
    expect(text.split(marker)).toHaveLength(2);
  }
}

describe("IngestPortConsumer", () => {
  function makeConsumerHarness() {
    const authority = new ParseAuthority({ cols: 80, rows: 24, scrollback: 1000 });
    const acks: Array<{ id: string; bytes: number }> = [];
    const responses: AuthorityResponse[] = [];
    let parsedCount = 0;
    let queue: Promise<void> = Promise.resolve();
    const consumer = new IngestPortConsumer({
      write: (data, onParsed) =>
        authority.write(data, () => {
          parsedCount += 1;
          onParsed();
        }),
      postAck: (ack) => {
        acks.push({ id: ack.id, bytes: ack.bytes });
      },
      postResponse: (response) => responses.push(response),
      enqueue: (task) => {
        queue = queue.then(task);
      },
    });
    const settle = async () => {
      await queue;
      await authority.drain();
      // One macrotask so write-completion callbacks (acks) land.
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
      authority,
      consumer,
      acks,
      responses,
      settle,
      parsedAt: () => parsedCount,
      data: (payload: string): IngestPortMessage => ({
        type: "data",
        id: "t1",
        data: payload,
        bytes: payload.length,
      }),
    };
  }

  it("acks only after the authority actually parsed the chunk", async () => {
    const h = makeConsumerHarness();
    let parsedWhenAcked = -1;
    const originalPush = h.acks.push.bind(h.acks);
    vi.spyOn(h.acks, "push").mockImplementation((...items) => {
      parsedWhenAcked = h.parsedAt();
      return originalPush(...items);
    });

    h.consumer.activate();
    h.consumer.handlePortMessage(h.data("hello worker\r\n"));
    expect(h.acks).toHaveLength(0);

    await h.settle();
    expect(h.acks).toHaveLength(1);
    expect(h.acks[0]).toEqual({ id: "t1", bytes: 14 });
    // The ack fired from the write-completion callback — parse first, ack after.
    expect(parsedWhenAcked).toBeGreaterThanOrEqual(1);
    expect(h.authority.bufferText()).toContain("hello worker");

    h.authority.dispose();
  });

  it("holds port chunks until activate so relayed control writes stay ahead", async () => {
    const h = makeConsumerHarness();

    // Port chunk arrives first in wall-clock, but pre-activate it must wait.
    h.consumer.handlePortMessage(h.data("PORT-1\r\n"));
    // Relayed pre-engage byte rides the control FIFO...
    h.authority.write("RELAYED-1\r\n");
    // ...and activate runs behind it (the worker entry enqueues it the same way).
    h.consumer.activate();
    h.consumer.handlePortMessage(h.data("PORT-2\r\n"));

    await h.settle();
    expectOnceInOrder(h.authority.bufferText(), ["RELAYED-1", "PORT-1", "PORT-2"]);
    expect(h.acks).toHaveLength(2);

    h.authority.dispose();
  });

  it("answers the ingest-detached sentinel with port-drained after all prior chunks queued, then holds again", async () => {
    const h = makeConsumerHarness();
    h.consumer.activate();
    h.consumer.handlePortMessage(h.data("BEFORE-SENTINEL\r\n"));

    h.consumer.handlePortMessage({ type: "ingest-detached", drainId: 7 });
    await h.settle();

    const drained = h.responses.find((r) => r.type === "port-drained");
    expect(drained).toEqual({ type: "port-drained", drainId: 7 });
    // The barrier guarantee: every pre-sentinel chunk is queued ahead of the
    // drained answer, so anything ordered behind it (the promotion snapshot)
    // observes the chunk.
    expect(h.authority.bufferText()).toContain("BEFORE-SENTINEL");

    // Post-sentinel chunks hold until the next activate (re-engage cycle).
    h.consumer.handlePortMessage(h.data("AFTER-SENTINEL\r\n"));
    await h.settle();
    expect(h.authority.bufferText()).not.toContain("AFTER-SENTINEL");
    h.consumer.activate();
    await h.settle();
    expect(h.authority.bufferText()).toContain("AFTER-SENTINEL");

    h.authority.dispose();
  });

  it("still acks and surfaces a worker error when the write throws", async () => {
    const acks: Array<{ id: string; bytes: number }> = [];
    const responses: AuthorityResponse[] = [];
    let queue: Promise<void> = Promise.resolve();
    const consumer = new IngestPortConsumer({
      write: () => {
        throw new Error("write buffer overflow");
      },
      postAck: (ack) => acks.push(ack),
      postResponse: (response) => responses.push(response),
      enqueue: (task) => {
        queue = queue.then(task);
      },
    });
    consumer.activate();
    consumer.handlePortMessage({ type: "data", id: "t1", data: "x", bytes: 1 });
    await queue;

    // Flow control stays honest even though the content is lost...
    expect(acks).toEqual([{ type: "ack", id: "t1", bytes: 1 }]);
    // ...and the requestId-less error drives the controller's fallback.
    expect(responses).toEqual([
      { type: "error", message: expect.stringContaining("write buffer overflow") },
    ]);
  });
});

describe("WorkerParseSession initial seed", () => {
  it("restores initialSerializedState into the authority before any feed", async () => {
    const mirror = makeMirror();
    const session = new WorkerParseSession(
      createInThreadTransport(),
      { write: (data, cb) => mirror.terminal.write(data, cb) },
      { cols: 80, rows: 24, scrollback: 1000, cadenceMs: 0, initialSerializedState: "seeded-content\r\n" }
    );
    session.feed("fed-later\r\n");
    await session.promoteToInteractive();
    await drain(mirror.terminal);

    expectOnceInOrder(bufferText(mirror.terminal), ["seeded-content", "fed-later"]);

    session.dispose();
    mirror.terminal.dispose();
  });
});

// A dedicated port fake: host-side posts deliver synchronously to the
// worker-side handler, so tests control the exact interleaving the real
// system's two channels can produce.
class FakePort {
  handler: ((msg: unknown) => void) | null = null;
  closed = false;
  acks: Array<{ id: string; bytes: number }> = [];
  hostPost(msg: IngestPortMessage): void {
    this.handler?.(msg);
  }
  postMessage(msg: unknown): void {
    this.acks.push(msg as { id: string; bytes: number });
  }
  close(): void {
    this.closed = true;
  }
}

// In-thread replica of parseWorker.ts's wiring: same AuthorityEndpoint, same
// single FIFO for control requests and port chunks, same activate/hold
// semantics — minus the actual Worker thread.
function createFakeWorkerTransport() {
  const listeners = new Set<(response: AuthorityResponse) => void>();
  const post = (response: AuthorityResponse) => listeners.forEach((l) => l(response));
  const endpoint = new AuthorityEndpoint(post);
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => void | Promise<void>) => {
    queue = queue.then(task);
  };
  let consumer: IngestPortConsumer | null = null;

  const transport: AuthorityTransport & {
    emitResponse: (response: AuthorityResponse) => void;
    attachedPort: FakePort | null;
  } = {
    attachedPort: null,
    send(request: AuthorityRequest) {
      if (request.type === "activate-port-ingest") {
        enqueue(() => consumer?.activate());
        return;
      }
      enqueue(() => endpoint.handle(request));
    },
    onResponse(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachIngestPort(port: MessagePort) {
      const fake = port as unknown as FakePort;
      transport.attachedPort = fake;
      consumer = new IngestPortConsumer({
        write: (data, onParsed) => endpoint.ingestWrite(data, onParsed),
        postAck: (ack) => fake.postMessage(ack),
        postResponse: post,
        enqueue,
      });
      fake.handler = (msg) => consumer?.handlePortMessage(msg);
    },
    dispose() {
      enqueue(() => endpoint.handle({ type: "dispose" }));
      listeners.clear();
    },
    emitResponse(response: AuthorityResponse) {
      post(response);
    },
  };
  return transport;
}

// The pty-host's routing decision, reduced to its essence: engaged terminals
// get port delivery, everything else takes the window path; engage answers
// with the marker AFTER pre-flip bytes were delivered (window FIFO), release
// posts the sentinel AFTER the last port byte (dedicated FIFO).
function makeLiveHarness(options: { auto?: boolean; markerEnabled?: boolean } = {}) {
  const auto = options.auto ?? true;
  const markerEnabled = options.markerEnabled ?? true;
  const mirror = makeMirror();
  const transport = createFakeWorkerTransport();
  const port = new FakePort();

  const host = {
    engaged: false,
    engageRequested: false,
    lastDrainId: null as number | null,
    engage(): void {
      this.engaged = true;
      if (markerEnabled) ingest.handleEngaged();
    },
    release(drainId: number): void {
      this.engaged = false;
      port.hostPost({ type: "ingest-detached", drainId });
    },
    write(data: string): void {
      if (this.engaged) {
        port.hostPost({ type: "data", id: "t1", data, bytes: data.length });
        return;
      }
      // Window path = the service's onData branch.
      if (ingest.shouldDivert()) {
        ingest.feedDiverted(data);
      } else {
        mirror.terminal.write(data);
      }
    },
  };

  const deps: LiveWorkerIngestDeps = {
    id: "t1",
    requestPort: async () => port as unknown as MessagePort,
    releasePort: vi.fn(),
    sendEngage: () => {
      host.engageRequested = true;
      if (auto) queueMicrotask(() => host.engage());
      return true;
    },
    sendRelease: (drainId) => {
      host.lastDrainId = drainId;
      if (auto) queueMicrotask(() => host.release(drainId));
      return true;
    },
    createTransport: () => transport,
    mirror: { write: (data, cb) => mirror.terminal.write(data, cb) },
    serializeMirror: () => mirror.serializeAddon.serialize(),
    getGeometry: () => ({ cols: 80, rows: 24, scrollback: 1000 }),
    drainPendingWrites: async () => true,
    ackDiverted: vi.fn(),
    requestHostRestore: vi.fn(),
    onDidFallback: vi.fn(),
    barrierTimeoutMs: 1000,
    cadenceMs: 0,
  };
  const ingest = new LiveWorkerIngest(deps);

  return { mirror, transport, port, host, ingest, deps };
}

describe("LiveWorkerIngest", () => {
  it("engage is zero-loss and order-preserving across the routing flip", async () => {
    const h = makeLiveHarness({ auto: false });

    h.host.write("W0-normal\r\n");
    await drain(h.mirror.terminal);

    h.ingest.setDesired(true);
    // Controller has seeded the session and asked the host to flip routing.
    await until(() => h.host.engageRequested, "engage requested");
    // Pre-flip byte: window path → diverted → relayed on the control FIFO.
    h.host.write("W1-preflip\r\n");
    // Host flips and posts the marker; the very next byte races ahead on the
    // dedicated port — the worker must HOLD it until activate.
    h.host.engage();
    h.host.write("P1-port\r\n");
    await until(() => h.ingest.isWorkerActive(), "worker mode");
    h.host.write("P2-port\r\n");

    // Promote back to materialize the authority's canonical order.
    h.ingest.setDesired(false);
    await until(() => h.host.lastDrainId !== null, "release requested");
    h.host.release(h.host.lastDrainId!);
    await until(() => !h.ingest.shouldDivert(), "release");
    await drain(h.mirror.terminal);

    expectOnceInOrder(bufferText(h.mirror.terminal), [
      "W0-normal",
      "W1-preflip",
      "P1-port",
      "P2-port",
    ]);
    expect(h.ingest.hasFallenBack()).toBe(false);
  });

  it("release is zero-loss: port stragglers land before post-flip window bytes", async () => {
    const h = makeLiveHarness({ auto: false });
    h.ingest.setDesired(true);
    await until(() => h.host.engageRequested, "engage requested");
    h.host.engage();
    await until(() => h.ingest.isWorkerActive(), "worker mode");

    h.host.write("P1\r\n");
    h.host.write("P2\r\n");

    h.ingest.setDesired(false);
    // Stragglers already routed to the port before the host processes release.
    h.host.write("P3-straggler\r\n");
    await until(() => h.host.lastDrainId !== null, "release requested");
    h.host.release(h.host.lastDrainId!);
    // Post-flip bytes take the window path mid-release → buffered, replayed
    // after the promotion snapshot.
    h.host.write("W1-postflip\r\n");

    await until(() => !h.ingest.shouldDivert(), "release");
    await drain(h.mirror.terminal);

    expectOnceInOrder(bufferText(h.mirror.terminal), ["P1", "P2", "P3-straggler", "W1-postflip"]);
    // Every port chunk was acked back on the dedicated port.
    expect(h.port.acks.filter((a) => a.id === "t1")).toHaveLength(3);
    expect(h.ingest.hasFallenBack()).toBe(false);
  });

  it("survives repeated engage/release cycles with content exactly once, in order", async () => {
    const h = makeLiveHarness();
    const markers: string[] = [];
    const phase = async (marker: string, worker: boolean) => {
      markers.push(marker);
      h.ingest.setDesired(worker);
      if (worker) await until(() => h.ingest.isWorkerActive(), `worker for ${marker}`);
      else await until(() => !h.ingest.shouldDivert(), `passthrough for ${marker}`);
      h.host.write(`${marker}\r\n`);
    };

    await phase("CYCLE1-worker", true);
    await phase("CYCLE1-normal", false);
    await phase("CYCLE2-worker", true);
    await phase("CYCLE2-normal", false);

    await drain(h.mirror.terminal);
    expectOnceInOrder(bufferText(h.mirror.terminal), markers);
    expect(h.ingest.hasFallenBack()).toBe(false);
  });

  it("falls back on a requestId-less worker error: releases the port, restores from host, stops diverting", async () => {
    const h = makeLiveHarness();
    h.ingest.setDesired(true);
    await until(() => h.ingest.isWorkerActive(), "worker mode");

    h.transport.emitResponse({ type: "error", message: "worker exploded" });
    await until(() => h.ingest.hasFallenBack(), "fallback");

    expect(h.deps.releasePort).toHaveBeenCalled();
    expect(h.deps.requestHostRestore).toHaveBeenCalled();
    expect(h.deps.onDidFallback).toHaveBeenCalledWith(expect.stringContaining("worker exploded"));
    expect(h.ingest.shouldDivert()).toBe(false);
    // Latched: further tier flips never re-engage.
    h.ingest.setDesired(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.ingest.isWorkerActive()).toBe(false);
  });

  it("falls back when the dedicated port closes under the worker", async () => {
    const h = makeLiveHarness();
    h.ingest.setDesired(true);
    await until(() => h.ingest.isWorkerActive(), "worker mode");

    h.transport.emitResponse({ type: "ingest-port-closed" });
    await until(() => h.ingest.hasFallenBack(), "fallback");
    expect(h.deps.requestHostRestore).toHaveBeenCalled();
    expect(h.ingest.shouldDivert()).toBe(false);
  });

  it("falls back when the engage marker never arrives", async () => {
    const h = makeLiveHarness({ markerEnabled: false });
    // Tight timeout so the test stays fast.
    (h.deps as { barrierTimeoutMs?: number }).barrierTimeoutMs = 30;
    const ingest = new LiveWorkerIngest(h.deps);
    ingest.setDesired(true);
    await until(() => ingest.hasFallenBack(), "fallback");
    expect(h.deps.requestHostRestore).toHaveBeenCalled();
    expect(ingest.isWorkerActive()).toBe(false);
    ingest.dispose();
  });

  it("dispose mid-engage releases the port and ignores late arrivals", async () => {
    const h = makeLiveHarness({ auto: false });
    h.ingest.setDesired(true);
    await until(() => h.ingest.shouldDivert(), "diversion");
    h.ingest.dispose();

    expect(h.deps.releasePort).toHaveBeenCalled();
    // Late marker and port bytes are no-ops on a disposed controller.
    h.host.engage();
    h.port.hostPost({ type: "data", id: "t1", data: "late\r\n", bytes: 6 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.ingest.isWorkerActive()).toBe(false);
    expect(h.ingest.shouldDivert()).toBe(false);
  });

  it("rapid tier flapping converges without loss or duplication", async () => {
    const h = makeLiveHarness();
    h.host.write("BASE\r\n");
    await drain(h.mirror.terminal);

    h.ingest.setDesired(true);
    h.ingest.setDesired(false);
    h.ingest.setDesired(true);
    await until(() => h.ingest.isWorkerActive(), "worker mode after flap");
    h.host.write("AFTER-FLAP\r\n");

    h.ingest.setDesired(false);
    await until(() => !h.ingest.shouldDivert(), "release");
    await drain(h.mirror.terminal);

    expectOnceInOrder(bufferText(h.mirror.terminal), ["BASE", "AFTER-FLAP"]);
    expect(h.ingest.hasFallenBack()).toBe(false);
  });
});
