import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import type {
  HostDirectoryEntry,
  HostDirectoryListing,
  HostPickRequest,
  HostPickerRoots,
} from "@shared/types/ipc/hostFiles";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HostFilePickerDialog } from "../HostFilePickerDialog";
import "@/index.css";

/**
 * Visual-review harness for the host file picker: the real dialog over a
 * fixture filesystem served through the same bridge calls the app makes
 * (`hostSwitch.*` for another host, `hostFiles.*` for the window's own).
 *
 * Query parameters:
 *   ?theme=daintree|svalbard|…   built-in theme id
 *   ?scenario=<name>             one of SCENARIOS below
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const scenarioName = params.get("scenario") ?? "folder";

const HOME = "/home/greg";
const DEEP =
  "/home/greg/Projects/daintree/packages/plugin-sdk/src/testing/fixtures/remote-hosts/workspace-snapshots/2026-10-14-nightly";

const KB = 1024;
const dir = (name: string): HostDirectoryEntry => ({
  name,
  kind: "directory",
  size: null,
  mtimeMs: null,
});
const file = (name: string, size: number): HostDirectoryEntry => ({
  name,
  kind: "file",
  size,
  mtimeMs: null,
});
const link = (name: string): HostDirectoryEntry => ({
  name,
  kind: "symlink",
  size: null,
  mtimeMs: null,
});

const FS: Record<string, HostDirectoryEntry[]> = {
  "/": [dir("etc"), dir("home"), dir("opt"), dir("root"), dir("srv"), dir("usr"), dir("var")],
  "/home": [dir("greg")],
  [HOME]: [
    dir(".cache"),
    dir(".config"),
    dir("Documents"),
    dir("Downloads"),
    dir("Projects"),
    link("shared"),
    file(".bashrc", 3_771),
    file("notes.md", 12 * KB),
  ],
  [`${HOME}/Projects`]: [
    dir("daintree"),
    dir("daintree-assistant"),
    dir("empty-folder"),
    dir("pagesugar"),
    dir("infrastructure-migration-q4-2026-terraform-modules-and-runbooks"),
    dir("togoer-web"),
    link("scratch"),
    file("README.md", 2_140),
  ],
  [`${HOME}/Projects/empty-folder`]: [],
  [`${HOME}/Documents`]: [
    dir("Invoices"),
    file(
      "2026-10-14 quarterly infrastructure migration plan — final review copy v3.pdf",
      4_812_330
    ),
    file(
      "customer-onboarding-checklist-for-enterprise-accounts-with-single-sign-on-and-scim-provisioning.docx",
      88_120
    ),
    file("design-review-notes.md", 18_400),
    file("host-file-picker-screenshot-before-and-after-comparison-light-theme.png", 1_204_220),
    file("meeting-notes.txt", 2_051),
    file("README", 512),
    file("release-checklist.md", 6_330),
    file("very.long.dotted.name.with.many.segments.tar.gz", 51_200_000),
  ],
  [DEEP]: [dir("snapshots"), file("manifest.json", 3_204), file("workspace.sqlite", 9_437_184)],
};

// Every ancestor of the deep path lists its next segment, so Parent works all the way up.
{
  const parts = DEEP.split("/").filter(Boolean);
  for (let i = 3; i < parts.length; i++) {
    const at = `/${parts.slice(0, i).join("/")}`;
    if (!FS[at]) FS[at] = [dir(parts[i]!)];
  }
}

// A short, real delay so the loading states get a frame to show.
const LIST_LATENCY_MS = 30;
const SLOW = new Set([`${HOME}/Projects/pagesugar`]);
const DENIED = new Set(["/root"]);

function parentOf(path: string): string | null {
  if (path === "/") return null;
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function list(path: string, showHidden: boolean): Promise<HostDirectoryListing> {
  if (SLOW.has(path)) return new Promise(() => undefined);
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (DENIED.has(path)) {
        reject(new Error(`Permission denied: ${path}`));
        return;
      }
      const entries = FS[path];
      if (!entries) {
        reject(new Error(`No such folder: ${path}`));
        return;
      }
      const sorted = [...entries]
        .filter((e) => showHidden || !e.name.startsWith("."))
        .sort((a, b) => {
          const ad = a.kind === "directory" ? 0 : 1;
          const bd = b.kind === "directory" ? 0 : 1;
          return ad - bd || a.name.localeCompare(b.name);
        });
      resolve({ path, parent: parentOf(path), entries: sorted, truncated: false });
    }, LIST_LATENCY_MS);
  });
}

const roots: HostPickerRoots = {
  home: HOME,
  projectsDir: `${HOME}/Projects`,
  roots: [
    { label: "Home", path: HOME },
    { label: "Projects", path: `${HOME}/Projects` },
    { label: "/", path: "/" },
  ],
};

interface Scenario {
  request: HostPickRequest;
  /** The picker runs in a window attached to this host (no `hostId` on the request). */
  windowHost?: string;
}

