import "./diagnosticsReviewShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import type { DiagnosticsReviewPayload } from "@shared/types/ipc/system";
import { DiagnosticsReviewDialogHost } from "../DiagnosticsReviewDialogHost";
import "@/index.css";

/**
 * Standalone visual-review harness for the diagnostics review dialog.
 *
 * In the app the dialog opens only after the main process has collected a full
 * report, which takes seconds and depends on the machine. This mounts the real
 * `DiagnosticsReviewDialogHost` and opens it the way `openReview` does — by
 * writing the collected payload into `useDiagnosticsReviewStore` — so the dialog
 * runs its real path against a report shaped like the collector's.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=default|no-update|rotated|scoped|saving
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = params.get("fixture") ?? "default";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const NOW = Date.now();
const MIN = 60 * 1000;

/** The collector's own section order (`collectDiagnosticsWithKeys`). */
const SECTION_KEYS = [
  "metadata",
  "runtime",
  "os",
  "display",
  "gpu",
  "process",
  "tools",
  "git",
  "config",
  "terminals",
  "flowControl",
  "lifecycleLedger",
  "mcpAudit",
  "projectViews",
  "rendererMemory",
  "memoryTrends",
  "memoryAttribution",
  "resourceState",
  "workerGovernance",
  "whySlow",
  "counts",
  "logs",
  "events",
];

/** Log lines carrying the things the redaction presets exist for. */
const LOG_ENTRIES = [
  {
    timestamp: NOW - 95 * MIN,
    level: "info",
    message: "Opened project /Users/alex.morgan/Code/acme-billing",
  },
  {
    timestamp: NOW - 42 * MIN,
    level: "warn",
    message: "git fetch failed for origin (git@github.com:acme/billing.git): timed out",
  },
  {
    timestamp: NOW - 18 * MIN,
    level: "error",
    message: "MCP client 10.0.4.17 rejected: bearer expired",
  },
  {
    timestamp: NOW - 11 * MIN,
    level: "info",
    message: "Signed in as alex.morgan@acme-corp.com",
  },
  {
    timestamp: NOW - 3 * MIN,
    level: "warn",
    message: "pty-host restarted after exit code 139 (/Users/alex.morgan/Code/acme-billing)",
  },
  {
    timestamp: NOW - 1 * MIN,
    level: "info",
    message: "ResizeObserver loop completed with undelivered notifications",
  },
];

function buildPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    metadata: { appVersion: "0.41.0", electronVersion: "42.0.1", generatedAt: NOW },
    runtime: { platform: "darwin", arch: "arm64", uptimeSeconds: 7_214 },
    os: { platform: "darwin", release: "25.4.0", hostname: "alexs-mbp.local" },
    display: [{ id: 1, scaleFactor: 2, size: { width: 1728, height: 1117 } }],
    gpu: { gpuDevice: [{ vendorId: 4203, deviceId: 0 }], featureStatus: { webgl: "enabled" } },
    process: { pid: 4121, memory: { rss: 412_880_896 }, cpuPercent: 6.2 },
    tools: { git: "2.47.1", node: "22.23.2", claude: "2.4.0", codex: "0.61.0" },
    git: { version: "2.47.1", path: "/opt/homebrew/bin/git" },
    config: { appTheme: "daintree", worktreePathPattern: "{parent-dir}/{base-folder}-worktrees" },
    terminals: { count: 9, agents: { claude: 4, codex: 3, gemini: 2 } },
    flowControl: { paused: 0, highWater: 3 },
    lifecycleLedger: { recent: 48 },
    mcpAudit: { calls: 212, errors: 3, p95Ms: 184 },
    projectViews: { live: 3, cached: 1 },
    rendererMemory: { heapUsedMb: 188 },
    memoryTrends: { samples: 60, slopeMbPerMin: 0.4 },
    memoryAttribution: { "acme-billing": 612, "acme-web": 301 },
    resourceState: { level: "normal" },
    workerGovernance: { active: 2, queued: 0 },
    whySlow: { resource: { level: "normal" }, pty: { active: 9 } },
    counts: { projects: 3, views: 4 },
    logs: { file: "/Users/alex.morgan/Library/Logs/Daintree/main.log", recentEntries: LOG_ENTRIES },
    events: { recent: 120 },
  };
  return payload;
}

function buildReview(): DiagnosticsReviewPayload {
  const base: DiagnosticsReviewPayload = {
    payload: buildPayload(),
    sectionKeys: SECTION_KEYS,
    previewJson: "",
    appLaunchTimestamp: NOW - 120 * MIN,
    versionFirstRun: { version: "0.41.0", firstRunAtMs: NOW - 3 * 24 * 60 * MIN },
    oldestRetainedLogMs: NOW - 5 * 24 * 60 * MIN,
  };
  switch (fixture) {
    case "no-update":
      return { ...base, versionFirstRun: null };
    case "rotated":
      // Rotation has already dropped logs written after the update.
      return { ...base, oldestRetainedLogMs: NOW - 24 * 60 * MIN };
    default:
      return base;
  }
}

useDiagnosticsReviewStore.setState({
  isOpen: true,
  isCollecting: false,
  isSaving: fixture === "saving",
  reviewPayload: buildReview(),
  scope:
    fixture === "scoped"
      ? { source: "why-slow", sections: ["whySlow", "memoryTrends", "logs"] }
      : null,
  requestSeq: 1,
});

/** Settings-shaped chrome behind the scrim, so the dialog is judged over the app. */
function BackdropSettings() {
  return (
    <div data-harness-decoration aria-hidden="true" className="flex h-screen bg-surface-canvas">
      <div className="w-56 shrink-0 border-r border-divider bg-surface-panel p-3 space-y-2">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="h-6 rounded-[var(--radius-sm)] bg-overlay-subtle" />
        ))}
      </div>
      <div className="flex-1 p-8 space-y-4">
        <div className="h-6 w-48 rounded-[var(--radius-sm)] bg-overlay-subtle" />
        <div className="h-24 rounded-[var(--radius-md)] border border-border-default bg-surface-panel" />
        <div className="h-24 rounded-[var(--radius-md)] border border-border-default bg-surface-panel" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell>
        <BackdropSettings />
        <DiagnosticsReviewDialogHost />
      </div>
    </TooltipProvider>
  </StrictMode>
);
