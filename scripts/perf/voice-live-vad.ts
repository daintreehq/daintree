/**
 * The OpenAI provider's VAD worker, unmodified, in a Node child instead of an
 * Electron utility process: the live voice harnesses (`lib/voiceLiveSession.ts`)
 * fork this in place of `utilityProcess.fork`. It stands in for
 * `process.parentPort` over Node IPC, holding what the parent sends until the
 * worker's listener is in place, as an Electron port holds messages until it
 * is started.
 */

type Listener = (event: { data: unknown }) => void;

let listener: Listener | null = null;
const held: unknown[] = [];

process.on("message", (data) => {
  if (listener) listener({ data });
  else held.push(data);
});
// An interrupted run must not leave the model loaded in an orphan.
process.on("disconnect", () => process.exit(0));
// The parent decides when this stops. A terminal Ctrl+C reaches the whole
// process group, and the run's first one lets the session in flight finish.
process.on("SIGINT", () => {});

const port = {
  on(event: string, next: Listener) {
    if (event !== "message") return;
    listener = next;
    for (const data of held.splice(0)) next({ data });
  },
  postMessage(message: unknown) {
    if (process.connected) process.send?.(message);
  },
};
(process as unknown as { parentPort: typeof port }).parentPort = port;

import("../../electron/services/voice/openaiVadWorker").catch((error: unknown) => {
  console.error("[voice-live-vad] VAD worker failed to load:", error);
  process.exit(1);
});
