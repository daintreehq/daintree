import "@/lib/trustedTypesPolicy";
import type { DevPreviewDiagnosticsResult } from "@shared/types/ipc/devPreview";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LOGS, LOG_SOURCES } from "@/components/Diagnostics/__preview__/diagnosticsFixtures";

/** A thenable function: awaitable as a request, callable as an unsubscribe. */
function inert(value?: unknown): unknown {
  const settled = Promise.resolve(value);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function ns(methods: Record<string, (...args: never[]) => unknown>): unknown {
  return new Proxy(methods, {
    get: (target, key) => (typeof key === "string" && key in target ? target[key] : () => inert()),
  });
}

const params = new URLSearchParams(window.location.search);
const diagnosticsMode = params.get("diag") ?? "ok";
const T0 = new Date(2026, 8, 24, 14, 32, 7).getTime();

const DIAGNOSTICS: DevPreviewDiagnosticsResult = {
  session: {
    panelId: "dev-preview-twins",
    projectId: "acme",
    status: "running",
    generation: 3,
    updatedAt: T0,
    allocatedPort: 5173,
    detectedUrl: "http://localhost:5173/",
    upstream: { kind: "ok", port: 5173, isHttps: false },
    crashLoop: { count: 0, stopped: false, backoffPending: false },
    restoredFromManifest: false,
    events: [
      { type: "ensure-requested", configChanged: false, at: T0, seq: 1, generation: 3 },
      { type: "port-allocated", port: 5173, at: T0 + 40, seq: 2, generation: 3 },
      { type: "spawned", terminalId: "t1", port: 5173, at: T0 + 90, seq: 3, generation: 3 },
      { type: "first-output", at: T0 + 610, seq: 4, generation: 3 },
      {
        type: "url-detected",
        url: "http://localhost:5173/",
        at: T0 + 1_240,
        seq: 5,
        generation: 3,
      },
      {
        type: "readiness-probe-succeeded",
        url: "http://localhost:5173/",
        at: T0 + 1_510,
        seq: 6,
        generation: 3,
      },
      {
        type: "proxy-502",
        cause: "upstream-refused",
        code: "ECONNREFUSED",
        at: T0 + 9_800,
        seq: 7,
        generation: 3,
        count: 4,
      },
    ],
  },
  proxy: { port: 47113, usedPortFallback: false },
};

// Imported before any store module, so the bridge is on `window` first.
installPreviewShims({
  webview: ns({
    getConsoleProperties: () => Promise.resolve({ properties: [] }),
    clearConsoleCapture: () => Promise.resolve(),
  }),
  devPreview: ns({
    getDiagnostics: () =>
      diagnosticsMode === "failed"
        ? Promise.reject(new Error("bridge unavailable"))
        : Promise.resolve(DIAGNOSTICS),
  }),
  logs: ns({
    getAll: () => Promise.resolve(LOGS),
    getSources: () => Promise.resolve(LOG_SOURCES),
    onBatch: () => () => undefined,
    onEntry: () => () => undefined,
  }),
  app: ns({
    getState: () => Promise.resolve({}),
    getVersion: () => Promise.resolve("0.9.2"),
  }),
});

try {
  localStorage.clear();
} catch {
  // storage unavailable — nothing persisted to clear
}
