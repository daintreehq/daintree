import { app } from "electron";
import { runAttachStdioBridge } from "./attachStdio.js";
import { hostLocation } from "./hostLocation.js";

/**
 * `daintree --attach-stdio`: bridge this process's stdio to the Daintree
 * already running here, then exit. Started by main.ts before the
 * single-instance lock, so it is never handed to the running instance as a
 * second launch, and before anything that would open a window or start a
 * backend. stdout carries the link, so nothing else may write to it.
 */
export async function runAttachStdioCli(): Promise<number> {
  const toStderr =
    (level: string) =>
    (...args: unknown[]) => {
      process.stderr.write(`[attach-stdio] ${level} ${args.map(String).join(" ")}\n`);
    };
  console.log = toStderr("log");
  console.info = toStderr("info");
  console.debug = toStderr("debug");
  console.warn = toStderr("warn");
  // A process that exists only to carry bytes has no business in the Dock.
  try {
    app.dock?.hide();
  } catch {
    // Not every launch context has a Dock.
  }
  return runAttachStdioBridge({
    discoveryPath: hostLocation().discoveryPath,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
  });
}
