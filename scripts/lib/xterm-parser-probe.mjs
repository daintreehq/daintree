// Worker for xtermMinifyGuard.ts: loads one build of xterm into a jsdom window
// and records what its parser answers to each step. A worker keeps jsdom's
// globals and xterm's write timers out of the Vite build process.

import { parentPort, workerData } from "node:worker_threads";
import { JSDOM, VirtualConsole } from "jsdom";

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "self",
  "HTMLElement",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
];

/**
 * @param {{ code: string, steps: string[], trailer: string }} probe
 * @returns {Promise<{ replies: string[], firstLine: string }>}
 */
async function run({ code, steps, trailer }) {
  const dom = new JSDOM("<!doctype html><body></body>", {
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  for (const key of GLOBALS) {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  }
  const { Terminal } = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  const terminal = new Terminal();
  let pending = "";
  const subscription = terminal.onData((data) => {
    pending += data;
  });
  const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
  try {
    const replies = [];
    for (const step of steps) {
      pending = "";
      await write(step);
      replies.push(pending);
    }
    await write(`${trailer}\r\n`);
    const firstLine = terminal.buffer.active.getLine(0)?.translateToString(true) ?? "";
    return { replies, firstLine };
  } finally {
    subscription.dispose();
    terminal.dispose();
    dom.window.close();
  }
}

parentPort?.postMessage(await run(workerData));
