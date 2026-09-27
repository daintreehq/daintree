/**
 * Runs one agent database tool call in its own `utilityProcess`, then exits.
 *
 * `node:sqlite` steps a statement synchronously with no interrupt, so an
 * expensive query cannot be cancelled from inside the thread running it — a
 * worker thread's `terminate()` waits for the step to return. A process can be
 * killed mid-step, so a runaway agent query costs this child, never main.
 */
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  runDatabaseTool,
  type DatabaseToolRequest,
  type DatabaseToolResponse,
} from "./databaseTools.js";

interface DatabaseParentPort {
  once(event: "message", listener: (event: { data: DatabaseToolRequest }) => void): void;
  postMessage(message: DatabaseToolResponse): void;
}

const port = process.parentPort as unknown as DatabaseParentPort | undefined;
if (!port) {
  throw new Error("databaseQueryWorker must run in a utility process");
}

// Exit on the next turn so the answer flushes over Mojo before the process goes.
function finish(message: DatabaseToolResponse): void {
  port!.postMessage(message);
  setImmediate(() => process.exit(0));
}

process.on("uncaughtException", (err) => {
  finish({ ok: false, error: { code: null, message: formatErrorMessage(err, "query failed") } });
});

port.once("message", (event) => {
  finish(runDatabaseTool(event.data));
});
