import type { CdpStackFrame, SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";

/**
 * States of the dev preview console's stack traces.
 *
 * Type imports only: the screenshot spec imports this module under Playwright's
 * Node loader, where anything reaching `import.meta.glob` fails to load.
 */

export const CONSOLE_PANE_ID = "dev-preview-console-4f1c";

const ORIGIN = "http://localhost:5173";
const T = "?t=1727170000123";

function frame(functionName: string, url: string, lineNumber: number, columnNumber: number) {
  return { functionName, url, lineNumber, columnNumber } satisfies CdpStackFrame;
}

const app = (file: string) => `${ORIGIN}/src/${file}${T}`;
const dep = (file: string) => `${ORIGIN}/node_modules/.vite/deps/${file}?v=4c1a2b3d`;

const CART_FRAMES: CdpStackFrame[] = [
  frame("computeTotals", app("lib/cart/totals.ts"), 42, 19),
  frame("CartSummary", app("components/cart/CartSummary.tsx"), 18, 23),
  frame("renderWithHooks", dep("chunk-RPCDYKBN.js"), 11548, 26),
  frame("updateFunctionComponent", dep("chunk-RPCDYKBN.js"), 14582, 28),
  frame("beginWork", dep("chunk-RPCDYKBN.js"), 15924, 22),
  frame("performUnitOfWork", dep("chunk-RPCDYKBN.js"), 19753, 20),
  frame("workLoopSync", dep("chunk-RPCDYKBN.js"), 19686, 13),
  frame("", dep("chunk-RPCDYKBN.js"), 19673, 18),
];

const FETCH_FRAMES: CdpStackFrame[] = [
  frame("loadOrders", app("routes/orders/+page.ts"), 12, 11),
  frame("", app("routes/orders/+page.ts"), 9, 3),
];

const LOG_FRAMES: CdpStackFrame[] = [frame("", app("main.tsx"), 7, 9)];

const DEEP_FRAMES: CdpStackFrame[] = [
  frame("traceRender", app("debug/trace.ts"), 4, 11),
  frame("useProjectBoard", app("features/board/useProjectBoard.ts"), 88, 5),
  frame("ProjectBoard", app("features/board/ProjectBoard.tsx"), 31, 17),
  frame("renderWithHooks", dep("chunk-RPCDYKBN.js"), 11548, 26),
  frame("mountIndeterminateComponent", dep("chunk-RPCDYKBN.js"), 14926, 21),
  frame("beginWork", dep("chunk-RPCDYKBN.js"), 15914, 22),
  frame("beginWork$1", dep("chunk-RPCDYKBN.js"), 19753, 22),
  frame("performUnitOfWork", dep("chunk-RPCDYKBN.js"), 19198, 20),
  frame("workLoopSync", dep("chunk-RPCDYKBN.js"), 19137, 13),
  frame("renderRootSync", dep("chunk-RPCDYKBN.js"), 19116, 15),
  frame("performConcurrentWorkOnRoot", dep("chunk-RPCDYKBN.js"), 18678, 83),
  frame("workLoop", dep("chunk-RPCDYKBN.js"), 197, 42),
  frame("flushWork", dep("chunk-RPCDYKBN.js"), 176, 22),
  frame("performWorkUntilDeadline", dep("chunk-RPCDYKBN.js"), 384, 29),
];

const NATIVE_FRAMES: CdpStackFrame[] = [
  frame("JSON.parse", "", 0, 0),
  frame("readSession", app("lib/session/storage.ts"), 27, 17),
  frame("eval", "", 1, 1),
  frame("", app("lib/session/storage.ts"), 61, 7),
];

const LONG_URL_FRAMES: CdpStackFrame[] = [
  frame(
    "validateShippingAddressForRegion",
    app("features/checkout/shipping/validation/validateShippingAddressForRegion.ts"),
    133,
    27
  ),
  frame(
    "ShippingAddressForm.handleSubmit",
    app("features/checkout/shipping/components/ShippingAddressForm.tsx"),
    204,
    9
  ),
  frame("callCallback2", dep("chunk-RPCDYKBN.js"), 3674, 22),
  frame("invokeGuardedCallbackImpl", dep("chunk-RPCDYKBN.js"), 3699, 24),
];

type Row = Omit<SerializedConsoleRow, "id" | "paneId" | "navigationGeneration" | "groupDepth">;

const str = (value: string) => ({ type: "primitive" as const, kind: "string" as const, value });

function uncaught(message: string, frames: CdpStackFrame[]): Row {
  // CDP's exception description carries V8's own rendering of the stack after
  // the message line, exactly as `handleExceptionThrown` passes it through.
  // V8's own spellings: a native frame has no location, an unnamed one has no name.
  const tail = frames
    .map((f) => {
      const where = f.url ? `${f.url}:${f.lineNumber}:${f.columnNumber}` : "<anonymous>";
      return f.functionName ? `    at ${f.functionName} (${where})` : `    at ${where}`;
    })
    .join("\n");
  return {
    level: "error",
    cdpType: "error",
    args: [],
    summaryText: `${message}\n${tail}`,
    stackTrace: { callFrames: frames },
    timestamp: 0,
  };
}

const ROW_BOOT: Row = {
  level: "log",
  cdpType: "log",
  args: [str("[vite] connected.")],
  summaryText: "[vite] connected.",
  stackTrace: { callFrames: [frame("", dep("vite_client.js"), 849, 9)] },
  timestamp: 0,
};
const ROW_LOG: Row = {
  level: "log",
  cdpType: "log",
  args: [str("Hydrated 24 orders in 38ms")],
  summaryText: "Hydrated 24 orders in 38ms",
  stackTrace: { callFrames: LOG_FRAMES },
  timestamp: 0,
};
const ROW_WARN: Row = {
  level: "warning",
  cdpType: "warning",
  args: [str('Each child in a list should have a unique "key" prop.')],
  summaryText: 'Each child in a list should have a unique "key" prop.',
  stackTrace: { callFrames: CART_FRAMES.slice(1) },
  timestamp: 0,
};
const ROW_FETCH: Row = {
  level: "error",
  cdpType: "error",
  args: [str("Failed to load orders:"), str("TypeError: Failed to fetch")],
  summaryText: "Failed to load orders: TypeError: Failed to fetch",
  stackTrace: { callFrames: FETCH_FRAMES },
  timestamp: 0,
};
const ROW_NETWORK: Row = {
  level: "error",
  cdpType: "log-entry",
  args: [],
  summaryText: "Failed to load resource: the server responded with a status of 404 (Not Found)",
  timestamp: 0,
  category: "network",
};
const ROW_UNCAUGHT = uncaught(
  "TypeError: Cannot read properties of undefined (reading 'price')",
  CART_FRAMES
);
const ROW_TRACE: Row = {
  level: "log",
  cdpType: "trace",
  args: [str("board render")],
  summaryText: "board render",
  stackTrace: { callFrames: DEEP_FRAMES },
  timestamp: 0,
};
const ROW_NATIVE = uncaught(
  `SyntaxError: Unexpected token 'u', "undefined" is not valid JSON`,
  NATIVE_FRAMES
);
const ROW_LONG = uncaught(
  "RangeError: Postcode 'SW1A 1AA' is not valid for region 'AU'",
  LONG_URL_FRAMES
);

export interface ConsoleStackFixture {
  /** Drawer width in CSS px. A docked or split pane runs anywhere from ~420 to ~1200. */
  width: number;
  height: number;
  rows: Row[];
  /**
   * Indexes into `rows` whose stack trace the spec expands with a real click,
   * in order. Expansion is local component state, so no fixture can hold it.
   */
  expand?: number[];
  /** A pointer or keyboard drive the spec performs after expansion. */
  drive?: "keyboard-focus" | "hover-toggle";
}

const SESSION: Row[] = [ROW_BOOT, ROW_LOG, ROW_WARN, ROW_FETCH, ROW_NETWORK, ROW_UNCAUGHT];

export const CONSOLE_FIXTURES = {
  "session-collapsed": { width: 900, height: 360, rows: SESSION },
  "uncaught-expanded": { width: 900, height: 520, rows: [ROW_LOG, ROW_UNCAUGHT], expand: [1] },
  "warning-expanded": { width: 900, height: 420, rows: SESSION, expand: [2] },
  "log-expanded": { width: 900, height: 360, rows: SESSION, expand: [3] },
  "trace-deep": { width: 900, height: 520, rows: [ROW_BOOT, ROW_TRACE], expand: [1] },
  "native-frames": { width: 900, height: 360, rows: [ROW_BOOT, ROW_NATIVE], expand: [1] },
  "narrow-long-urls": { width: 460, height: 520, rows: [ROW_LOG, ROW_LONG], expand: [1] },
  "keyboard-focus": { width: 900, height: 360, rows: SESSION, drive: "keyboard-focus" },
  "hover-toggle": { width: 900, height: 360, rows: SESSION, drive: "hover-toggle" },
} satisfies Record<string, ConsoleStackFixture>;

export type ConsoleFixtureName = keyof typeof CONSOLE_FIXTURES;
export const CONSOLE_FIXTURE_NAMES = Object.keys(CONSOLE_FIXTURES).filter(isConsoleFixtureName);

export function isConsoleFixtureName(value: string): value is ConsoleFixtureName {
  return Object.prototype.hasOwnProperty.call(CONSOLE_FIXTURES, value);
}
