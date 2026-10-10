import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCanopyBackendForTests,
  canopyServiceUrl,
  classifyWithCanopy,
  describeWithCanopy,
  wakeCanopy,
} from "../canopyBackend.js";
import { CanopyProviderError, type CanopyScreenInput } from "../canopyProviders.js";

const INPUT: CanopyScreenInput = {
  runId: "run-1",
  agent: "claude",
  title: "Claude",
  screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No",
  lines: ["Do you want to proceed?", "❯ 1. Yes", "  2. No"],
  observed: { agentState: "waiting", waitingReason: "approval", secondsInState: 30 },
  failureRepeatsCap: 2,
};

const CLASSIFIER = {
  category: "approval",
  confidence: 0.99,
  attention: 0.97,
  attention_raw: 0.95,
  blocked: 0.93,
  notable: 0.9,
  question: "Do you want to proceed?",
  status: "Do you want to proceed?",
  question_line: 0,
  status_line: 0,
  key_lines: [0, 1, 2],
};

const CARD = {
  category: "approval",
  attention_score: 94,
  headline: "Approve running npm test",
  question: "Do you want to proceed?",
  options: ["Yes", "No"],
  action: "npm test",
  risk: "none",
  risk_reason: null,
  summary: "Runs the unit suite once.",
  task: "Fix the rounding bug",
  progress: 60,
  tests: "unknown",
  changes: "uncommitted",
  instruction: "none",
  failure_repeats: 0,
  note: "Goal: fix rounding",
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fields(card: Record<string, unknown>): string {
  return Object.entries(card)
    .map(([name, value]) => sse("field", { name, value }))
    .join("");
}

const DONE = sse("done", { timings: {}, versions: {}, described: true });

/** A streamed body handed out in the chunks given, split anywhere. */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

/** A body the test feeds by hand, so it can look between events. */
function manualStream() {
  const encoder = new TextEncoder();
  let push!: (text: string) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push: (text: string) => push(text),
    end: () => end(),
  };
}

