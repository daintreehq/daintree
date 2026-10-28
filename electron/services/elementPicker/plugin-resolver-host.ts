/**
 * One plugin's Element Picker source resolvers, run in their own
 * `utilityProcess`. Main forks it on the first resolve that names one of the
 * plugin's providers and retires it after an idle spell, which is the only way
 * the parsers the plugin loaded give their memory back. It never shares a
 * process with the core resolvers, and never with another plugin's.
 */
import type { HostOutbound, PluginHostInbound } from "./hostProtocol.js";
import { createPluginHostRuntime } from "./worker/pluginRuntime.js";

interface HostParentPort {
  on(event: "message", listener: (event: { data: PluginHostInbound }) => void): void;
  postMessage(message: HostOutbound): void;
}

const port = process.parentPort as unknown as HostParentPort | undefined;
if (!port) {
  throw new Error("The Element Picker plugin resolver host must run in a utility process");
}

function post(message: HostOutbound): void {
  port!.postMessage(message);
}

// Exit on the next turn so the last message flushes over Mojo first.
function exitSoon(code: number): void {
  setImmediate(() => process.exit(code));
}

// Whatever a plugin's resolver leaves throwing ends the process, so main fails
// the plugin's jobs and moves on rather than waiting on answers that won't come.
process.on("uncaughtException", (error) => {
  post({ type: "fatal", message: String(error instanceof Error ? error.stack : error) });
  exitSoon(1);
});
process.on("unhandledRejection", (reason) => {
  post({ type: "fatal", message: String(reason instanceof Error ? reason.stack : reason) });
  exitSoon(1);
});

const runtime = createPluginHostRuntime(post);

port.on("message", ({ data }) => {
  if (data.type === "dispose") {
    exitSoon(0);
    return;
  }
  runtime.handle(data);
});

post({ type: "ready" });
