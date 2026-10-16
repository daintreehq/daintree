// The app registers its Trusted Types policies at boot (main.tsx); the dev CSP
// stamped on this entry enforces them, and the Select's module graph has sinks.
import "@/lib/trustedTypesPolicy";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type {
  HostListeningPort,
  PortForward,
  PortForwardsEvent,
} from "@shared/types/ipc/portForwards";
import { PortsView } from "../PortsView";
import "@/index.css";

/**
 * Visual-review harness for the Ports section of the hosts overview: the real
 * `PortsView` against seeded hosts, forwards and scan results, inside a frame
 * the width of the overview dialog's body.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=<name>             one of PORTS_STATES below
 *   ?width=976                frame width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "976");
const stateName = params.get("state") ?? "several-hosts";

const LONG_NAME = "gregs-macbook-pro-16-inch-2024-office-upstairs";

const host = (id: string, name: string, connected = true): HostListEntry => ({
  descriptor: {
    id,
    name,
    connection: { kind: "ssh", target: name },
    platform: "darwin",
    arch: "arm64",
    lastHandshake: null,
    lastSeenAt: Date.now(),
    addedAt: 1,
    notificationsEnabled: false,
    assistantMessagingEnabled: false,
    assistantStartEnabled: false,
  },
  connection: connected
    ? {
        status: "connected",
        rttMs: 12,
        handshake: {
          version: "0.43.0",
          commit: "preview",
          protocolVersion: 1,
          platform: "darwin",
          arch: "arm64",
        },
      }
    : { status: "disconnected" },
  summary: null,
});

const STUDIO = host("studio-01", "studio-01");
const BUILD = host("build-box", "build-box");
const LONG = host("long-host", LONG_NAME);
const OFFLINE = host("office-laptop", "office-laptop", false);

let forwardSeq = 0;
const fwd = (
  hostId: string,
  remotePort: number,
  origin: PortForward["origin"],
  extra: Partial<PortForward> = {}
): PortForward => ({
  forwardId: `f${++forwardSeq}`,
  hostId,
  remotePort,
  localPort: remotePort,
  origin,
  label: null,
  createdAt: forwardSeq,
  ...extra,
});

const STUDIO_PORTS: HostListeningPort[] = [
  { port: 5173, processName: "node", pid: 101 },
  { port: 9229, processName: "node", pid: 102 },
  { port: 3000, processName: "ruby", pid: 103 },
  { port: 6006, processName: "storybook-dev-server", pid: 104 },
];

type Outcome = "ok" | "pending" | "error";

interface PortsState {
  hosts: HostListEntry[];
  forwards: PortForward[];
  preferred?: string;
  scan: HostListeningPort[] | "pending" | "error";
  forward?: Outcome;
  stop?: Outcome;
  /** Drop this host's connection shortly after mount. */
  drop?: string;
}

const SEVERAL_FORWARDS = [
  fwd("studio-01", 5173, "dev-preview", { label: "Dev preview" }),
  fwd("build-box", 5173, "dev-preview", { localPort: 5174 }),
  fwd("studio-01", 8080, "manual"),
  fwd("long-host", 54545, "oauth-callback", { localPort: 61234, label: "Claude sign-in" }),
  fwd("build-box", 3000, "detected"),
];

