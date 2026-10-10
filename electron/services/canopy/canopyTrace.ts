import { app } from "electron";
import { appendFile } from "node:fs/promises";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * Development only: with `DAINTREE_CANOPY_TRACE` set to a file path, every
 * provider call is appended to it as one JSON line — the exact input the model
 * saw, what it answered, and how long it took. It is the corpus the prompts are
 * tuned against and, later, what a custom model is trained on. Off unless the
 * variable is set, never in a packaged build, and it never leaves the machine.
 */
const TRACE_PATH = (!app.isPackaged && process.env.DAINTREE_CANOPY_TRACE?.trim()) || null;

export function canopyTraceEnabled(): boolean {
  return TRACE_PATH !== null;
}

export async function traced<T>(
  stage: "classifier" | "describer",
  input: unknown,
  call: () => Promise<T>
): Promise<T> {
  if (TRACE_PATH === null) return call();
  const started = Date.now();
  try {
    const output = await call();
    void write({ stage, at: started, ms: Date.now() - started, input, output });
    return output;
  } catch (error) {
    const message = formatErrorMessage(error, "provider call failed");
    void write({ stage, at: started, ms: Date.now() - started, input, error: message });
    throw error;
  }
}

async function write(record: unknown): Promise<void> {
  try {
    await appendFile(TRACE_PATH!, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Tracing must never break a read.
  }
}
