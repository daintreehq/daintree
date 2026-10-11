import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import { DriveLeaseBanner } from "@/components/Recovery/DriveLeaseBanner";
import { seedDriveLeaseView } from "@/components/Recovery/driveLeaseState";
import {
  ControlConfirmedBanner,
  TerminalInputBlockBanner,
} from "@/components/Terminal/TerminalInputBlockBanner";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useProjectStore } from "@/store/projectStore";
import type { TerminalInputBlock } from "@/services/terminal/inputGate";
import type { AttachedClientInfo, HostModeStatus } from "@shared/types/ipc/hostMode";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { AttachedMachinesIndicator } from "../AttachedMachinesIndicator";
import "@/index.css";

/**
 * Visual-review harness for who is using a project from where: the in-use
 * pill on the host's own screen, the window's control banner, and the pane's
 * read-only strip. The real components against seeded host-mode status and
 * drive lease; the toolbar around them and the pane body are decoration.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=<name>             one of PRESENCE_STATES below
 *   ?width=1100               window width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "1100");
const stateName = params.get("state") ?? "host-taken";

const THIS_PROJECT = "project-daintree";
const OTHER_PROJECT = "project-pagesugar";
const minutesAgo = (n: number) => Date.now() - n * 60_000;

interface PresenceState {
  /** A window on the host's own screen, or a client window showing a remote host. */
  side: "host" | "client";
  attached: AttachedClientInfo[];
  lease: DriveLeaseView | null;
  paneBlock: TerminalInputBlock | null;
  /** The pane control just arrived in, showing its brief confirmation. */
  paneConfirmed?: boolean;
}

const laptop = (driving: string[] = []): AttachedClientInfo => ({
  clientId: "client-greg-mbp",
  clientName: "greg-mbp",
  connectedAt: minutesAgo(42),
  drivingProjectIds: driving,
});
const office = (driving: string[] = []): AttachedClientInfo => ({
  clientId: "client-office",
  clientName: "office-laptop",
  connectedAt: minutesAgo(5),
  drivingProjectIds: driving,
});

function lease(holder: { name: string; hostLocal: boolean } | null, viewerIsHostLocal: boolean) {
  return {
    projectId: THIS_PROJECT,
    holder: holder && {
      leaseId: 7,
      endpointId: "endpoint-1",
      clientId: holder.hostLocal ? "host-local" : `client-${holder.name}`,
      clientName: holder.name,
      isHostLocal: holder.hostLocal,
      acquiredAt: minutesAgo(3),
    },
    drivingHere: holder === null,
    isHolderEndpoint: false,
    viewerIsHostLocal,
  } satisfies DriveLeaseView;
}

export const PRESENCE_STATES: Record<string, PresenceState> = {
  /** Connected, nothing controlled: the laptop is only looking. */
  "host-connected": {
    side: "host",
    attached: [laptop()],
    lease: lease(null, true),
    paneBlock: null,
  },
  /** The laptop controls a different project; this one is still the host's. */
  "host-other-project": {
    side: "host",
    attached: [laptop([OTHER_PROJECT])],
    lease: lease(null, true),
    paneBlock: null,
  },
  /** The laptop controls the project this window shows. */
  "host-taken": {
    side: "host",
    attached: [laptop([THIS_PROJECT])],
    lease: lease({ name: "greg-mbp", hostLocal: false }, true),
    paneBlock: {
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
      projectId: THIS_PROJECT,
      hostLocal: true,
      driverIsHostScreen: false,
    },
  },
  /** Two machines: one controls this project, one is only connected. */
  "host-taken-two": {
    side: "host",
    attached: [laptop([THIS_PROJECT, OTHER_PROJECT]), office()],
    lease: lease({ name: "greg-mbp", hostLocal: false }, true),
    paneBlock: {
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
      projectId: THIS_PROJECT,
      hostLocal: true,
      driverIsHostScreen: false,
    },
  },
  /** Control just taken back on the host's screen: the pane says so for a moment. */
  "host-control-confirmed": {
    side: "host",
    attached: [laptop()],
    lease: lease(null, true),
    paneBlock: null,
    paneConfirmed: true,
  },
  /** A long machine name: the pill keeps its state, the banner title wraps rather than overflow. */
  "host-long-name": {
    side: "host",
    attached: [
      {
        clientId: "client-long",
        clientName: "gregs-macbook-pro-16-inch-2024-office",
        connectedAt: minutesAgo(12),
        drivingProjectIds: [THIS_PROJECT],
      },
    ],
    lease: lease({ name: "gregs-macbook-pro-16-inch-2024-office", hostLocal: false }, true),
    paneBlock: {
      kind: "driven-elsewhere",
      driverName: "gregs-macbook-pro-16-inch-2024-office",
      projectId: THIS_PROJECT,
      hostLocal: true,
      driverIsHostScreen: false,
    },
  },
  /** A client window on studio-01; another client controls the project. */
  "client-other-client": {
    side: "client",
    attached: [],
    lease: lease({ name: "office-laptop", hostLocal: false }, false),
    paneBlock: {
      kind: "driven-elsewhere",
      driverName: "office-laptop",
      projectId: THIS_PROJECT,
      hostLocal: false,
      driverIsHostScreen: false,
    },
  },
  /** A client window on studio-01; studio-01's own screen controls the project. */
  "client-host-screen": {
    side: "client",
    attached: [],
    lease: lease({ name: "studio-01", hostLocal: true }, false),
    paneBlock: {
      kind: "driven-elsewhere",
      driverName: "studio-01",
      projectId: THIS_PROJECT,
      hostLocal: false,
      driverIsHostScreen: true,
    },
  },
};