const PORTS_STATES: Record<string, PortsState> = {
  "no-hosts": { hosts: [], forwards: [], scan: [] },
  "one-host-empty": { hosts: [STUDIO], forwards: [], preferred: "studio-01", scan: STUDIO_PORTS },
  "one-host": {
    hosts: [STUDIO],
    forwards: [fwd("studio-01", 5173, "dev-preview"), fwd("studio-01", 8080, "manual")],
    preferred: "studio-01",
    scan: STUDIO_PORTS,
  },
  "several-hosts": {
    hosts: [STUDIO, BUILD, LONG, OFFLINE],
    forwards: SEVERAL_FORWARDS,
    preferred: "studio-01",
    scan: STUDIO_PORTS,
  },
  "long-names": {
    hosts: [STUDIO, LONG],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "build-box"),
    preferred: "long-host",
    scan: [
      { port: 4321, processName: "astro-dev-server-with-a-very-long-process-name", pid: 7 },
      { port: 8787, processName: null, pid: null },
    ],
  },
  scanning: {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: "pending",
  },
  "scan-error": {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: "error",
  },
  "nothing-listening": {
    hosts: [STUDIO],
    forwards: [fwd("studio-01", 5173, "dev-preview")],
    preferred: "studio-01",
    scan: [{ port: 5173, processName: "node", pid: 101 }],
  },
  "host-dropped": {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: STUDIO_PORTS,
    drop: "studio-01",
  },
  "forward-pending": {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: STUDIO_PORTS,
    forward: "pending",
  },
  "forward-error": {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: STUDIO_PORTS,
    forward: "error",
  },
  "stop-pending": {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: STUDIO_PORTS,
    stop: "pending",
  },
  "stop-error": {
    hosts: [STUDIO, BUILD],
    forwards: SEVERAL_FORWARDS.filter((f) => f.hostId !== "long-host"),
    preferred: "studio-01",
    scan: STUDIO_PORTS,
    stop: "error",
  },
};

const requested = PORTS_STATES[stateName];
if (!requested) throw new Error(`unknown state "${stateName}"`);
const state: PortsState = requested;

const never = <T,>() => new Promise<T>(() => undefined);
const fail = (message: string) => Promise.reject(new Error(message));

let hosts = state.hosts;
let forwards = state.forwards;
const hostListeners = new Set<(event: RemoteHostsEvent) => void>();
const forwardListeners = new Set<(event: PortForwardsEvent) => void>();
const publishForwards = () => {
  for (const listener of forwardListeners) listener({ type: "changed", forwards });
};

installPreviewShims({
  remoteHosts: {
    list: async () => hosts,
    onEvent: (listener: (event: RemoteHostsEvent) => void) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
  },
  hostMetrics: { onEvent: () => () => undefined },
  portForwards: {
    list: async () => forwards,
    onEvent: (listener: (event: PortForwardsEvent) => void) => {
      forwardListeners.add(listener);
      return () => forwardListeners.delete(listener);
    },
    listHostPorts: () =>
      state.scan === "pending"
        ? never()
        : state.scan === "error"
          ? fail("studio-01 didn't answer the port scan in time")
          : Promise.resolve(state.scan),
    forward: (payload: { hostId: string; remotePort: number; origin: PortForward["origin"] }) => {
      if (state.forward === "pending") return never();
      if (state.forward === "error") {
        return fail(`Port ${payload.remotePort} is already in use on this machine`);
      }
      const created = fwd(payload.hostId, payload.remotePort, payload.origin);
      forwards = [...forwards, created];
      publishForwards();
      return Promise.resolve(created);
    },
    stop: ({ forwardId }: { forwardId: string }) => {
      if (state.stop === "pending") return never();
      if (state.stop === "error") return fail("The tunnel to studio-01 closed unexpectedly");
      forwards = forwards.filter((f) => f.forwardId !== forwardId);
      publishForwards();
      return Promise.resolve();
    },
  },
});

// Long enough for the first render to settle before the host drops mid-session.
const HOST_DROP_DELAY_MS = 150;

if (state.drop) {
  const dropId = state.drop;
  setTimeout(() => {
    hosts = hosts.map((h) =>
      h.descriptor.id === dropId ? { ...h, connection: { status: "disconnected" } } : h
    );
    for (const listener of hostListeners) {
      listener({
        type: "connection-changed",
        hostId: dropId,
        connection: { status: "disconnected" },
      } as RemoteHostsEvent);
    }
  }, HOST_DROP_DELAY_MS);
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

function Shell() {
  return (
    <div style={{ width, padding: 16 }}>
      <div
        data-preview-shell
        className="rounded-[var(--radius-xl)] border border-border-default bg-surface-dialog px-6 py-5"
      >
        <PortsView hostId={state.preferred} />
      </div>
    </div>
  );
}

await primeRadix();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Shell />
    </TooltipProvider>
  </StrictMode>
);
