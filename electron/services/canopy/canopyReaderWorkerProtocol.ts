/**
 * Messages between main and Canopy's reader process (`canopyReaderWorker.ts`),
 * which runs the local ONNX model on one screen at a time. Screen text crosses
 * this boundary and goes nowhere else: the process has no network use.
 */
import type { Reading, ReaderState } from "./canopyReader.js";

/** Main → reader process. */
export type ReaderWorkerInbound =
  | {
      /** Load the model in `dir`: reader.json, tokenizer files and model.int8.onnx. */
      type: "load";
      dir: string;
    }
  | {
      type: "read";
      id: number;
      state: ReaderState;
      lines: string[];
    }
  | {
      /** Finish the read under way, release the ONNX session, then exit. */
      type: "destroy";
    };

/** Reader process → main. */
export type ReaderWorkerOutbound =
  | { type: "ready" }
  | { type: "reading"; id: number; reading: Reading; ms: number }
  | { type: "read-failed"; id: number; message: string }
  | { type: "drained" }
  | {
      /** The model could not be loaded, or the process failed outside a read. */
      type: "error";
      message: string;
    };
