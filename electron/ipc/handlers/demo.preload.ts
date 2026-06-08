import type { IpcInvokeMap } from "../../types/index.js";

// Opt out of `scripts/codegen/ipc-renderer.mjs` — the renderer-facing
// `window.electron.demo` API takes positional args (e.g.
// `moveTo(x, y, durationMs)`) while channels carry a single payload
// object. The translation lives inline in `preload.cts`, so the
// generator must skip this namespace.
export const RENDERER_API_SKIP = true as const;

// `demo:exec-*`, `demo:command-done`, `demo:capture-chunk`, and
// `demo:capture-stop` are renderer→main / main→renderer send channels
// (used by the demo runner harness) and are intentionally NOT part of
// this invoke map.
export const DEMO_METHOD_CHANNELS = {
  moveTo: "demo:move-to",
  moveToSelector: "demo:move-to-selector",
  click: "demo:click",
  type: "demo:type",
  screenshot: "demo:screenshot",
  waitForSelector: "demo:wait-for-selector",
  pause: "demo:pause",
  resume: "demo:resume",
  sleep: "demo:sleep",
  scroll: "demo:scroll",
  drag: "demo:drag",
  pressKey: "demo:press-key",
  typeInTerminal: "demo:type-in-terminal",
  sendKeyToTerminal: "demo:send-key-to-terminal",
  spotlight: "demo:spotlight",
  dismissSpotlight: "demo:dismiss-spotlight",
  annotate: "demo:annotate",
  dismissAnnotation: "demo:dismiss-annotation",
  waitForIdle: "demo:wait-for-idle",
  startCapture: "demo:start-capture",
  stopCapture: "demo:stop-capture",
  getCaptureStatus: "demo:get-capture-status",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof DEMO_METHOD_CHANNELS;

export type DemoPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * NOT used in production preload.cts — exported for symmetry with the other
 * namespace builders and exercised by `leafPreloadNamespaces.test.ts`.
 *
 * The renderer-facing `window.electron.demo` API takes positional args
 * (e.g. `moveTo(x, y, durationMs)`) while channels carry a single payload
 * object. The translation layer stays inline in `preload.cts` so the user-
 * facing shape matches the declared `ElectronAPI.demo` signature.
 */
export function buildDemoPreloadBindings(invoke: Invoker): DemoPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(DEMO_METHOD_CHANNELS) as Array<keyof Methods>) {
    const channel = DEMO_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as DemoPreloadBindings;
}
