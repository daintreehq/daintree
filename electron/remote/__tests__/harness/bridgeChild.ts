import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { StreamCommandChild } from "../../client/commandStreamTransport.js";
import { runAttachStdioBridge } from "../../host/attachStdio.js";

export type BridgeChild = StreamCommandChild & { exited: Promise<number> };

/**
 * A stand-in for `<daintree> --attach-stdio` as a child process: the real
 * bridge, run in this process against a host's discovery file, with its
 * stdio as the child's pipes.
 */
export function bridgeChild(discoveryPath: string, endGraceMs = 100): BridgeChild {
  const child = new EventEmitter() as EventEmitter & BridgeChild;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      stdin.destroy();
      return true;
    },
  });
  child.exited = runAttachStdioBridge({
    discoveryPath,
    input: stdin,
    output: stdout,
    errorOutput: stderr,
    endGraceMs,
  }).then((code) => {
    stderr.end();
    stdout.end();
    setImmediate(() => child.emit("exit", code, null));
    return code;
  });
  return child;
}
