import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { LAUNCHABLE_AGENT_IDS } from "@shared/config/agentIds";
import type { Project } from "@shared/types";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { COMMITS_FIXTURES, listCommitsFrom, listPushCommitsFrom } from "./localCommitsFixtures";

// `?name=` lets a capture vary the project pill's width, which is what a
// width-proportional press effect would scale with.
const previewName = new URLSearchParams(window.location.search).get("name");

// `?host=<name>` makes this a window working on that host; `?hosts=1` keeps it
// local but with hosts added, which is what puts the host chip on the strip.
const previewHost = new URLSearchParams(window.location.search).get("host");
const previewHostsAdded =
  !!previewHost || !!new URLSearchParams(window.location.search).get("hosts");

const previewLink = new URLSearchParams(window.location.search).get("link") ?? "connected";
// `?fleet=macs` adds four Mac hosts beside this machine, every other one disconnected;
// `?fleet=mixed` gives them one of each link state, a refused build among them;
// `?fleet=long` names them the way a build farm does, differing only at the end.
const previewFleet = new URLSearchParams(window.location.search).get("fleet");

/** The window's own host answers with the link the toolbar is seeded with, so chip and menu agree. */
function previewConnection(current: boolean): HostListEntry["connection"] {
  if (!current) return { status: "disconnected" };
  const handshake = {
    version: "0.43.0",
    commit: "preview",
    protocolVersion: 1,
    platform: "linux" as const,
    arch: "x64" as const,
  };
  switch (previewLink) {
    case "connecting":
      return { status: "connecting", attempt: 2 };
    case "unreachable":
      return { status: "unreachable", lastSeenAt: 1_764_000_000_000, detail: null };
    case "disconnected":
      return { status: "disconnected" };
    case "quiet":
      return { status: "connected", rttMs: 12, handshake, quietSince: 1_764_000_000_000 };
    default:
      return { status: "connected", rttMs: 12, handshake };
  }
}

const FLEET_HANDSHAKE = {
  version: "0.42.0",
  commit: "preview",
  protocolVersion: 1,
  platform: "darwin" as const,
  arch: "arm64" as const,
};

/** The other hosts' links under `?fleet=mixed`, by name. */
const MIXED_LINKS: Record<string, HostListEntry["connection"]> = {
  "studio-01": { status: "connecting", attempt: 1 },
  "studio-03": { status: "unreachable", lastSeenAt: Date.now() - 3 * 3_600_000, detail: null },
  "studio-04": {
    status: "version-mismatch",
    mismatch: { kind: "version", local: "0.43.0", remote: "0.42.0" },
    remote: FLEET_HANDSHAKE,
  },
};

function previewHostEntry(name: string): HostListEntry {
  const current = name === previewHost;
  return {
    descriptor: {
      id: name,
      name,
      connection: { kind: "ssh", target: name },
      platform: previewFleet ? "darwin" : "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: 1_764_000_000_000,
      addedAt: 1_764_000_000_000,
      notificationsEnabled: false,
    },
    connection:
      !current && previewFleet === "mixed" && MIXED_LINKS[name]
        ? MIXED_LINKS[name]
        : previewConnection(current),
    summary: null,
  };
}

const FLEET =
  previewFleet === "long"
    ? [1, 2, 3, 4].map((n) => `gregs-mac-studio-build-east-0${n}`)
    : ["studio-01", "studio-02", "studio-03", "studio-04"];

export const PREVIEW_HOSTS: HostListEntry[] = !previewHostsAdded
  ? []
  : previewFleet
    ? FLEET.map(previewHostEntry)
    : [
        previewHostEntry(previewHost ?? "studio-01"),
        ...(previewHost === "build-east-02" ? [] : [previewHostEntry("build-east-02")]),
      ];

if (previewHost) window.__DAINTREE_HOST_ID__ = { id: previewHost };

export const PREVIEW_PROJECT: Project = {
  id: "proj-daintree",
  path: "/Users/greg/Projects/daintree",
  name: previewName || "Daintree",
  emoji: "\u{1F333}",
  lastOpened: 1_764_000_000_000,
};

// Imported first by `toolbar.tsx`, so the bridge shim and the platform override
// are both in place before any store module or the toolbar's first render.
// Only ever a harness: with a real bridge on the window this page is running
// inside the app, and clearing that origin's storage would clear the user's own
// persisted state.
const isHarness = !Reflect.get(window, "electron");

const withFallback = <T extends object>(target: T) =>
  new Proxy(target, {
    get: (t, key) => Reflect.get(t, key) ?? (async () => undefined),
  });

installPreviewShims({
  // Every agent already seen, so no first-run discovery dot sits on the launcher.
  onboarding: withFallback({
    get: async () => ({
      seenAgentIds: LAUNCHABLE_AGENT_IDS.slice(),
      availabilityFirstSeen: {},
      welcomeCardDismissed: true,
      setupBannerDismissed: true,
    }),
  }),
  // The toolbar and the real project-switcher hook load the project list and
  // the current project on mount; the inert shim would answer both with
  // `undefined`, which clears the pill and breaks the switcher's list.
  project: withFallback({
    getAll: async () => [PREVIEW_PROJECT],
    getCurrent: async () => PREVIEW_PROJECT,
    onSwitch: () => () => {},
  }),
  // Opening the switcher loads the scratch list; `undefined` from the inert
  // shim crashes its row builder and takes the page down with it.
  scratch: withFallback({
    getAll: async () => [],
    getCurrent: async () => null,
    onUpdated: () => () => {},
    onRemoved: () => () => {},
    onSwitch: () => () => {},
  }),
  // The commits pill opens a list of the branch's history.
  git: withFallback({
    listCommits: listCommitsFrom(COMMITS_FIXTURES.few!),
    listPushCommits: listPushCommitsFrom(COMMITS_FIXTURES.few!),
  }),
  // The copy-context menu reads its recents on open.
  copyTreeHistory: withFallback({ getRecords: async () => [] }),
  // The assistant button reads the MCP runtime snapshot on render; the inert
  // shim would hand it `undefined` and take the whole strip down with it.
  remoteHosts: withFallback({
    list: async () => PREVIEW_HOSTS,
    onEvent: () => () => {},
  }),
  hostMetrics: withFallback({ onEvent: () => () => {} }),
  mcpServer: withFallback({
    getRuntimeState: async () => ({ enabled: true, state: "ready", port: 0, lastError: null }),
    onRuntimeStateChanged: () => () => {},
  }),
});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}

// `isMac()`/`isWindows()` read `navigator.platform` on every call, so the
// override decides the strip's platform spacers and the Windows app menu button.
const platform = new URLSearchParams(window.location.search).get("platform") ?? "mac";
const navigatorPlatform = platform === "windows" ? "Win32" : "MacIntel";
Object.defineProperty(navigator, "platform", { get: () => navigatorPlatform });
