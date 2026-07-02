import { describe, expect, it, vi, beforeEach } from "vitest";
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  it("discards a superseded request and keeps the latest for the same key", async () => {
    const { client, worker } = createClient();
    const first = client.tokenize("viewer-1", makeRequest());
    const second = client.tokenize("viewer-1", makeRequest());

    await expect(first).resolves.toBeNull();

    const [firstMessage, secondMessage] = worker.posted;
    worker.respond({ id: secondMessage!.id, ok: true, ...tokensA });
    await expect(second).resolves.toEqual(tokensA);

    // A late response for the superseded id is ignored without side effects.
    worker.respond({ id: firstMessage!.id, ok: true, tokens: null, langLoadFailed: true });
    expect(mockMarkLanguageFailed).not.toHaveBeenCalled();
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

  it("discards superseded in-thread requests", async () => {
    const factory = vi.fn(() => {
      throw new Error("Worker is not defined");
    });
    const client = new DiffTokenizeClient(factory);
    let resolveFirst: (result: DiffTokenizeResult) => void = () => undefined;
    mockRunDiffTokenize
      .mockImplementationOnce(
        () =>
          new Promise<DiffTokenizeResult>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(tokensA);

    const first = client.tokenize("viewer-1", makeRequest());
    const second = client.tokenize("viewer-1", makeRequest());

    resolveFirst({ tokens: null, langLoadFailed: false });

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toEqual(tokensA);
  });
});
