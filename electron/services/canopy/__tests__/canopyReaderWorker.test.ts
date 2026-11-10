import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { ReaderMeta } from "../canopyReader.js";
import { CANOPY_READER_WEIGHTS } from "../canopyModels.js";
import type { ReaderWorkerInbound, ReaderWorkerOutbound } from "../canopyReaderWorkerProtocol.js";

class FakeTensor {
  constructor(
    readonly type: string,
    readonly data: BigInt64Array | Uint8Array,
    readonly dims: number[]
  ) {}
}
type Feeds = Record<string, FakeTensor>;

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  postMessage: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
}));

const META: ReaderMeta = {
  max_len: 1024,
  header_tokens: 192,
  line_tokens: 256,
  question_candidate_rows: 40,
  status_candidate_rows: 60,
  inputs: ["input_ids", "attention_mask", "line_pos", "line_mask", "q_mask", "s_mask"],
  outputs: [
    "category",
    "needs_attention",
    "blocked_on_user",
    "notable",
    "tests",
    "changes",
    "risk",
    "instruction",
    "progress",
    "failure_repeats",
    "score",
    "question_line",
    "status_line",
    "key_lines",
    "summary_lines",
    "option_lines",
    "action_line",
    "task_line",
  ],
  categories: ["approval", "question", "finished", "error", "working", "running", "idle"],
  classes: {
    tests: ["passing", "failing", "not_run", "unknown"],
    changes: ["uncommitted", "committed", "pushed", "none", "unknown"],
    risk: ["none", "caution", "unknown"],
    instruction: ["none", "asked", "ongoing", "done", "irreversible"],
    progress: ["none", "0", "50", "100"],
    failure_repeats: ["0", "1", "2", "3+"],
    score: ["98", "5"],
  },
  thresholds: {
    summary_first: 0.5,
    summary_more: 0.6,
    option: 0.5,
    gate: 0.4,
    gate_categories: ["approval", "question", "finished", "error"],
  },
};

/** An idle reading at any line count: each line head scores its k lines and "none". */
function outputs(feeds: Feeds) {
  const k = feeds.line_mask.dims[1];
  const head = (xs: number[]) => ({ data: Float32Array.from(xs) });
  const lines = () => head([...Array<number>(k).fill(0), 5]);
  const classes = Object.fromEntries(
    Object.entries(META.classes).map(([name, values]) => [name, head(values.map(() => 0))])
  );
  return {
    ...classes,
    category: head([0, 0, 0, 0, 0, 0, 5]),
    needs_attention: head([-5]),
    blocked_on_user: head([-5]),
    notable: head([-5]),
    question_line: lines(),
    status_line: lines(),
    action_line: lines(),
    task_line: lines(),
    key_lines: head(Array<number>(k).fill(-5)),
    summary_lines: head(Array<number>(k).fill(-5)),
    option_lines: head(Array<number>(k).fill(-5)),
  };
}

let dir: string;
let exitSpy: MockInstance<typeof process.exit>;

function send(message: ReaderWorkerInbound) {
  mocks.on.mock.calls.find(([event]) => event === "message")![1]({ data: message });
}
function posted(): ReaderWorkerOutbound[] {
  return mocks.postMessage.mock.calls.map(([message]) => message as ReaderWorkerOutbound);
}

/** Imports the entry the way a utility process runs it, its crash handlers kept off the runner. */
async function loadWorker(): Promise<void> {
  const onSpy = vi.spyOn(process, "on").mockImplementation((() => process) as typeof process.on);
  try {
    await import("../canopyReaderWorker.js");
  } finally {
    onSpy.mockRestore();
  }
  send({ type: "load", dir });
  await vi.waitFor(() => expect(posted()).toContainEqual({ type: "ready" }));
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "canopy-reader-worker-"));
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(META));
  writeFileSync(path.join(dir, "tokenizer.json"), "{}");
  writeFileSync(path.join(dir, "tokenizer_config.json"), "{}");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.run.mockImplementation(async (feeds: Feeds) => outputs(feeds));
  mocks.create.mockResolvedValue({ run: mocks.run, release: vi.fn(async () => {}) });
  vi.doMock("onnxruntime-node", () => ({
    InferenceSession: { create: mocks.create },
    Tensor: FakeTensor,
  }));
  // One token per character.
  vi.doMock("@huggingface/tokenizers", () => ({
    Tokenizer: class {
      encode(text: string) {
        return { ids: [...text].map((c) => c.codePointAt(0)!) };
      }
      token_to_id(token: string) {
        return ({ "[CLS]": 1, "[SEP]": 2 } as Record<string, number>)[token];
      }
    },
  }));
  Object.defineProperty(process, "parentPort", {
    value: { on: mocks.on, postMessage: mocks.postMessage },
    configurable: true,
  });
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  delete (process as { parentPort?: unknown }).parentPort;
});

describe("Canopy reader process", () => {
  it("creates its session with memory-pattern planning off and the CPU arena kept", async () => {
    await loadWorker();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const [weights, options] = mocks.create.mock.calls[0] as [string, Record<string, unknown>];
    expect(weights).toBe(path.join(dir, CANOPY_READER_WEIGHTS));
    // Every read has its own input shape, so planning per shape only grows the arena (#16681).
    expect(options.enableMemPattern).toBe(false);
    // The arena itself stays on: reads ran about 50% slower without it.
    expect(options.enableCpuMemArena).not.toBe(false);
  });

  it("feeds each read tensors shaped by its own screen", async () => {
    await loadWorker();
    const state = { agent_program: "claude" };
    send({ type: "read", id: 1, state, lines: ["one line"] });
    send({ type: "read", id: 2, state, lines: ["first", "", "second", "third"] });
    send({ type: "read", id: 3, state, lines: ["", "  "] });
    await vi.waitFor(() => expect(posted().filter((m) => m.type === "reading")).toHaveLength(3));
    expect(posted().flatMap((m) => (m.type === "reading" ? [m.id] : []))).toEqual([1, 2, 3]);

    const feeds = mocks.run.mock.calls.map(([f]) => f as Feeds);
    const lineFeeds = ["line_pos", "line_mask", "q_mask", "s_mask"];
    for (const f of feeds) {
      expect(f.input_ids.dims).toEqual([1, f.input_ids.data.length]);
      expect(f.attention_mask.dims).toEqual(f.input_ids.dims);
      for (const name of lineFeeds) expect(f[name].dims).toEqual(f.line_mask.dims);
      for (const tensor of Object.values(f)) {
        expect(tensor.data).toHaveLength(tensor.dims.reduce((a, b) => a * b, 1));
      }
    }
    // The blank line is never encoded, so the second screen reads three lines.
    expect(feeds.map((f) => f.line_mask.dims)).toEqual([
      [1, 1],
      [1, 3],
      [1, 1],
    ]);
    expect(feeds[1].input_ids.dims[1]).toBeGreaterThan(feeds[0].input_ids.dims[1]);
    // A screen with no text still feeds one line slot, masked off.
    for (const name of lineFeeds) expect([...feeds[2][name].data].map(Number)).toEqual([0]);
  });
});
