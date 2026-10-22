import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

import { TerminalLinkMatchClient, type TerminalLinkWorker } from "../terminalLinkMatchClient";
import type {
  TerminalLinkMatchMessage,
  TerminalLinkMatchRequest,
  TerminalLinkPatternSpec,
} from "../terminalLinkMatchWork";

/** A worker the test answers by hand. */
class FakeWorker implements TerminalLinkWorker {
  onmessage: ((event: { data: TerminalLinkMatchMessage }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly requests: TerminalLinkMatchRequest[] = [];
  terminated = false;

  postMessage(request: TerminalLinkMatchRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(message: TerminalLinkMatchMessage): void {
    this.onmessage?.({ data: message });
  }
}

const SPEC_A: TerminalLinkPatternSpec = { key: "a", pattern: "A-\\d", ignoreCase: false };
const SPEC_B: TerminalLinkPatternSpec = { key: "b", pattern: "B-\\d", ignoreCase: false };

function setup() {
  const workers: FakeWorker[] = [];
  const client = new TerminalLinkMatchClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { client, workers };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TerminalLinkMatchClient", () => {
  it("resolves a request with the worker's matches", async () => {
    const { client, workers } = setup();
    const result = client.match("A-1", [SPEC_A]);
    const [worker] = workers;
    const id = worker!.requests[0]!.id;
    worker!.reply({ id, type: "start", key: "a" });
    worker!.reply({
      id,
      type: "done",
      matches: { a: [{ index: 0, text: "A-1", groups: [] }] },
      slowKeys: [],
    });
    await expect(result).resolves.toEqual({ a: [{ index: 0, text: "A-1", groups: [] }] });
  });

  it("terminates a worker stuck in one pattern and never runs that pattern again", async () => {
    const { client, workers } = setup();
    const stuck = client.match("A-1 B-2", [SPEC_A, SPEC_B]);
    const first = workers[0]!;
    first.reply({ id: first.requests[0]!.id, type: "start", key: "b" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stuck).resolves.toBeNull();
    expect(first.terminated).toBe(true);
    expect(client.isSlow("b")).toBe(true);

    void client.match("A-1 B-2", [SPEC_A, SPEC_B]);
    expect(workers[1]!.requests[0]!.matchers.map((m) => m.key)).toEqual(["a"]);
  });

  it("switches off a pattern the worker reports as slow", async () => {
    const { client, workers } = setup();
    const result = client.match("A-1", [SPEC_A]);
    const worker = workers[0]!;
    worker.reply({ id: worker.requests[0]!.id, type: "done", matches: {}, slowKeys: ["a"] });
    await result;
    await expect(client.match("A-1", [SPEC_A])).resolves.toEqual({});
    expect(worker.requests).toHaveLength(1);
  });

  it("keeps one request in flight and lets the newest waiting one replace older ones", async () => {
    const { client, workers } = setup();
    const first = client.match("one", [SPEC_A]);
    const dropped = client.match("two", [SPEC_A]);
    const latest = client.match("three", [SPEC_A]);
    await expect(dropped).resolves.toBeNull();

    const worker = workers[0]!;
    expect(worker.requests.map((r) => r.text)).toEqual(["one"]);
    worker.reply({ id: worker.requests[0]!.id, type: "done", matches: {}, slowKeys: [] });
    await expect(first).resolves.toEqual({});
    expect(worker.requests.map((r) => r.text)).toEqual(["one", "three"]);
    worker.reply({ id: worker.requests[1]!.id, type: "done", matches: {}, slowKeys: [] });
    await expect(latest).resolves.toEqual({});
  });

  it("fails closed when the worker can't run", async () => {
    const client = new TerminalLinkMatchClient(() => {
      throw new Error("no workers here");
    });
    await expect(client.match("A-1", [SPEC_A])).resolves.toBeNull();

    const { client: errored, workers } = setup();
    const pending = errored.match("A-1", [SPEC_A]);
    workers[0]!.onerror?.(new Event("error"));
    await expect(pending).resolves.toBeNull();
    await expect(errored.match("A-1", [SPEC_A])).resolves.toBeNull();
    expect(workers).toHaveLength(1);
  });

  it("ignores a stale reply for a request it already gave up on", async () => {
    const { client, workers } = setup();
    const stuck = client.match("A-1", [SPEC_A]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(stuck).resolves.toBeNull();
    const old = workers[0]!;
    // No pattern had started, so nothing is blamed.
    expect(client.isSlow("a")).toBe(false);
    old.reply({ id: old.requests[0]!.id, type: "done", matches: {}, slowKeys: ["a"] });
    expect(client.isSlow("a")).toBe(false);
  });
});
