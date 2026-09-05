import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  DiffTokenizeRequest,
  DiffTokenizeResult,
  DiffTokenizeWorkerRequest,
  DiffTokenizeWorkerResponse,
} from "@/components/Worktree/diffTokenizer";
import { DiffTokenizeClient } from "../DiffTokenizeService";

const { mockRunDiffTokenize, mockMarkLanguageFailed } = vi.hoisted(() => ({
  mockRunDiffTokenize: vi.fn(),
  mockMarkLanguageFailed: vi.fn(),
}));

vi.mock("@/components/Worktree/diffTokenizer", () => ({
  runDiffTokenize: mockRunDiffTokenize,
}));

vi.mock("@/components/Worktree/diffRefractor", () => ({
  markLanguageFailed: mockMarkLanguageFailed,
}));

class MockWorker {
  posted: DiffTokenizeWorkerRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<DiffTokenizeWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  postMessage(message: DiffTokenizeWorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: DiffTokenizeWorkerResponse): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal MessageEvent shape for the handler under test
    this.onmessage?.({ data: response } as MessageEvent<DiffTokenizeWorkerResponse>);
  }

  fail(message: string): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal ErrorEvent shape for the handler under test
    this.onerror?.({ message } as ErrorEvent);
  }
}

function makeRequest(language = "typescript"): DiffTokenizeRequest {
  return {
    hunks: [
      {
        content: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        newStart: 1,
        oldLines: 1,
        newLines: 1,
        changes: [{ type: "insert", content: "added", lineNumber: 1 }],
      },
    ],
    language,
    highlight: true,
    extraRanges: null,
  };
}

const tokensA: DiffTokenizeResult = { tokens: { old: [], new: [] }, langLoadFailed: false };

function createClient(): { client: DiffTokenizeClient; worker: MockWorker; factory: () => Worker } {
  const worker = new MockWorker();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MockWorker implements the Worker surface the client uses
  const factory = vi.fn(() => worker as unknown as Worker);
  return { client: new DiffTokenizeClient(factory), worker, factory };
}

function createReplacingClient(): {
  client: DiffTokenizeClient;
  workers: MockWorker[];
  factory: () => Worker;
} {
  const workers: MockWorker[] = [];
  const factory = vi.fn(() => {
    const worker = new MockWorker();
    workers.push(worker);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- MockWorker implements the Worker surface the client uses
    return worker as unknown as Worker;
  });
  return { client: new DiffTokenizeClient(factory), workers, factory };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DiffTokenizeClient worker path", () => {
  it("resolves tokens from the worker response", async () => {
    const { client, worker } = createClient();
    const promise = client.tokenize("viewer-1", makeRequest());

    expect(worker.posted).toHaveLength(1);
    worker.respond({ id: worker.posted[0]!.id, ok: true, ...tokensA });

    await expect(promise).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();
  });

  it("holds a superseded request off the worker and posts only the latest", async () => {
    const { client, worker } = createClient();
    const first = client.tokenize("viewer-1", makeRequest());
    const second = client.tokenize("viewer-1", makeRequest());

    await expect(first).resolves.toBeNull();
    // The key already had a job in flight, so the second never reached the
    // worker at all. Before admission control both were posted and the worker
    // ran the obsolete one ahead of the one the user is waiting for.
    expect(worker.posted).toHaveLength(1);

    worker.respond({ id: worker.posted[0]!.id, ok: true, tokens: null, langLoadFailed: true });

    // The in-flight job's result is discarded, side effects included: its
    // caller was settled null the moment it was superseded.
    expect(mockMarkLanguageFailed).not.toHaveBeenCalled();

    // Releasing the slot is what posts the request held behind it.
    expect(worker.posted).toHaveLength(2);
    worker.respond({ id: worker.posted[1]!.id, ok: true, ...tokensA });
    await expect(second).resolves.toEqual(tokensA);
  });

  it("posts two messages for a burst of ten requests under one key", async () => {
    const { client, worker } = createClient();
    const burst = Array.from({ length: 10 }, () => client.tokenize("viewer-1", makeRequest()));

    // One in flight; the other nine collapse into a single held slot.
    expect(worker.posted).toHaveLength(1);
    await expect(Promise.all(burst.slice(0, 9))).resolves.toEqual(Array(9).fill(null));

    worker.respond({ id: worker.posted[0]!.id, ok: true, ...tokensA });

    expect(worker.posted).toHaveLength(2);
    // The survivor is the NEWEST request, not the second one issued — the held
    // slot holds one request and every arrival replaces it.
    expect(worker.posted[1]!.id).toBe(worker.posted[0]!.id + 9);

    worker.respond({ id: worker.posted[1]!.id, ok: true, ...tokensA });
    await expect(burst[9]!).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();
  });

  it("ignores an error from a superseded job instead of failing over", async () => {
    const { client, worker, factory } = createClient();
    const first = client.tokenize("viewer-1", makeRequest());
    const second = client.tokenize("viewer-1", makeRequest());
    await expect(first).resolves.toBeNull();

    worker.respond({ id: worker.posted[0]!.id, ok: false, error: "tokenize blew up" });

    // The superseded entry survives in `pending` only to release the key's
    // slot, so its error has to stay as ignored as its tokens are. Treating it
    // as evidence the environment is broken would cost the session its worker
    // over a request nobody is waiting for.
    expect(worker.terminated).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.posted).toHaveLength(2);

    worker.respond({ id: worker.posted[1]!.id, ok: true, ...tokensA });
    await expect(second).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();
  });

  it("keeps requests under different keys independent", async () => {
    const { client, worker } = createClient();
    const first = client.tokenize("viewer-1", makeRequest());
    const second = client.tokenize("viewer-2", makeRequest());

    worker.respond({ id: worker.posted[0]!.id, ok: true, ...tokensA });
    worker.respond({ id: worker.posted[1]!.id, ok: true, ...tokensA });

    await expect(first).resolves.toEqual(tokensA);
    await expect(second).resolves.toEqual(tokensA);
  });

  it("mirrors worker-side grammar failures into the renderer registry", async () => {
    const { client, worker } = createClient();
    const promise = client.tokenize("viewer-1", makeRequest("rust"));

    worker.respond({ id: worker.posted[0]!.id, ok: true, tokens: null, langLoadFailed: true });

    await expect(promise).resolves.toEqual({ tokens: null, langLoadFailed: true });
    expect(mockMarkLanguageFailed).toHaveBeenCalledWith("rust");
  });
});

