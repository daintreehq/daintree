import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarkdownDiffResult, ReconstructInput } from "@/components/Worktree/markdownBlockDiff";
import type {
  MarkdownDiffWorkerRequest,
  MarkdownDiffWorkerResponse,
} from "../markdownDiffProtocol";
import { MarkdownDiffClient } from "../MarkdownDiffService";

const { mockBuildMarkdownDiff } = vi.hoisted(() => ({ mockBuildMarkdownDiff: vi.fn() }));

vi.mock("@/components/Worktree/markdownBlockDiff", () => ({
  buildMarkdownDiff: mockBuildMarkdownDiff,
}));

class MockWorker {
  posted: MarkdownDiffWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<MarkdownDiffWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  postMessage(message: MarkdownDiffWorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: MarkdownDiffWorkerResponse): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal MessageEvent shape for the handler under test
    this.onmessage?.({ data: response } as MessageEvent<MarkdownDiffWorkerResponse>);
  }

  answer(id: number, result: MarkdownDiffResult): void {
    this.respond({ id, ok: true, result });
  }

  fail(message: string): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal ErrorEvent shape for the handler under test
    this.onerror?.({ message } as ErrorEvent);
  }
}

function input(marker: string): ReconstructInput {
  return { diff: `diff ${marker}`, newSource: `source ${marker}`, status: "modified" };
}

function resultFor(marker: string): MarkdownDiffResult {
  return {
    ok: true,
    model: {
      changes: [
        {
          kind: "added",
          block: {
            type: "paragraph",
            source: marker,
            text: marker,
            referenceIds: [],
            segments: [],
          },
        },
      ],
      oldDefinitions: "",
      newDefinitions: "",
      identical: false,
    },
  };
}

/** A client whose factory hands out a fresh MockWorker per call. */
function createClient(): { client: MarkdownDiffClient; workers: MockWorker[] } {
  const workers: MockWorker[] = [];
  const factory = vi.fn(() => {
    const worker = new MockWorker();
    workers.push(worker);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MockWorker implements the Worker surface the client uses
    return worker as unknown as Worker;
  });
  return { client: new MarkdownDiffClient(factory), workers };
}

/**
 * Lets the in-thread queue's macrotask yields run. One millisecond per step, not
 * zero: the fake clock files a zero-delay timer queued at the end of a tick a
 * millisecond out, so advancing by zero runs one job and strands the rest.
 */
