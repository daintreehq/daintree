/**
 * Greedy RNN-T decoding for the on-device speech model, one encoder chunk at a
 * time. The prediction network carries the last emitted token across chunks;
 * per frame the joint picks the best token, a blank moves on to the next
 * frame, and anything else is emitted and fed back, at most
 * `maxSymbolsPerStep` per frame.
 */

export interface RnntStepModel {
  /** Runs the prediction network on `token` from the committed state, keeping the result pending. */
  predict(token: number): Promise<void>;
  /** Makes the pending prediction's state the committed one. */
  commit(): void;
  /**
   * Log-probabilities of frames `[first, first + count)` of the chunk against the
   * pending prediction, `count × vocab` floats.
   */
  join(first: number, count: number): Promise<Float32Array>;
  /** Back to the start of a stream: zero state. */
  reset(): void;
}

/** An emitted token and the encoder frame of its chunk it was emitted at. */
export interface DecodedToken {
  id: number;
  frame: number;
}

export class RnntGreedyDecoder {
  private lastToken: number;
  private predictionValid = false;

  constructor(
    private readonly model: RnntStepModel,
    private readonly blankId: number,
    private readonly vocabSize: number,
    private readonly maxSymbolsPerStep: number
  ) {
    this.lastToken = blankId;
  }

  reset(): void {
    this.lastToken = this.blankId;
    this.predictionValid = false;
    this.model.reset();
  }

  /** The tokens the chunk's first `frames` encoder frames emit, in order. */
  async decodeChunk(frames: number): Promise<DecodedToken[]> {
    const tokens: DecodedToken[] = [];
    let frame = 0;
    let symbols = 0;
    // Joint rows of frames [rowsFirst, frames) for the current prediction.
    let rows: Float32Array | null = null;
    let rowsFirst = 0;
    while (frame < frames) {
      if (!this.predictionValid) {
        await this.model.predict(this.lastToken);
        this.predictionValid = true;
      }
      if (rows === null) {
        rows = await this.model.join(frame, frames - frame);
        rowsFirst = frame;
      }
      const offset = (frame - rowsFirst) * this.vocabSize;
      const best = argMax(rows, offset, this.vocabSize, this.blankId);
      if (best === this.blankId) {
        frame++;
        symbols = 0;
        continue;
      }
      tokens.push({ id: best, frame });
      this.lastToken = best;
      this.model.commit();
      this.predictionValid = false;
      // Scored against the prediction this token replaces.
      rows = null;
      symbols++;
      if (symbols >= this.maxSymbolsPerStep) {
        frame++;
        symbols = 0;
      }
    }
    return tokens;
  }
}

/** The best of `values[offset, offset + length)`, skipping NaN; blank when all are NaN. */
export function argMax(
  values: Float32Array,
  offset: number,
  length: number,
  blankId: number
): number {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < length; i++) {
    const v = values[offset + i];
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  return best < 0 ? blankId : best;
}
