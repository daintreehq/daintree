/**
 * The on-device speech model on ONNX Runtime: the cache-aware streaming
 * encoder, the prediction network and the joint, driven one 560 ms chunk at a
 * time. Each chunk's encoder input is the previous chunk's last mel rows and
 * the chunk's own; the encoder's caches come back out and go in again with the
 * next chunk, so nothing is computed twice.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type * as Ort from "onnxruntime-node";
import { RnntGreedyDecoder, type RnntStepModel } from "./localSpeechDecoder.js";
import { LocalSpeechMel } from "./localSpeechMel.js";
import { LOCAL_SPEECH_GEOMETRY as G } from "./localSpeechModelSpec.js";
import { LocalSpeechVocabulary } from "./localSpeechVocabulary.js";

type OrtModule = typeof Ort;

const ROWS = G.preEncodeCacheRows + G.chunkSamples / 160;

class OrtStepModel implements RnntStepModel {
  private h: Ort.Tensor;
  private c: Ort.Tensor;
  private pending: { output: Ort.Tensor; h: Ort.Tensor; c: Ort.Tensor } | null = null;
  /** The encoder frames of the current chunk, `[frames, hidden]`. */
  frames: Float32Array = new Float32Array(0);

  constructor(
    private readonly ort: OrtModule,
    private readonly decoder: Ort.InferenceSession,
    private readonly joint: Ort.InferenceSession
  ) {
    this.h = this.zeroState();
    this.c = this.zeroState();
  }

  private zeroState(): Ort.Tensor {
    return new this.ort.Tensor(
      "float32",
      new Float32Array(G.decoderLayers * G.decoderHidden),
      [G.decoderLayers, 1, G.decoderHidden]
    );
  }

  async predict(token: number): Promise<void> {
    const out = await this.decoder.run({
      targets: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(token)]), [1, 1]),
      h_in: this.h,
      c_in: this.c,
    });
    this.pending = { output: out.decoder_output, h: out.h_out, c: out.c_out };
  }

  commit(): void {
    if (!this.pending) return;
    this.h = this.pending.h;
    this.c = this.pending.c;
  }

  async join(first: number, count: number): Promise<Float32Array> {
    if (!this.pending) throw new Error("No prediction to join against");
    const encoder = this.frames.slice(first * G.hidden, (first + count) * G.hidden);
    const prediction = this.pending.output.data as Float32Array;
    const out = await this.joint.run({
      encoder_output: new this.ort.Tensor("float32", encoder, [1, count, G.hidden]),
      decoder_output: new this.ort.Tensor("float32", prediction, [1, 1, G.decoderHidden]),
    });
    return out.joint_output.data as Float32Array;
  }

  reset(): void {
    this.h = this.zeroState();
    this.c = this.zeroState();
    this.pending = null;
  }
}

export class LocalSpeechEngine {
  private readonly mel = new LocalSpeechMel();
  private readonly step: OrtStepModel;
  private readonly decoder: RnntGreedyDecoder;
  /** The encoder input: the cache rows, then the chunk's own. */
  private readonly signal = new Float32Array(ROWS * G.numMels);
  private cacheChannel!: Ort.Tensor;
  private cacheTime!: Ort.Tensor;
  private cacheLength!: Ort.Tensor;
  private promptId = 0;

  private constructor(
    private readonly ort: OrtModule,
    private readonly encoder: Ort.InferenceSession,
    private readonly predictor: Ort.InferenceSession,
    private readonly joint: Ort.InferenceSession,
    readonly vocabulary: LocalSpeechVocabulary
  ) {
    this.step = new OrtStepModel(ort, predictor, joint);
    this.decoder = new RnntGreedyDecoder(this.step, G.blankId, G.vocabSize, G.maxSymbolsPerStep);
    this.reset();
  }

  static async load(ort: OrtModule, dir: string, threads: number): Promise<LocalSpeechEngine> {
    const options: Ort.InferenceSession.SessionOptions = {
      graphOptimizationLevel: "all",
      executionMode: "sequential",
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    };
    const vocabulary = LocalSpeechVocabulary.parse(
      await readFile(path.join(dir, "vocab.txt"), "utf8"),
      G.vocabSize
    );
    const sessions: Ort.InferenceSession[] = [];
    try {
      for (const name of ["encoder.onnx", "decoder.onnx", "joint.onnx"]) {
        sessions.push(await ort.InferenceSession.create(path.join(dir, name), options));
      }
    } catch (error) {
      await Promise.allSettled(sessions.map((s) => s.release()));
      throw error;
    }
    const [encoder, predictor, joint] = sessions;
    return new LocalSpeechEngine(ort, encoder, predictor, joint, vocabulary);
  }

  /** The model's prompt id: a language, or Auto-detect. Takes effect from the next chunk. */
  setPromptId(id: number): void {
    this.promptId = id;
  }

  /** The start of a new stream: zero caches, zero mel context, the blank as the last token. */
  reset(): void {
    this.mel.reset();
    this.signal.fill(0);
    this.cacheChannel = new this.ort.Tensor(
      "float32",
      new Float32Array(G.layers * G.leftContext * G.hidden),
      [1, G.layers, G.leftContext, G.hidden]
    );
    this.cacheTime = new this.ort.Tensor(
      "float32",
      new Float32Array(G.layers * G.hidden * G.convContext),
      [1, G.layers, G.hidden, G.convContext]
    );
    this.cacheLength = new this.ort.Tensor("int64", new BigInt64Array(1), [1]);
    this.decoder.reset();
  }

  /** The tokens one chunk of `chunkSamples` 16 kHz samples emits. */
  async decodeChunk(chunk: Float32Array): Promise<number[]> {
    if (chunk.length !== G.chunkSamples) {
      throw new Error(`A chunk is ${G.chunkSamples} samples, got ${chunk.length}`);
    }
    const cacheFloats = G.preEncodeCacheRows * G.numMels;
    this.mel.process(chunk, this.signal, cacheFloats);
    const out = await this.encoder.run({
      audio_signal: new this.ort.Tensor("float32", this.signal.slice(), [1, ROWS, G.numMels]),
      length: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(ROWS)]), [1]),
      cache_last_channel: this.cacheChannel,
      cache_last_time: this.cacheTime,
      cache_last_channel_len: this.cacheLength,
      lang_id: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(this.promptId)]), [1]),
    });
    this.signal.copyWithin(0, this.signal.length - cacheFloats);
    this.cacheChannel = out.cache_last_channel_next;
    this.cacheTime = out.cache_last_time_next;
    this.cacheLength = out.cache_last_channel_len_next;
    const encoded = out.outputs;
    const framesPerChunk = encoded.dims[1];
    const lengths = out.encoded_lengths.data as BigInt64Array | Int32Array;
    const frames = Math.min(framesPerChunk, Number(lengths[0]));
    this.step.frames = encoded.data as Float32Array;
    return this.decoder.decodeChunk(frames);
  }

  async release(): Promise<void> {
    await Promise.allSettled([this.encoder.release(), this.predictor.release(), this.joint.release()]);
  }
}