const STUDIO = "studio-01";
const LONG_HOST = "gregs-build-server-ubuntu-2404.tail2c7e.ts.net";

export const SCENARIOS: Record<string, Scenario> = {
  folder: {
    request: {
      mode: "directory",
      title: `Choose where to clone on ${STUDIO}`,
      buttonLabel: "Clone here",
      hostId: STUDIO,
      defaultPath: `${HOME}/Projects`,
    },
  },
  "folder-default-label": {
    request: {
      mode: "directory",
      title: `Open a project folder on ${STUDIO}`,
      hostId: STUDIO,
      defaultPath: `${HOME}/Projects`,
    },
  },
  "folder-deep": {
    request: {
      mode: "directory",
      title: `Choose where to clone on ${LONG_HOST}`,
      buttonLabel: "Clone here",
      hostId: "long-host",
      defaultPath: DEEP,
    },
  },
  "folder-empty": {
    request: {
      mode: "directory",
      title: `Choose where to clone on ${STUDIO}`,
      buttonLabel: "Clone here",
      hostId: STUDIO,
      defaultPath: `${HOME}/Projects/empty-folder`,
    },
  },
  "folder-error": {
    request: {
      mode: "directory",
      title: `Choose where to clone on ${STUDIO}`,
      buttonLabel: "Clone here",
      hostId: STUDIO,
      defaultPath: "/root",
    },
  },
  file: {
    windowHost: STUDIO,
    request: {
      mode: "file",
      title: "Choose a file",
      defaultPath: `${HOME}/Documents`,
    },
  },
  "file-multi": {
    windowHost: STUDIO,
    request: {
      mode: "file",
      multiple: true,
      title: "Attach files",
      buttonLabel: "Attach",
      defaultPath: `${HOME}/Documents`,
    },
  },
};

const requested = SCENARIOS[scenarioName];
if (!requested) throw new Error(`unknown scenario "${scenarioName}"`);
const scenario: Scenario = requested;

const PREVIEW_HANDSHAKE = {
  version: "0.0.0-preview",
  commit: "preview",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;

const hostEntry = (id: string, name: string): HostListEntry => ({
  descriptor: {
    id,
    name,
    connection: { kind: "ssh", target: name },
    platform: "linux",
    arch: "x64",
    lastHandshake: null,
    lastSeenAt: Date.now(),
    addedAt: 0,
    notificationsEnabled: false,
    assistantMessagingEnabled: false,
    assistantStartEnabled: false,
    assistantControlEnabled: false,
  },
  connection: { status: "connected", rttMs: 38, handshake: PREVIEW_HANDSHAKE },
  summary: null,
});

installPreviewShims({
  hostFiles: {
    getPickerRoots: async () => roots,
    listDirectory: ({ path, showHidden }: { path: string; showHidden?: boolean }) =>
      list(path, showHidden === true),
  },
  hostSwitch: {
    pickerRoots: async () => roots,
    listDirectory: ({ path, showHidden }: { path: string; showHidden?: boolean }) =>
      list(path, showHidden === true),
  },
  remoteHosts: {
    list: async () => [hostEntry(STUDIO, STUDIO), hostEntry("long-host", LONG_HOST)],
    onEvent: () => () => undefined,
  },
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

if (scenario.windowHost) {
  window.__DAINTREE_HOST_ID__ = { id: scenario.windowHost };
  useHostConnectionStore.setState({
    hostId: scenario.windowHost,
    hostName: scenario.windowHost,
    everConnected: true,
  });
}

function Preview() {
  return (
    <div data-preview-shell className="h-screen w-screen">
      <HostFilePickerDialog request={scenario.request} onResolve={() => undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
