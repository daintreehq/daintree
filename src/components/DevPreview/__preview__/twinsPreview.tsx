import "./twinsShims";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { flushConsoleCaptureBuffer, useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useErrorStore } from "@/store/errorStore";
import type { DevPreviewStatus } from "@/hooks/useDevServer";
import { PROBLEMS } from "@/components/Diagnostics/__preview__/diagnosticsFixtures";
import { CONSOLE_FIXTURES } from "./consoleFixtures";
import type { ConsoleDrawerTab } from "../ConsoleDrawer";
import "@/index.css";

/**
 * Standalone visual-review harness for the two bottom drawers that share one
 * job: the dev preview's output drawer and the app's diagnostics dock. Mounts
 * the REAL `ConsoleDrawer` (with its real `ConsolePanel` and `DiagnosticsPanel`)
 * and the REAL `DiagnosticsDock`, fed through the real console ingest, the real
 * error store and the bridge method names each tab reads.
 *
 * Query parameters:
 *   ?scene=drawer|dock|twins   which drawer; twins stacks both at one width
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?tab=output|console|diagnostics   the drawer's tab (drawer, twins)
 *   ?dockTab=problems|logs     the dock's tab (dock, twins)
 *   ?open=0                    drawer collapsed
 *   ?status=running|starting|stopped|…   dev server status
 *   ?restarting=1              drawer mid-restart (restart controls disabled)
 *   ?diag=failed               the diagnostics query rejects
 *   ?width=900                 frame width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const scene = params.get("scene") ?? "twins";
const themeId = params.get("theme") ?? "daintree";
const DRAWER_TABS: readonly ConsoleDrawerTab[] = ["output", "console", "diagnostics"];
const STATUSES: readonly DevPreviewStatus[] = [
  "stopped",
  "starting",
  "installing",
  "running",
  "stopping",
  "error",
  "restored-stopped",
];
const pickOne = <T extends string>(options: readonly T[], raw: string | null, fallback: T): T =>
  options.find((option) => option === raw) ?? fallback;
const tab = pickOne(DRAWER_TABS, params.get("tab"), "console");
const dockTab = pickOne(["problems", "logs"] as const, params.get("dockTab"), "problems");
const open = params.get("open") !== "0";
const status = pickOne(STATUSES, params.get("status"), "running");
const restarting = params.get("restarting") === "1";
const width = Number(params.get("width") ?? "900");

const PANE_ID = "dev-preview-twins";
const TERMINAL_ID = "dev-preview-twins-terminal";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function seedConsole(): void {
  const base = new Date(2026, 8, 24, 14, 32, 7, 118).getTime();
  const { addStructuredMessage } = useConsoleCaptureStore.getState();
  CONSOLE_FIXTURES["session-collapsed"].rows.forEach((row, i) => {
    addStructuredMessage({
      ...row,
      id: i + 1,
      paneId: PANE_ID,
      groupDepth: 0,
      navigationGeneration: 0,
      timestamp: base + i * 1_437,
    });
  });
  flushConsoleCaptureBuffer();
}

seedConsole();
useErrorStore.setState({ errors: PROBLEMS });
useDiagnosticsStore.setState({ isOpen: true, activeTab: dockTab, height: 280, maxHeight: 2000 });

await primeRadix();
const { ConsoleDrawer } = await import("../ConsoleDrawer");
const { DiagnosticsDock } = await import("@/components/Diagnostics/DiagnosticsDock");

function DrawerFrame() {
  const [isOpen, setIsOpen] = useState(open);
  const [activeTab, setActiveTab] = useState<ConsoleDrawerTab>(tab);
  const noop = () => undefined;
  return (
    <div
      data-scene="drawer"
      className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
      style={{ width, height: 420 }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="min-h-0 flex-1 bg-surface-canvas"
      />
      <ConsoleDrawer
        terminalId={TERMINAL_ID}
        paneId={PANE_ID}
        projectId="acme"
        webContentsId={1}
        status={status}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isRestarting={restarting}
        onReloadPreview={noop}
        onRestartDevServer={noop}
        onRequestRestartAndClearCache={noop}
        onRequestReinstallAndRestart={noop}
        onStop={noop}
      />
    </div>
  );
}

function DockFrame() {
  return (
    <div data-scene="dock" className="flex flex-col" style={{ width, height: 600 }}>
      <div
        data-harness-decoration
        aria-hidden="true"
        className="min-h-0 flex-1 border-b border-divider bg-surface-canvas"
      />
      <DiagnosticsDock onRetry={() => undefined} onCancelRetry={() => undefined} />
    </div>
  );
}

function Harness() {
  return (
    <div className="flex flex-col gap-4 p-3">
      {(scene === "drawer" || scene === "twins") && <DrawerFrame />}
      {(scene === "dock" || scene === "twins") && <DockFrame />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={0}>
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