async function drainInThread(): Promise<void> {
  for (let step = 0; step < 4; step++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  mockBuildMarkdownDiff.mockReset();
  mockBuildMarkdownDiff.mockImplementation((request: ReconstructInput) =>
    resultFor(`in-thread ${request.diff}`)
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MarkdownDiffClient", () => {
  it("builds on the worker and resolves exactly what the worker returned", async () => {
    const { client, workers } = createClient();
    const promise = client.build("pane", input("a"));

    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([{ id: 1, input: input("a") }]);
    workers[0]!.answer(1, resultFor("a"));

    await expect(promise).resolves.toEqual(resultFor("a"));
    expect(mockBuildMarkdownDiff).not.toHaveBeenCalled();
  });

  it("delivers an engine refusal as a verdict, not a failure", async () => {
    const { client, workers } = createClient();
    const promise = client.build("pane", input("a"));

    workers[0]!.answer(1, { ok: false, reason: "too-large" });

    await expect(promise).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(mockBuildMarkdownDiff).not.toHaveBeenCalled();
  });

  it("supersedes a same-key build in flight and holds the newer one until the slot frees", async () => {
    const { client, workers } = createClient();
    const first = client.build("pane", input("a"));
    const second = client.build("pane", input("b"));

    await expect(first).resolves.toBeNull();
    // Not posted yet: the worker is still busy with the first one.
    expect(workers[0]!.posted.map((message) => message.id)).toEqual([1]);

    workers[0]!.answer(1, resultFor("a"));
    expect(workers[0]!.posted.map((message) => message.id)).toEqual([1, 2]);
    workers[0]!.answer(2, resultFor("b"));

    await expect(second).resolves.toEqual(resultFor("b"));
  });

  it("never posts the requests a burst passed over", async () => {
    const { client, workers } = createClient();
    const first = client.build("pane", input("a"));
    const skipped = client.build("pane", input("b"));
    const last = client.build("pane", input("c"));

    await expect(skipped).resolves.toBeNull();
    workers[0]!.answer(1, resultFor("a"));
    await expect(first).resolves.toBeNull();

    expect(workers[0]!.posted.map((message) => message.input.diff)).toEqual(["diff a", "diff c"]);
    workers[0]!.answer(3, resultFor("c"));
    await expect(last).resolves.toEqual(resultFor("c"));
  });

  it("keeps different keys independent", async () => {
    const { client, workers } = createClient();
    const left = client.build("left", input("a"));
    const right = client.build("right", input("b"));

    expect(workers[0]!.posted.map((message) => message.id)).toEqual([1, 2]);
    workers[0]!.answer(2, resultFor("b"));
    workers[0]!.answer(1, resultFor("a"));

    await expect(left).resolves.toEqual(resultFor("a"));
    await expect(right).resolves.toEqual(resultFor("b"));
  });

  it("drops an aborted held request without ever posting it", async () => {
    const { client, workers } = createClient();
    const first = client.build("pane", input("a"));
    const controller = new AbortController();
    const held = client.build("pane", input("b"), controller.signal);

    controller.abort();
    await expect(held).resolves.toBeNull();
    workers[0]!.answer(1, resultFor("a"));

    await expect(first).resolves.toBeNull();
    expect(workers[0]!.posted.map((message) => message.id)).toEqual([1]);
  });

  it("settles an aborted posted request null and still frees its slot when the worker answers", async () => {
    const { client, workers } = createClient();
    const controller = new AbortController();
    const posted = client.build("pane", input("a"), controller.signal);

    controller.abort();
    await expect(posted).resolves.toBeNull();

    const next = client.build("pane", input("b"));
    expect(workers[0]!.posted.map((message) => message.id)).toEqual([1]);
    workers[0]!.answer(1, resultFor("a"));
    expect(workers[0]!.posted.map((message) => message.id)).toEqual([1, 2]);
    workers[0]!.answer(2, resultFor("b"));

    await expect(next).resolves.toEqual(resultFor("b"));
  });

  it("ignores an abort after its request has already been answered", async () => {
    const { client, workers } = createClient();
    const controller = new AbortController();
    const promise = client.build("pane", input("a"), controller.signal);

    workers[0]!.answer(1, resultFor("a"));
    controller.abort();

    await expect(promise).resolves.toEqual(resultFor("a"));
  });

  it("builds in-thread when the worker can't be constructed", async () => {
    const client = new MarkdownDiffClient(() => {
      throw new Error("no workers here");
    });
    const promise = client.build("pane", input("a"));

    await drainInThread();

    await expect(promise).resolves.toEqual(resultFor("in-thread diff a"));
    expect(mockBuildMarkdownDiff).toHaveBeenCalledWith(input("a"));
  });

  it("moves current requests in-thread when the worker crashes, and skips superseded ones", async () => {
    const { client, workers } = createClient();
    const stale = client.build("pane", input("a"));
    const current = client.build("pane", input("b"));
    const other = client.build("other", input("c"));

    workers[0]!.fail("boom");
    await drainInThread();

    await expect(stale).resolves.toBeNull();
    await expect(current).resolves.toEqual(resultFor("in-thread diff b"));
    await expect(other).resolves.toEqual(resultFor("in-thread diff c"));
    // The superseded "a" never runs. Posted work queues ahead of held work.
    expect(mockBuildMarkdownDiff.mock.calls.map(([request]) => request)).toEqual([
      input("c"),
      input("b"),
    ]);
    expect(workers[0]!.terminated).toBe(true);
  });

  it("falls back in-thread on an engine-error response and rejects when the engine throws there too", async () => {
    const { client, workers } = createClient();
    mockBuildMarkdownDiff.mockImplementation(() => {
      throw new Error("engine exploded");
    });
    const promise = client.build("pane", input("a"));
    const assertion = expect(promise).rejects.toThrow("engine exploded");

    workers[0]!.respond({ id: 1, ok: false, error: "engine exploded" });
    await drainInThread();

    await assertion;
  });

  it("drops an in-thread job a newer same-key request replaced before it ran", async () => {
    const client = new MarkdownDiffClient(() => {
      throw new Error("no workers here");
    });
    const first = client.build("pane", input("a"));
    const second = client.build("pane", input("b"));

    await drainInThread();

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual(resultFor("in-thread diff b"));
    expect(mockBuildMarkdownDiff).toHaveBeenCalledTimes(1);
  });

  it("replaces a wedged worker and re-posts the current request with its promise intact", async () => {
    const { client, workers } = createClient();
    const promise = client.build("pane", input("a"));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([{ id: 1, input: input("a") }]);

    // A late answer from the terminated worker is not the replacement's.
    workers[0]!.answer(1, resultFor("stale"));
    workers[1]!.answer(1, resultFor("a"));

    await expect(promise).resolves.toEqual(resultFor("a"));
    expect(mockBuildMarkdownDiff).not.toHaveBeenCalled();
  });

  it("drops a superseded job on replacement and posts the request held behind it", async () => {
    const { client, workers } = createClient();
    void client.build("pane", input("a"));
    const held = client.build("pane", input("b"));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(workers[1]!.posted.map((message) => message.input.diff)).toEqual(["diff b"]);
    workers[1]!.answer(2, resultFor("b"));
    await expect(held).resolves.toEqual(resultFor("b"));
  });

  it("builds in-thread once the replacement budget is spent", async () => {
    const { client, workers } = createClient();
    const promise = client.build("pane", input("a"));

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(workers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_000);
    await drainInThread();

    await expect(promise).resolves.toEqual(resultFor("in-thread diff a"));
    expect(workers.every((worker) => worker.terminated)).toBe(true);

    // Permanent for the session: later requests never reach a worker.
    const later = client.build("pane", input("b"));
    await drainInThread();
    await expect(later).resolves.toEqual(resultFor("in-thread diff b"));
    expect(workers).toHaveLength(3);
  });

  it("settles everything outstanding null on dispose", async () => {
    const { client, workers } = createClient();
    const posted = client.build("pane", input("a"));
    const held = client.build("pane", input("b"));
    const other = client.build("other", input("c"));

    client.dispose();

    await expect(posted).resolves.toBeNull();
    await expect(held).resolves.toBeNull();
    await expect(other).resolves.toBeNull();
    expect(workers[0]!.terminated).toBe(true);
  });
});
