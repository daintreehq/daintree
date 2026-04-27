// Minimal pty-host stub for IPC contract integration tests.
// Mirrors the message-shape contract that PtyClient relies on:
//   - Sends `{ type: "ready" }` on startup (matches pty-host.ts:1695).
//   - Responds to `health-check` with `pong` (matches the heartbeat protocol).
//   - Silently accepts other PtyClient-emitted messages so they don't error.
//   - Echoes `ipc-test:roundtrip` payloads — the bidirectional roundtrip
//     proves complex types (Map/Date/Buffer/nested) survive the V8
//     structured-clone boundary in both directions.
//   - Calls `process.exit(1)` on `ipc-test:die` to simulate a real host crash.

import { workerData } from "node:worker_threads";
import process from "node:process";

const { port } = workerData;

port.on("message", (raw) => {
  // pty-host.ts:719 normalizes both possible wrapper shapes:
  //   `const message = rawMsg?.data ?? rawMsg;`
  // worker_threads delivers values directly, but match the same defensive
  // shape to keep the stub a faithful contract surface.
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
      // Hard-exit the worker to surface a real exit signal to the parent.
      process.exit(1);
      return;

    case "health-check":
      port.postMessage({ type: "pong" });
      return;

    case "set-log-level-overrides":
    case "spawn":
    case "kill":
    case "set-ipc-data-mirror":
    case "connect-port":
    case "disconnect-port":
    case "set-resource-monitoring":
    case "set-session-persist-suppressed":
    case "broadcast-write":
      return;

    default:
      // Drop unknown messages silently — keeps the stub forward-compatible
      // when PtyClient adds new request types.
      return;
  }
});

// Send the ready handshake. The Worker's `port.on("message", ...)` listener
// is attached above before this postMessage, so any messages the client posts
// during startup are buffered by the port until processing resumes.
port.postMessage({ type: "ready" });