/** The classifier-only endpoint's answer: one JSON object. */
function classified(classifier: unknown): Response {
  return new Response(
    JSON.stringify({ classifier, card: null, described: false, timings: {}, versions: {} }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** A service from before /v1/classify. */
const NO_CLASSIFY = () => new Response("not found", { status: 404 });

/** Reads take the responses given, in order; a wake ping is always answered. */
function stubFetch(...responses: Array<Response | (() => Response)>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/ping")) return new Response(null, { status: 200 });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return typeof next === "function" ? next() : next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1]!;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  __resetCanopyBackendForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("classifyWithCanopy", () => {
  it("asks for the classifier alone, with no credentials, and reads every measure back", async () => {
    const fetchMock = stubFetch(classified(CLASSIFIER));
    const result = await classifyWithCanopy(INPUT);
    expect(result).toEqual({
      category: "approval",
      confidence: 0.99,
      attention: 0.97,
      blocked: 0.93,
      notable: 0.9,
      question: "Do you want to proceed?",
      status: "Do you want to proceed?",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    // The light endpoint: one JSON answer, on the workers' fast lane.
    expect(url).toBe("https://canopy.daintree.org/v1/classify");
    const headers = init!.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({ tier: "paid" });
    expect(body).not.toHaveProperty("classifier_says");
    expect(body).not.toHaveProperty("stream");
  });

  it("sends main's bookkeeping nowhere", async () => {
    const fetchMock = stubFetch(classified(CLASSIFIER));
    await classifyWithCanopy(INPUT);
    const input = sentBody(fetchMock).input as Record<string, unknown>;
    expect(input).not.toHaveProperty("runId");
    expect(input).not.toHaveProperty("failureRepeatsCap");
    expect(input).toMatchObject({ agent: "claude", lines: INPUT.lines });
  });

  it("reads the status line without the spinner glyph and timer that tick on every read", async () => {
    stubFetch(
      classified({
        ...CLASSIFIER,
        category: "working",
        status: "✽ Refactoring the parser… (12s · ↓ 1.2k tokens · esc to interrupt)",
      })
    );
    expect((await classifyWithCanopy(INPUT)).status).toBe("Refactoring the parser…");
  });

  it("keeps a question only for an ask, and holds every probability to 0-1", async () => {
    stubFetch(
      classified({
        ...CLASSIFIER,
        category: "working",
        attention: 4,
        blocked: -1,
        notable: "x",
        status: "ok",
      })
    );
    expect(await classifyWithCanopy(INPUT)).toMatchObject({
      category: "working",
      question: null,
      attention: 1,
      blocked: 0,
      notable: 0,
      status: null,
    });
  });

  it("refuses a category the app doesn't know", async () => {
    stubFetch(classified({ ...CLASSIFIER, category: "sleeping" }));
    await expect(classifyWithCanopy(INPUT)).rejects.toThrow(CanopyProviderError);
  });

  it("falls back to the streamed read for a service without /v1/classify, and stays on it", async () => {
    const fetchMock = stubFetch(
      NO_CLASSIFY,
      streamOf([sse("classifier", CLASSIFIER), DONE]),
      streamOf([sse("classifier", CLASSIFIER), DONE])
    );
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
    expect(sentBody(fetchMock, 1)).toMatchObject({ describe: "never", tier: "paid", stream: true });
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://canopy.daintree.org/v1/classify",
      "https://canopy.daintree.org/v1/read",
      "https://canopy.daintree.org/v1/read",
    ]);
  });

  it("reads streamed events split anywhere across chunks, CRLF line ends included", async () => {
    const text = (sse("classifier", CLASSIFIER) + DONE).replace(/\n/g, "\r\n");
    const chunks = text.match(/[\s\S]{1,7}/g)!;
    stubFetch(NO_CLASSIFY, streamOf(chunks));
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
  });

  it("says the stream ended early when no classifier event came", async () => {
    stubFetch(NO_CLASSIFY, streamOf([DONE]));
    await expect(classifyWithCanopy(INPUT)).rejects.toThrow("stream ended early");
  });

  it("refuses a classify answer that is not JSON", async () => {
    stubFetch(new Response("<html>", { status: 200 }));
    await expect(classifyWithCanopy(INPUT)).rejects.toThrow("response was not JSON");
  });

  it("takes its address from the environment, without a trailing slash", () => {
    vi.stubEnv("DAINTREE_CANOPY_URL", "http://localhost:8000/");
    expect(canopyServiceUrl()).toBe("http://localhost:8000");
  });
});

describe("describeWithCanopy", () => {
  it("returns the finished card, checked like any other", async () => {
    const fetchMock = stubFetch(
      streamOf([sse("classifier", CLASSIFIER), fields(CARD), sse("card", CARD), DONE])
    );
    const result = await describeWithCanopy(INPUT, "approval");
    expect(result).toMatchObject({
      category: "approval",
      headline: "Approve running npm test",
      attentionScore: 94,
      options: ["Yes", "No"],
      action: "npm test",
      task: "Fix the rounding bug",
      progress: 60,
      changes: "uncommitted",
      note: "Goal: fix rounding",
    });
    expect(sentBody(fetchMock)).toMatchObject({
      describe: "always",
      classifier_says: "approval",
    });
  });

  it("sends the run's context: its note, history, task and what scrolled away", async () => {
    const fetchMock = stubFetch(streamOf([sse("classifier", CLASSIFIER), sse("card", CARD), DONE]));
    const context = {
      note: { text: "Goal: fix rounding", secondsAgo: 40 },
      digest: { requests: ["Fix the rounding bug"], todo: null, plan: [] },
      currentTask: "Fix the rounding bug",
      sinceLastReading: "• Ran npm test\n└ 1 failed",
    };
    await describeWithCanopy({ ...INPUT, ...context }, "approval");
    expect(sentBody(fetchMock).input).toMatchObject(context);
  });

  it("holds the card's score to its own facts' band", async () => {
    // A finished turn with uncommitted changes is never scored as cleanly done.
    const finished = { ...CARD, category: "finished", attention_score: 20, progress: 100 };
    stubFetch(streamOf([sse("classifier", CLASSIFIER), sse("card", finished), DONE]));
    expect((await describeWithCanopy(INPUT, "finished")).attentionScore).toBe(55);
  });

  it("caps the failure count the screen can't have raised", async () => {
    const card = { ...CARD, category: "working", failure_repeats: 5 };
    stubFetch(streamOf([sse("classifier", CLASSIFIER), sse("card", card), DONE]));
    expect((await describeWithCanopy(INPUT, "working")).failureRepeats).toBe(2);
  });

  it("shows the card as it streams, before it is finished", async () => {
    const stream = manualStream();
    stubFetch(stream.response);
    const partials: unknown[] = [];
    const done = describeWithCanopy(INPUT, "approval", undefined, (partial) =>
      partials.push(partial)
    );
    stream.push(sse("classifier", CLASSIFIER));
    // The state and score wait for the whole card: a score held to facts that
    // stream after it would move once they land.
    stream.push(fields({ category: "question", attention_score: 40 }));
    stream.push(fields({ headline: "Choose the parser approach" }));
    await vi.waitFor(() => expect(partials).toHaveLength(1));
    expect(partials[0]).toEqual({ category: "question", headline: "Choose the parser approach" });

    // Fields with nothing to show early don't redraw the row.
    stream.push(fields({ question: "Which one?", options: ["A", "B"], action: null }));
    stream.push(fields({ summary: "Two designs on screen." }));
    await vi.waitFor(() => expect(partials).toHaveLength(2));
    expect(partials[1]).toEqual({
      category: "question",
      headline: "Choose the parser approach",
      summary: "Two designs on screen.",
    });

    const card = { ...CARD, category: "question", headline: "Choose the parser approach" };
    stream.push(sse("card", card) + DONE);
    stream.end();
    expect((await done).headline).toBe("Choose the parser approach");
  });

  it("keeps the read going when the row's early update throws", async () => {
    stubFetch(streamOf([sse("classifier", CLASSIFIER), fields(CARD), sse("card", CARD), DONE]));
    const result = await describeWithCanopy(INPUT, "approval", undefined, () => {
      throw new Error("render failed");
    });
    expect(result.headline).toBe("Approve running npm test");
  });

  it("treats a card cut off part way as a failed read", async () => {
    stubFetch(
      streamOf([
        sse("classifier", CLASSIFIER),
        sse("card", { category: "approval", headline: "Approve", _incomplete: true }),
        DONE,
      ])
    );
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      provider: "describer",
      message: "card cut off",
    });
  });

  it("fails a stream the service ends with an error, by its code alone", async () => {
    stubFetch(
      streamOf([
        sse("classifier", CLASSIFIER),
        sse("error", { code: "worker_disconnected", message: "secret screen echoed" }),
      ])
    );
    const error = await describeWithCanopy(INPUT, "approval").catch((e: unknown) => e);
    expect(error).toMatchObject({
      provider: "describer",
      message: "stream failed: worker_disconnected",
      transient: true,
    });
  });

  it("takes a model that failed on the screen as no passing failure", async () => {
    stubFetch(
      streamOf([sse("classifier", CLASSIFIER), sse("error", { code: "inference_failed" })])
    );
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      message: "stream failed: inference_failed",
      transient: false,
    });
  });

  it("fails a describe whose stream ends with no card", async () => {
    stubFetch(streamOf([sse("classifier", CLASSIFIER), fields({ category: "approval" })]));
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      provider: "describer",
      message: "stream ended early",
    });
  });
});