describe("DiffTokenizeClient fallback", () => {
  it("falls back in-thread when worker construction throws", async () => {
    const factory = vi.fn(() => {
      throw new Error("Worker is not defined");
    });
    const client = new DiffTokenizeClient(factory);
    mockRunDiffTokenize.mockResolvedValue(tokensA);

    await expect(client.tokenize("viewer-1", makeRequest())).resolves.toEqual(tokensA);
    await expect(client.tokenize("viewer-1", makeRequest())).resolves.toEqual(tokensA);

    // Fallback is permanent for the session: one construction attempt, one warning.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(2);
  });

  it("fails over pending requests in-thread when a request errors", async () => {
    const { client, worker, factory } = createClient();
    mockRunDiffTokenize.mockResolvedValue(tokensA);
    const pending = client.tokenize("viewer-1", makeRequest());

    worker.respond({ id: worker.posted[0]!.id, ok: false, error: "tokenize blew up" });

    await expect(pending).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(1);
    expect(worker.terminated).toBe(true);

    // Subsequent requests skip the worker entirely.
    await expect(client.tokenize("viewer-1", makeRequest())).resolves.toEqual(tokensA);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.posted).toHaveLength(1);
  });

  it("fails over pending requests when the worker itself errors", async () => {
    const { client, worker } = createClient();
    mockRunDiffTokenize.mockResolvedValue(tokensA);
    const pending = client.tokenize("viewer-1", makeRequest());

    worker.fail("worker crashed");

    await expect(pending).resolves.toEqual(tokensA);
    expect(worker.terminated).toBe(true);
  });

  it("discards superseded in-thread requests without running them", async () => {
    const factory = vi.fn(() => {
      throw new Error("Worker is not defined");
    });
    const client = new DiffTokenizeClient(factory);
    mockRunDiffTokenize.mockResolvedValue(tokensA);

    const first = client.tokenize("viewer-1", makeRequest());
    const second = client.tokenize("viewer-1", makeRequest());

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual(tokensA);
    // The superseded request is skipped at the queue's supersession recheck —
    // only the surviving (latest) request actually tokenizes.
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(1);
  });

  it("routes a mid-drain tokenize through the shared queue, behind survivors", async () => {
    vi.useFakeTimers();
    const { client, worker } = createClient();
    const order: string[] = [];
    mockRunDiffTokenize.mockImplementation(async (req: DiffTokenizeRequest) => {
      order.push(req.language);
      return tokensA;
    });

    const survivorA = client.tokenize("viewer-a", makeRequest("lang-a"));
    const survivorB = client.tokenize("viewer-b", makeRequest("lang-b"));

    worker.fail("worker crashed"); // both enqueued as survivors

    // A NEW request arrives after failover, now in fallback mode. It must be
    // appended behind the queued survivors, not run ahead of them.
    const late = client.tokenize("viewer-c", makeRequest("lang-c"));

    await vi.runAllTimersAsync();

    await expect(survivorA).resolves.toEqual(tokensA);
    await expect(survivorB).resolves.toEqual(tokensA);
    await expect(late).resolves.toEqual(tokensA);
    expect(order).toEqual(["lang-a", "lang-b", "lang-c"]);
  });

  it("supersedes a queued survivor with a same-key mid-drain request, no double run", async () => {
    vi.useFakeTimers();
    const { client, worker } = createClient();
    const order: string[] = [];
    mockRunDiffTokenize.mockImplementation(async (req: DiffTokenizeRequest) => {
      order.push(req.language);
      return tokensA;
    });

    const survivor = client.tokenize("viewer-a", makeRequest("survivor"));

    worker.fail("worker crashed"); // survivor enqueued

    // Same-key request after failover supersedes the queued survivor.
    const replacement = client.tokenize("viewer-a", makeRequest("replacement"));

    await vi.runAllTimersAsync();

    // The superseded survivor resolves null and never runs; only the
    // replacement tokenizes — no same-key double run.
    await expect(survivor).resolves.toBeNull();
    await expect(replacement).resolves.toEqual(tokensA);
    expect(order).toEqual(["replacement"]);
  });

  it("moves a held request in-thread when the worker dies", async () => {
    vi.useFakeTimers();
    const { client, worker } = createClient();
    mockRunDiffTokenize.mockResolvedValue(tokensA);

    const superseded = client.tokenize("viewer-a", makeRequest("stale"));
    const held = client.tokenize("viewer-a", makeRequest("held"));

    worker.fail("worker crashed");
    await vi.runAllTimersAsync();

    await expect(superseded).resolves.toBeNull();
    // A held request carries no `pending` row, so a failover sweep that walked
    // only `pending` would leave this promise unsettled for the whole session.
    await expect(held).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(1);
  });

  it("re-runs only newest-per-key requests sequentially on failover", async () => {
    vi.useFakeTimers();
    const { client, worker } = createClient();
    let resolveFirst: (result: DiffTokenizeResult) => void = () => undefined;
    mockRunDiffTokenize
      .mockImplementationOnce(
        () =>
          new Promise<DiffTokenizeResult>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(tokensA);

    const staleA = client.tokenize("viewer-a", makeRequest());
    const latestA = client.tokenize("viewer-a", makeRequest());
    const latestB = client.tokenize("viewer-b", makeRequest());

    worker.fail("worker crashed");

    // Superseded request resolves null without an in-thread re-run; survivors
    // have not started yet — the drain yields to a macrotask first.
    await expect(staleA).resolves.toBeNull();
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(1);

    // The second survivor waits for the first to finish plus another yield.
    resolveFirst(tokensA);
    await vi.runAllTimersAsync();
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(2);

    await expect(latestA).resolves.toEqual(tokensA);
    await expect(latestB).resolves.toEqual(tokensA);
  });
});

