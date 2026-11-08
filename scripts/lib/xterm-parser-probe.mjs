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

const isClass = (value) => /^class\b/.test(Function.prototype.toString.call(value));

/**
 * A code-split chunk exports Rolldown's private interface: aliased bindings,
 * module namespaces, and lazy module initializers that must run before a
 * namespace's getters return anything. Every argument-less function export
 * other than a class is called to run those initializers, and a throw fails
 * the probe, as it would fail loading xterm in the app. Only an unambiguous
 * `Terminal` is accepted.
 */
function findTerminal(module) {
  for (const value of Object.values(module)) {
    if (typeof value === "function" && value.length === 0 && !isClass(value)) value();
  }
  const candidates = new Set();
  for (const value of [module, ...Object.values(module)]) {
    if (value && typeof value === "object" && typeof value.Terminal === "function") {
      candidates.add(value.Terminal);
    }
  }
  if (candidates.size !== 1) {
    throw new Error(`expected one xterm Terminal export, found ${candidates.size}`);
  }
  return [...candidates][0];
}

/**
 * @param {{ url: string, steps: string[], trailer: string }} probe
 * @returns {Promise<{ replies: string[], firstLine: string }>}
 */
async function run({ url, steps, trailer }) {
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
  const Terminal = findTerminal(await import(url));
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
