// Minimal workspace-host stub for IPC contract integration tests.
// Mirrors the message-shape contract that WorkspaceHostProcess relies on:
//   - Sends `{ type: "ready" }` on startup (matches workspace-host.ts:618).
//   - Responds to `health-check` with `pong`.
//   - Silently accepts WorkspaceHostProcess-emitted messages.
//   - Echoes `ipc-test:roundtrip` payloads to verify complex types survive
//     the V8 structured-clone boundary in both directions.
//   - Calls `process.exit(1)` on `ipc-test:die` to simulate a host crash.

import { workerData } from "node:worker_threads";
import process from "node:process";

const { port } = workerData;

port.on("message", (raw) => {
  // workspace-host.ts:270 normalizes both wrapper shapes via `rawMsg?.data ?? rawMsg`.
  const msg = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
  const type = msg?.type;

  switch (type) {
    case "ipc-test:roundtrip":
      port.postMessage({
        type: "ipc-test:roundtrip-result",
        requestId: msg.requestId,
        payload: msg.payload,
      });
      return;

    case "ipc-test:die":
      process.exit(1);
      return;

    case "health-check":
      port.postMessage({ type: "pong" });
      return;

    case "set-log-level-overrides":
    case "update-github-token":
    case "attach-renderer-port":
    case "attach-worktree-port":
    case "dispose":
    case "load-project":
    case "sync":
    case "project-switch":
    case "set-active":
    case "refresh":
    case "set-polling-enabled":
    case "background":
    case "foreground":
      return;

    default:
      return;
  }
});

port.postMessage({ type: "ready" });