describe("the service's limits and failures", () => {
  it("retries once when a worker is still loading its models", async () => {
    const fetchMock = stubFetch(
      new Response("models loading", { status: 503, headers: { "retry-after": "0" } }),
      classified(CLASSIFIER)
    );
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
    const reads = fetchMock.mock.calls.filter(([url]) => url.endsWith("/v1/classify"));
    expect(reads).toHaveLength(2);
  });

  it("holds every read off while the address is rate limited", async () => {
    const fetchMock = stubFetch(
      new Response("rate limited", { status: 429, headers: { "retry-after": "10" } })
    );
    await expect(classifyWithCanopy(INPUT)).rejects.toThrow("HTTP 429");
    // Another read finds out without asking: the limit is the machine's, not the read's.
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      provider: "describer",
      message: "HTTP 429",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits out a short rate limit and tries again", async () => {
    const fetchMock = stubFetch(
      new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
      classified(CLASSIFIER)
    );
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on any other failing status at once, naming only the status", async () => {
    const fetchMock = stubFetch(new Response("secret screen echoed", { status: 500 }));
    const error = await classifyWithCanopy(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CanopyProviderError);
    expect((error as Error).message).toBe("HTTP 500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pings a worker awake when the service can't reach one", async () => {
    const fetchMock = stubFetch(new Response("upstream unavailable", { status: 502 }));
    await expect(classifyWithCanopy(INPUT)).rejects.toThrow("HTTP 502");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://canopy.daintree.org/v1/classify",
      "https://canopy.daintree.org/ping",
    ]);
  });

  it("names a request that never reached the service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    await expect(classifyWithCanopy(INPUT)).rejects.toThrow("request failed");
  });

  it("stops when its caller cancels, mid-stream included", async () => {
    const stream = manualStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => stream.end());
        return stream.response;
      })
    );
    const controller = new AbortController();
    const reading = describeWithCanopy(INPUT, "approval", controller.signal);
    stream.push(sse("classifier", CLASSIFIER));
    controller.abort();
    await expect(reading).rejects.toThrow("request cancelled");
  });

  it("sends nothing for a read already cancelled", async () => {
    const fetchMock = stubFetch(streamOf([sse("classifier", CLASSIFIER), DONE]));
    const controller = new AbortController();
    controller.abort();
    await expect(classifyWithCanopy(INPUT, controller.signal)).rejects.toThrow("request cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops the stream behind a read that failed part way", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.addEventListener("abort", () => {
          cancelled = true;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(sse("classifier", { category: "sleeping" })));
            },
          }),
          { status: 200 }
        );
      })
    );
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toThrow(CanopyProviderError);
    expect(cancelled).toBe(true);
  });

  it("reads a last event the stream ended without a newline after", async () => {
    stubFetch(NO_CLASSIFY, streamOf([sse("classifier", CLASSIFIER), "event: done\ndata: {}"]));
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
  });

  it("fails a stream cut off before the service said it was done, as a passing failure", async () => {
    stubFetch(streamOf([sse("classifier", CLASSIFIER), fields(CARD), sse("card", CARD)]));
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      provider: "describer",
      message: "stream ended early",
      transient: true,
    });
  });

  it("files a card read's failure under the describer before any event arrives", async () => {
    stubFetch(new Response("bad gateway", { status: 502 }));
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      provider: "describer",
      message: "HTTP 502",
    });
  });

  it("files a classifier-only stream's error under the classifier", async () => {
    stubFetch(
      NO_CLASSIFY,
      streamOf([sse("classifier", CLASSIFIER), sse("error", { code: "inference_timeout" })])
    );
    await expect(classifyWithCanopy(INPUT)).rejects.toMatchObject({
      provider: "classifier",
      message: "stream failed: inference_timeout",
      transient: true,
    });
  });

  it("names no code the service doesn't have, whatever the event says", async () => {
    stubFetch(streamOf([sse("classifier", CLASSIFIER), sse("error", { error: "secret_screen" })]));
    await expect(describeWithCanopy(INPUT, "approval")).rejects.toMatchObject({
      message: "stream failed",
      transient: true,
    });
  });

  it("keeps a retry after the 404 on the streamed path", async () => {
    const fetchMock = stubFetch(
      NO_CLASSIFY,
      new Response("busy", { status: 503, headers: { "retry-after": "0" } }),
      streamOf([sse("classifier", CLASSIFIER), DONE])
    );
    expect((await classifyWithCanopy(INPUT)).category).toBe("approval");
    const paths = fetchMock.mock.calls
      .map(([url]) => new URL(url).pathname)
      .filter((path) => path !== "/ping");
    expect(paths).toEqual(["/v1/classify", "/v1/read", "/v1/read"]);
  });

  it("takes a classify answer cut off part way as a passing failure", async () => {
    const encoder = new TextEncoder();
    stubFetch(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"classifier":{"categ'));
            controller.error(new Error("connection reset"));
          },
        }),
        { status: 200 }
      )
    );
    await expect(classifyWithCanopy(INPUT)).rejects.toMatchObject({
      provider: "classifier",
      message: "request failed",
      transient: true,
    });
  });

  it("waits for a worker being woken before sending a read", async () => {
    let wake!: () => void;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith("/ping")) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          return new Response(null, { status: 200 });
        }
        return classified(CLASSIFIER);
      })
    );
    wakeCanopy();
    const reading = classifyWithCanopy(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["https://canopy.daintree.org/ping"]);
    wake();
    expect((await reading).category).toBe("approval");
    expect(calls).toHaveLength(2);
  });

  it("gives up on a worker that never answers, rather than hold the read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    const reading = classifyWithCanopy(INPUT);
    const settled = expect(reading).rejects.toThrow("request timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    // The silence is most likely a worker waking: the next read should find it up.
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe("https://canopy.daintree.org/ping");
  });
});

describe("wakeCanopy", () => {
  it("pings once at a time", async () => {
    let answer!: () => void;
    const fetchMock = vi.fn(
      (_url: string) =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(new Response(null, { status: 200 }));
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    wakeCanopy();
    wakeCanopy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://canopy.daintree.org/ping");
    answer();
    await vi.waitFor(() => {
      wakeCanopy();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("never throws when the ping fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    expect(() => wakeCanopy()).not.toThrow();
  });
});
