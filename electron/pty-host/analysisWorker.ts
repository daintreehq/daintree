import { parentPort } from "node:worker_threads";
import { AnalysisWorkerRuntime } from "../services/pty/analysis/AnalysisWorkerRuntime.js";
import type { HostToWorkerMessage } from "../services/pty/analysisWorkerProtocol.js";

if (!parentPort) {
  throw new Error("[AnalysisWorker] Must run as a worker thread");
}

const port = parentPort;
const runtime = new AnalysisWorkerRuntime((msg) => port.postMessage(msg));

port.on("message", (msg: HostToWorkerMessage) => {
  runtime.handleMessage(msg);
});

port.postMessage({ type: "ready" });