describe("DiffTokenizeClient timeout", () => {
  it("resolves a wedged request null, replaces the worker, and never re-runs the input", async () => {
    vi.useFakeTimers();
    const { client, workers } = createReplacingClient();
    const wedged = client.tokenize("viewer-1", makeRequest());
    expect(workers).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(wedged).resolves.toBeNull();
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();

    // The replacement serves subsequent requests normally.
    const next = client.tokenize("viewer-1", makeRequest());
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.respond({ id: workers[1]!.posted[0]!.id, ok: true, ...tokensA });
    await expect(next).resolves.toEqual(tokensA);
  });

  it("re-posts other pending requests to the replacement worker", async () => {
    vi.useFakeTimers();
    const { client, workers } = createReplacingClient();
    const wedged = client.tokenize("viewer-a", makeRequest());
    const queued = client.tokenize("viewer-b", makeRequest());

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(wedged).resolves.toBeNull();
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toHaveLength(1);

    workers[1]!.respond({ id: workers[1]!.posted[0]!.id, ok: true, ...tokensA });
    await expect(queued).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();
  });

  it("starts no timeout for a request it never posted", async () => {
    vi.useFakeTimers();
    const { client, workers } = createReplacingClient();
    const wedged = client.tokenize("viewer-1", makeRequest());
    const held = client.tokenize("viewer-1", makeRequest());
    await expect(wedged).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);

    // One watchdog fired, not two: a request that was never posted cannot have
    // wedged anything, so it spends none of the replacement budget.
    expect(workers).toHaveLength(2);
    // It goes to the replacement, and only now does its own timeout start.
    expect(workers[1]!.posted).toHaveLength(1);

    workers[1]!.respond({ id: workers[1]!.posted[0]!.id, ok: true, ...tokensA });
    await expect(held).resolves.toEqual(tokensA);
    expect(mockRunDiffTokenize).not.toHaveBeenCalled();
  });

  it("falls back permanently once the replacement budget is exhausted", async () => {
    vi.useFakeTimers();
    const { client, workers, factory } = createReplacingClient();

    const first = client.tokenize("viewer-1", makeRequest());
    await vi.advanceTimersByTimeAsync(30_000);
    const second = client.tokenize("viewer-1", makeRequest());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(workers).toHaveLength(3);

    const third = client.tokenize("viewer-1", makeRequest());
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    await expect(third).resolves.toBeNull();
    expect(workers[2]!.terminated).toBe(true);

    // No further replacements: requests run in-thread (through the shared
    // queue, which yields before running) from here on.
    mockRunDiffTokenize.mockResolvedValue(tokensA);
    const fourth = client.tokenize("viewer-1", makeRequest());
    await vi.runAllTimersAsync();
    await expect(fourth).resolves.toEqual(tokensA);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(mockRunDiffTokenize).toHaveBeenCalledTimes(1);
  });
});
