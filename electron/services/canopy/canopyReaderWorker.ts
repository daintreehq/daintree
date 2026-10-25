/**
 * Canopy's local screen reader, run in its own `utilityProcess` child: the
 * downloaded ONNX model and its tokenizer, one screen at a time on the CPU. Out of process because ONNX Runtime can abort in native code, which
 * here ends this child and never main; and so inference never stalls main's
 * event loop.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type * as Ort from "onnxruntime-node";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  decodeReading,
  encodeScreen,
  isReaderMeta,
  type ReaderMeta,
  type ReaderTokenizer,
} from "./canopyReader.js";
import type { ReaderWorkerInbound, ReaderWorkerOutbound } from "./canopyReaderWorkerProtocol.js";

interface ReaderParentPort {
  on(event: "message", listener: (event: { data: ReaderWorkerInbound }) => void): void;
  postMessage(message: ReaderWorkerOutbound): void;
}

const port = process.parentPort as unknown as ReaderParentPort | undefined;
if (!port) throw new Error("canopyReaderWorker must run in a utility process");

function post(message: ReaderWorkerOutbound): void {
  port!.postMessage(message);
}

/** On the next turn, so the last message flushes before the process goes. */
function exitSoon(code: number): void {
  setImmediate(() => process.exit(code));
}

process.on("uncaughtException", (err) => {
  post({ type: "error", message: formatErrorMessage(err, "Reader process error") });
  exitSoon(1);
});
process.on("unhandledRejection", (reason) => {
  post({ type: "error", message: formatErrorMessage(reason, "Reader process error") });
  exitSoon(1);
});

interface LoadedReader {
  meta: ReaderMeta;
  tok: ReaderTokenizer;
  ort: typeof Ort;
  session: Ort.InferenceSession;
}

let reader: LoadedReader | null = null;
let loading: Promise<void> = Promise.resolve();
/** Reads run one after another: one session, one thread. */
let chain: Promise<void> = Promise.resolve();
let destroyed = false;

async function load(dir: string): Promise<void> {
  const meta: unknown = JSON.parse(await readFile(path.join(dir, "reader.json"), "utf8"));
  if (!isReaderMeta(meta)) throw new Error("This model needs a newer version of Daintree");
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile(path.join(dir, "tokenizer.json"), "utf8").then((t) => JSON.parse(t) as object),
    readFile(path.join(dir, "tokenizer_config.json"), "utf8").then((t) => JSON.parse(t) as object),
  ]);
  // Loaded here rather than at module scope, so a failed native load is
  // reported as an error message rather than killing the entry module.
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const ortModule = (await import("onnxruntime-node")) as typeof Ort & { default?: typeof Ort };
  const ort = ortModule.InferenceSession ? ortModule : ortModule.default!;
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const tok: ReaderTokenizer = {
    ids: (text) => tokenizer.encode(text, { add_special_tokens: false }).ids,
    tokenId: (token) => {
      const id = tokenizer.token_to_id(token);
      if (id === undefined) throw new Error(`Tokenizer has no ${token}`);
      return id;
    },
  };
  const session = await ort.InferenceSession.create(path.join(dir, "model.int8.onnx"), {
    graphOptimizationLevel: "all",
    executionMode: "sequential",
    // Two threads: measured fastest on Apple silicon (Light 9 ms, Best 47 ms a
    // screen, against 13 and 76 on one), and never more, so it doesn't compete
    // with the user's work. Core ML was 3x slower at 6-9x the memory.
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  });
  if (destroyed) {
    await session.release();
    return;
  }
  reader = { meta, tok, ort, session };
}

async function read(
  id: number,
  state: Extract<ReaderWorkerInbound, { type: "read" }>["state"],
  lines: string[]
): Promise<void> {
  await loading;
  const current = reader;
  if (destroyed || current === null) {
    post({ type: "read-failed", id, message: "Reader not loaded" });
    return;
  }
  const started = performance.now();
  try {
    const { meta, tok, ort, session } = current;
    const e = encodeScreen(meta, tok, state, lines);
    const n = e.ids.length;
    const k = Math.max(1, e.lineIndex.length);
    const padded = <T>(xs: T[], fill: T): T[] => [
      ...xs,
      ...Array<T>(Math.max(0, k - xs.length)).fill(fill),
    ];
    const ints = (xs: number[]) => BigInt64Array.from(xs, (x) => BigInt(x));
    const bools = (xs: boolean[]) => Uint8Array.from(padded(xs, false), (x) => (x ? 1 : 0));
    const feeds: Record<string, Ort.Tensor> = {
      input_ids: new ort.Tensor("int64", ints(e.ids), [1, n]),
      attention_mask: new ort.Tensor("int64", ints(e.ids.map(() => 1)), [1, n]),
      line_pos: new ort.Tensor("int64", ints(padded(e.linePos, 0)), [1, k]),
      line_mask: new ort.Tensor("bool", bools(e.lineIndex.map(() => true)), [1, k]),
      q_mask: new ort.Tensor("bool", bools(e.qMask), [1, k]),
      s_mask: new ort.Tensor("bool", bools(e.sMask), [1, k]),
    };
    const out = await session.run(feeds);
    const arr = (name: string) => Array.from(out[name].data as Float32Array, Number);
    const reading = decodeReading(meta, arr, e.lineIndex, e.qMask);
    post({ type: "reading", id, reading, ms: Math.round(performance.now() - started) });
  } catch (err) {
    post({ type: "read-failed", id, message: formatErrorMessage(err, "Read failed") });
  }
}

port.on("message", ({ data: message }) => {
  if (message.type === "destroy") {
    if (destroyed) return;
    destroyed = true;
    void loading
      .then(() => chain)
      .then(async () => {
        const current = reader;
        reader = null;
        await current?.session.release();
      })
      .then(
        () => {
          post({ type: "drained" });
          exitSoon(0);
        },
        (err: unknown) => {
          post({ type: "error", message: formatErrorMessage(err, "Reader cleanup failed") });
          exitSoon(1);
        }
      );
    return;
  }
  if (destroyed) return;
  if (message.type === "load") {
    loading = load(message.dir).then(
      () => {
        if (!destroyed) post({ type: "ready" });
      },
      (err: unknown) => {
        post({ type: "error", message: formatErrorMessage(err, "Couldn't load the model") });
      }
    );
    return;
  }
  if (message.type === "read") {
    const { id, state, lines } = message;
    chain = chain.then(() => read(id, state, lines));
  }
});
