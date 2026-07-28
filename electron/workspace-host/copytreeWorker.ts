/**
 * Copytree worker for the workspace-host.
 *
 * Context generation (file-tree walk, fast-glob, reading many files, XML
 * formatting) is CPU-bound and used to run on the workspace-host event loop,
 * competing with git polling and file watching. This worker moves that CPU
 * off-thread; the host relays requests/results over the worker port.
 *
 * The worker is persistent: Electron 37+ crashes on repeated worker
 * spawn/terminate cycles inside a utilityProcess (`!flush_tasks_`), so the
 * host spawns this once and never terminates it in normal operation.
 */
import { parentPort } from "node:worker_threads";
import { copyTreeService } from "../services/CopyTreeService.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { CopytreeWorkerRequest, CopytreeWorkerResponse } from "./copytreeWorkerProtocol.js";

const port = parentPort;
if (!port) {
  throw new Error("copytreeWorker must run as a worker thread");
}

function post(message: CopytreeWorkerResponse): void {
  port!.postMessage(message);
}

port.on("message", (message: CopytreeWorkerRequest) => {
  switch (message.type) {
    case "generate": {
      const { id, rootPath, options } = message;
      void copyTreeService
        .generate(rootPath, options, (progress) => post({ type: "progress", id, progress }), id)
        .then(
          (result) => post({ type: "generate-result", id, result }),
          (error: unknown) =>
            post({
              type: "generate-error",
              id,
              error: formatErrorMessage(error, "Failed to generate context"),
            })
        );
      break;
    }
    case "test-config": {
      const { id, rootPath, options } = message;
      void copyTreeService.testConfig(rootPath, options, id).then(
        (result) => post({ type: "test-config-result", id, result }),
        (error: unknown) =>
          post({
            type: "test-config-error",
            id,
            error: formatErrorMessage(error, "Failed to test CopyTree config"),
          })
      );
      break;
    }
    case "get-file-tree": {
      const { id, rootPath, dirPath, options, includeExcluded } = message;
      void copyTreeService.getFileTree(rootPath, dirPath, options, { includeExcluded }, id).then(
        (nodes) => post({ type: "get-file-tree-result", id, nodes }),
        (error: unknown) =>
          post({
            type: "get-file-tree-error",
            id,
            error: formatErrorMessage(error, "Failed to read the project files"),
          })
      );
      break;
    }
    case "cancel":
      copyTreeService.cancel(message.id);
      break;
  }
});
