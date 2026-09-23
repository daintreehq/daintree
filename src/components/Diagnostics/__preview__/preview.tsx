import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store/errorStore";
import { useLogsStore } from "@/store/logsStore";
import { useEventStore } from "@/store/eventStore";
import { useTelemetryPreviewStore } from "@/store/telemetryPreviewStore";
import { usePerfMetricsStore } from "@/store/perfMetricsStore";
import { useProjectStore } from "@/store/projectStore";
import { DIAGNOSTICS_FIXTURES, LOG_SOURCES, type DiagnosticsFixture } from "./diagnosticsFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the diagnostics dock's tabs and content.
 *
 * Renders the real `DiagnosticsDock` from fixtures, pushed through the real
 * stores and the real bridge method names each tab reads, against the real
 * theme tokens and `index.css`. The block above the dock is harness decoration
 * standing in for the panel grid, so the dock sits at the height it has in the
 * app.
 *
 * Query parameters:
 *   ?fixture=problems-populated   a key of DIAGNOSTICS_FIXTURES
 *   ?theme=daintree|bondi|…       built-in theme id
 *   ?height=256                   dock height in CSS px
 *   ?width=1200                   window width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "1200");
const dockHeight = Number(params.get("height") ?? "256");
const fixtureName = params.get("fixture") ?? "problems-populated";
const fixture: DiagnosticsFixture | undefined = DIAGNOSTICS_FIXTURES[fixtureName];
if (!fixture) throw new Error(`unknown diagnostics fixture "${fixtureName}"`);

try {
  localStorage.clear();
} catch {
  // storage unavailable — nothing persisted to clear
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

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

const whySlow = fixture.whySlow;
let firstWhySlowCallAt: number | undefined;

installPreviewShims({
  logs: ns({
    getAll: () => Promise.resolve(fixture.logs ?? []),
    getSources: () => Promise.resolve(fixture.logs?.length ? LOG_SOURCES : []),
    onBatch: () => () => undefined,
    onEntry: () => () => undefined,
  }),
  eventInspector: ns({
    getEvents: () => Promise.resolve(fixture.events ?? []),
    onEventBatch: () => () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  }),
  telemetry: {
    preview: ns({
      getState: () => Promise.resolve({ active: fixture.telemetryActive ?? false }),
      onEventBatch: () => () => undefined,
      onStateChanged: () => () => undefined,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    }),
  },
  system: ns({
    getWhySlowSnapshot: () => {
      if (!whySlow) return new Promise(() => undefined);
      switch (whySlow.kind) {
        case "ok":
          return Promise.resolve({ ...whySlow.snapshot });
        case "fail":
          return Promise.reject(new Error("collector unavailable"));
        case "pending":
          return new Promise(() => undefined);
        case "stale":
          // Succeed for the mount-time reads (StrictMode makes more than one),
          // fail every refresh after that.
          firstWhySlowCallAt ??= performance.now();
          return performance.now() - firstWhySlowCallAt < 2_000
            ? Promise.resolve({ ...whySlow.snapshot })
            : Promise.reject(new Error("collector unavailable"));
      }
    },
  }),
  app: ns({
    getState: () => Promise.resolve({}),
    getVersion: () => Promise.resolve("0.9.2"),
  }),
});

function seed(f: DiagnosticsFixture) {
  useDiagnosticsStore.setState({
    isOpen: true,
    activeTab: f.tab,
    height: dockHeight,
    maxHeight: 2000,
  });
  useErrorStore.setState({ errors: f.errors ?? [] });
  if (f.logFilters) useLogsStore.setState({ filters: f.logFilters });
  if (f.expandLogId) useLogsStore.setState({ expandedIds: new Set([f.expandLogId]) });
  if (f.selectedEventId) useEventStore.setState({ selectedEventId: f.selectedEventId });
  useTelemetryPreviewStore.setState({
    active: f.telemetryActive ?? false,
    events: f.telemetry ?? [],
    selectedEventId: f.selectedTelemetryId ?? null,
  });

  const perf = f.perf;
  if (perf && perf.kind !== "no-project") {
    useProjectStore.setState({
      currentProject: {
        id: "acme",
        path: "/Users/dev/acme",
        name: "acme-web",
        emoji: "🌲",
        lastOpened: Date.now(),
      },
    });
  }
  usePerfMetricsStore.setState({
    // The live tiles read a real rAF loop; pin them so every capture agrees.
    setLiveMetrics: () => undefined,
    setBackgrounded: () => undefined,
    fps: f.live?.fps ?? null,
    lafCount30s: f.live?.lafCount30s ?? 0,
    cls30s: f.live?.cls30s ?? 0,
    refreshSummaries: async () => {
      if (!perf) return;
      usePerfMetricsStore.setState({
        isLoadingSummaries: false,
        lastLoadedAt: Date.now() - 42_000,
        summaryRows: perf.kind === "rows" ? perf.rows : [],
        summaryLoadError: perf.kind === "error" ? perf.message : null,
      });
    },
  });
}

seed(fixture);

const { DiagnosticsDock } = await import("../DiagnosticsDock");

// The dock caps itself at half its parent's height, so the stand-in grid above
// it must be at least as tall as the dock or the requested height gets clamped.
function Harness() {
  return (
    <div
      data-preview-shell
      className="flex flex-col"
      style={{ width: `${width}px`, height: `${dockHeight * 2 + 40}px` }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex-1 min-h-0 border-b border-divider bg-surface-canvas p-3"
      >
        <div className="h-full rounded-[var(--radius-md)] border border-divider bg-surface-panel" />
      </div>
      {/* The app always wires these, and Retry/Cancel only render when they exist. */}
      <DiagnosticsDock onRetry={() => undefined} onCancelRetry={() => undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
