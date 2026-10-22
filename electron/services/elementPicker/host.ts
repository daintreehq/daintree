/**
 * The Element Picker source host, run in its own `utilityProcess`. It exists
 * only while main has resolves for it: main forks it on the first one and
 * retires it after an idle spell, which is the only way the resolvers it
 * loaded give their memory back.
 */
import type { HostInbound, HostOutbound } from "./hostProtocol.js";
import { createHostRuntime } from "./worker/runtime.js";
import { RESOLVER_LOADERS } from "./worker/resolverRegistry.js";

interface HostParentPort {
  on(event: "message", listener: (event: { data: HostInbound }) => void): void;
  postMessage(message: HostOutbound): void;
}

const port = process.parentPort as unknown as HostParentPort | undefined;
if (!port) {
  throw new Error("The Element Picker host must run in a utility process");
}

function post(message: HostOutbound): void {
  port!.postMessage(message);
}

// Exit on the next turn so the last message flushes over Mojo first.
function exitSoon(code: number): void {
  setImmediate(() => process.exit(code));
}

// Electron 37+ only warns on these in a utility process. Exit instead, so main
// sees the host go and fails its jobs rather than waiting on answers that will
// never come.
process.on("uncaughtException", (error) => {
  post({ type: "fatal", message: String(error instanceof Error ? error.stack : error) });
  exitSoon(1);
});
process.on("unhandledRejection", (reason) => {
  post({ type: "fatal", message: String(reason instanceof Error ? reason.stack : reason) });
  exitSoon(1);
});

const runtime = createHostRuntime(post, RESOLVER_LOADERS);

port.on("message", ({ data }) => {
  if (data.type === "dispose") {
    exitSoon(0);
    return;
  }
  runtime.handle(data);
});

post({ type: "ready" });