const state = PRESENCE_STATES[stateName];
if (!state) throw new Error(`unknown state "${stateName}"`);

const hostStatus: HostModeStatus = {
  supported: true,
  enabled: true,
  startAtLogin: true,
  socketPath: "/tmp/daintree-host.sock",
  listening: true,
  attachedClients: state.attached,
  rows: [],
};

installPreviewShims({
  hostMode: {
    getStatus: async () => hostStatus,
    onEvent: () => () => undefined,
  },
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

if (state.side === "client") {
  window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  useHostConnectionStore.setState({
    hostId: "studio-01",
    hostName: "studio-01",
    everConnected: true,
    connection: { status: "connected" },
  } as Parameters<typeof useHostConnectionStore.setState>[0]);
}
useProjectStore.setState({
  projects: [
    { id: THIS_PROJECT, name: "daintree" },
    { id: OTHER_PROJECT, name: "pagesugar" },
  ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
});
seedDriveLeaseView(state.lease);

function TrafficLights() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="pointer-events-none absolute z-10 flex gap-2"
      style={{ left: 13, top: 18 }}
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span key={color} className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}

/** The toolbar row: a stand-in project pill and host chip, then the real in-use pill. */
function Toolbar() {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider px-4 pt-1 surface-toolbar">
      <div data-harness-decoration aria-hidden="true" className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
        <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      </div>
      <div className="mx-auto flex items-center">
        <div
          data-harness-decoration
          aria-hidden="true"
          className="flex h-7 items-center rounded-[var(--radius-md)] bg-overlay-subtle px-3 text-xs text-text-primary"
        >
          daintree · develop
        </div>
        {state.side === "client" ? (
          <div
            data-harness-decoration
            aria-hidden="true"
            className="ml-1.5 flex h-8 items-center gap-2 rounded-[var(--radius-md)] bg-status-info px-2.5 text-sm [color:contrast-color(var(--color-status-info))]"
          >
            <span className="font-medium">SSH · studio-01</span>
            <span className="text-2xs">viewing</span>
          </div>
        ) : (
          <div
            data-harness-decoration
            aria-hidden="true"
            className="ml-1.5 flex h-7 items-center px-2 text-xs text-text-secondary"
          >
            This Mac
          </div>
        )}
        <AttachedMachinesIndicator />
      </div>
      <div data-harness-decoration aria-hidden="true" className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
        <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      </div>
    </div>
  );
}

/** One terminal pane, so the window-level banner and the pane's own strip are seen together. */
function Pane() {
  return (
    <div className="m-2 flex h-56 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-panel">
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs text-text-secondary"
      >
        Claude · feature/remote-hosts
      </div>
      {state.paneBlock && (
        <div data-pane-banner>
          <TerminalInputBlockBanner block={state.paneBlock} />
        </div>
      )}
      {state.paneConfirmed && (
        <div data-pane-banner>
          <ControlConfirmedBanner />
        </div>
      )}
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex-1 bg-surface-canvas p-3 font-mono text-xs text-text-secondary"
      >
        <div>✓ Ran 14 tests in remoteHosts/</div>
        <div>✓ Updated src/components/Hosts/HostChip.tsx</div>
        <div className="text-text-primary">Waiting for your next instruction</div>
      </div>
    </div>
  );
}

function Window() {
  return (
    <div data-preview-shell className="flex flex-col" style={{ width: `${width}px` }}>
      <div className="relative">
        <TrafficLights />
        <div data-banner-slot>
          <WindowControlsInsetProvider onSeverityChange={() => undefined}>
            <DriveLeaseBanner />
          </WindowControlsInsetProvider>
        </div>
      </div>
      <Toolbar />
      <Pane />
      <div className="h-40" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Window />
    </TooltipProvider>
  </StrictMode>
);
