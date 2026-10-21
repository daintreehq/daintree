import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  HostConnectionState,
  HostHandshakeInfo,
  HostListEntry,
  HostPlatform,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type {
  HostMetricsEvent,
  HostWorktreeEntry,
  HostWorktreeRun,
} from "@shared/types/ipc/hostMetrics";
import type { HostProjectPresence } from "@shared/types/ipc/hostSwitch";
import "@/index.css";

/**
 * Visual-review harness for the sidebar's "On other hosts" section: the real
 * component and its real data hook, fed through the bridge seams it reads in
 * the app — the host list, `hostSwitch.locate` and `hostMetrics.listWorktrees`.
 * The local worktree list above it is decoration.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=<name>             one of STATES below
 *   ?width=350                sidebar width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "350");
const stateName = params.get("state") ?? "batch";

const PROJECT = "a".repeat(64);
const REMOTE_PROJECT = "p-daintree";

type RunSpec = [band: HostWorktreeRun["band"], agentState: HostWorktreeRun["agentState"]];

interface WorktreeSpec {
  branch: string;
  main?: boolean;
  runs?: RunSpec[];
}

interface HostSpec {
  id: string;
  name: string;
  platform: HostPlatform;
  worktrees: WorktreeSpec[];
  /** Connected at first, then drops to this once its list has been read. */
  dropsTo?: HostConnectionState;
}

const working: RunSpec = ["running", "working"];
const waiting: RunSpec = ["needs-you", "waiting"];
const blocked: RunSpec = ["blocked", "waiting"];
const quiet: RunSpec = ["quiet", "working"];
const unread: RunSpec = ["review", "completed"];
const finished: RunSpec = ["done", "completed"];
const idle: RunSpec = ["idle", "idle"];

const issue = (n: number, slug: string, ...runs: RunSpec[]): WorktreeSpec => ({
  branch: `feature/issue-${n}-${slug}`,
  runs,
});
const develop = (...runs: RunSpec[]): WorktreeSpec => ({ branch: "develop", main: true, runs });

const STUDIO_01: HostSpec = {
  id: "studio-01",
  name: "studio-01",
  platform: "darwin",
  worktrees: [
    develop(),
    issue(13698, "canopy-search-keeps-selection", unread),
    issue(13700, "let-an-issues-only-project-attach", working),
    issue(13704, "remote-host-port-attribution", working),
    issue(13707, "fleet-broadcast-quota-banner", working),
  ],
};
const STUDIO_02: HostSpec = {
  id: "studio-02",
  name: "studio-02",
  platform: "darwin",
  worktrees: [
    develop(finished),
    issue(13701, "answer-from-dev-preview-console", waiting),
    issue(13702, "codex-quota-shows-in-header", working),
    issue(13703, "add-project-attachments", working),
  ],
};
const STUDIO_03: HostSpec = {
  id: "studio-03",
  name: "studio-03",
  platform: "darwin",
  worktrees: [
    develop(),
    issue(13705, "terminal-resize-reflow", working),
    issue(13706, "worktree-dashboard-density", working, working),
    issue(13708, "mcp-wire-budget", quiet),
    issue(13709, "plugin-lab-real-agent", working),
  ],
};
const STUDIO_04: HostSpec = {
  id: "studio-04",
  name: "studio-04",
  platform: "darwin",
  worktrees: [develop(idle), issue(13690, "theme-text-ramp", finished)],
};

const STATES: Record<string, { hosts: HostSpec[]; viewHostId?: string }> = {
  /** The everyday shape: a batch of issues out across four studios, one asking. */
  batch: { hosts: [STUDIO_01, STUDIO_02, STUDIO_03, STUDIO_04] },
  /** Several agents asking at once, past what one host names. */
  asking: {
    hosts: [
      {
        ...STUDIO_01,
        worktrees: [
          develop(),
          issue(13698, "canopy-search-keeps-selection", blocked),
          issue(13700, "let-an-issues-only-project-attach", waiting),
          issue(13704, "remote-host-port-attribution", working),
        ],
      },
      {
        ...STUDIO_02,
        worktrees: [
          develop(finished),
          issue(13701, "answer-from-dev-preview-console", waiting),
          issue(13702, "codex-quota-shows-in-header", waiting),
          issue(13703, "add-project-attachments", waiting, working),
          issue(13711, "sidebar-scroll-indicator-counts", waiting),
          issue(13712, "notification-inbox-grouping", working),
        ],
      },
      STUDIO_03,
      STUDIO_04,
    ],
  },
  /** Three agents asking on every host: more than half the sidebar, so the section scrolls. */
  overflow: {
    hosts: [STUDIO_01, STUDIO_02, STUDIO_03, STUDIO_04].map((host, h) => ({
      ...host,
      worktrees: [
        develop(),
        ...[0, 1, 2].map((i) =>
          issue(
            13720 + h * 10 + i,
            ["sidebar-density", "quota-banner", "port-attribution"][i]!,
            waiting
          )
        ),
        issue(13760 + h, "fleet-broadcast", working),
      ],
    })),
  },
  /** Every host has the project and nothing is in flight. */
  settled: {
    hosts: [STUDIO_01, STUDIO_02, STUDIO_03, STUDIO_04].map((host) => ({
      ...host,
      worktrees: [develop(finished), issue(13690, "theme-text-ramp", idle)],
    })),
  },
  /** Two hosts drop their links after listing; they keep their places. */
  dropped: {
    hosts: [
      STUDIO_01,
      { ...STUDIO_02, dropsTo: { status: "disconnected" } },
      { ...STUDIO_03, dropsTo: { status: "connecting", attempt: 2 } },
      STUDIO_04,
    ],
  },
  /** This window is on studio-01, so this Mac is one of the other hosts. */
  "remote-window": {
    viewHostId: "studio-01",
    hosts: [STUDIO_01, STUDIO_02, STUDIO_03],
  },
  /** Long machine names and long branches, the clipping stress case. */
  long: {
    hosts: [
      {
        ...STUDIO_02,
        id: "runner-eu",
        name: "build-runner-eu-west-07.ci.internal",
        platform: "linux",
        worktrees: [
          issue(13701, "answer-from-dev-preview-console-when-the-agent-asks-twice", waiting),
          issue(13702, "codex-quota-shows-in-header", working, working),
        ],
      },
      {
        ...STUDIO_03,
        id: "studio-long",
        name: "gregs-mac-studio-m4-ultra-office.local",
        worktrees: [issue(13705, "terminal-resize-reflow", working, quiet), develop(unread)],
      },
    ],
  },
  /** The smallest real case: one other host, one agent working. */
  "one-host": {
    hosts: [{ ...STUDIO_01, worktrees: [develop(), issue(13700, "let-an-issues-only", working)] }],
  },
};

const state = STATES[stateName] ?? STATES.batch!;
const LOCAL_SPEC = state.viewHostId ? STUDIO_04 : null;

const handshake = (platform: HostPlatform): HostHandshakeInfo => ({
  version: "0.45.0",
  commit: "aa0f5d3",
  protocolVersion: 7,
  platform,
  arch: "arm64",
});

const connected = (platform: HostPlatform): HostConnectionState => ({
  status: "connected",
  rttMs: 9,
  rttSampledAt: Date.now(),
  handshake: handshake(platform),
});

function entry(spec: HostSpec, connection: HostConnectionState): HostListEntry {
  return {
    descriptor: {
      id: spec.id,
      name: spec.name,
      connection: { kind: "ssh", target: `greg@${spec.name}` },
      platform: spec.platform,
      arch: "arm64",
      lastHandshake: handshake(spec.platform),
      lastSeenAt: Date.now() - 60_000,
      addedAt: Date.now() - 30 * 86_400_000,
      notificationsEnabled: true,
      assistantControlEnabled: true,
    },
    connection,
    summary: null,
  };
}

function worktrees(spec: HostSpec): HostWorktreeEntry[] {
  let terminal = 0;
  return spec.worktrees.map((wt) => {
    const runs: HostWorktreeRun[] = (wt.runs ?? []).map(([band, agentState]) => ({
      terminalId: `${spec.id}-t${++terminal}`,
      band,
      agentState,
    }));
    const top = runs[0];
    return {
      hostId: spec.id,
      projectId: REMOTE_PROJECT,
      projectName: "daintree",
      worktreeId: `/Users/greg/daintree-worktrees/${wt.branch}`,
      name: wt.branch.replace(/^feature\//, ""),
      branch: wt.branch,
      path: `/Users/greg/daintree-worktrees/${wt.branch}`,
      isMainWorktree: wt.main === true,
      modifiedCount: 3,
      lastActivityAt: Date.now() - 120_000,
      observed: top ? { band: top.band, agentState: top.agentState } : null,
      runs,
    };
  });
}

if (state.viewHostId) {
  window.__DAINTREE_HOST_ID__ = { id: state.viewHostId };
}

// The window's own host is never listed among the others.
const listed = state.hosts.filter((spec) => spec.id !== state.viewHostId);
let hostList = listed.map((spec) => entry(spec, connected(spec.platform)));
const hostListeners = new Set<(event: RemoteHostsEvent) => void>();
const metricsListeners = new Set<(event: HostMetricsEvent) => void>();
const specFor = (hostId: string) =>
  hostId === "local" ? LOCAL_SPEC : (state.hosts.find((spec) => spec.id === hostId) ?? null);
const read = new Set<string>();

installPreviewShims({
  remoteHosts: {
    list: async () => hostList,
    onEvent: (listener: (event: RemoteHostsEvent) => void) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
  },
  hostSwitch: {
    locate: async ({ toHostIds }: { toHostIds: string[] }): Promise<HostProjectPresence[]> =>
      toHostIds.map((hostId) => ({
        hostId,
        projects: specFor(hostId)
          ? [{ projectId: REMOTE_PROJECT, name: "daintree", path: "/Users/greg/daintree" }]
          : [],
      })),
  },
  hostMetrics: {
    listWorktrees: async ({ hostId }: { hostId: string }) => {
      const spec = specFor(hostId);
      read.add(hostId);
      return spec ? worktrees(spec) : [];
    },
    onEvent: (listener: (event: HostMetricsEvent) => void) => {
      metricsListeners.add(listener);
      return () => metricsListeners.delete(listener);
    },
  },
});

/** Stage the drops through the real connection event once each host's list has landed. */
async function stage() {
  const dropping = listed.filter((spec) => spec.dropsTo);
  for (let i = 0; i < 200 && dropping.some((spec) => !read.has(spec.id)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const spec of dropping) {
    hostList = hostList.map((h) =>
      h.descriptor.id === spec.id ? { ...h, connection: spec.dropsTo! } : h
    );
    for (const listener of hostListeners) {
      listener({ type: "connection-changed", hostId: spec.id, connection: spec.dropsTo! });
    }
  }
  document.body.dataset.staged = "true";
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
const { OtherHostsWorktreeGroup } = await import("../OtherHostsWorktreeGroup");

/** The local worktree list the section sits under: decoration only. */
function LocalWorktrees() {
  const rows = [
    { branch: "develop", note: "2 changes" },
    { branch: "feature/other-hosts-sidebar-summary", note: "Working" },
    { branch: "fix/canopy-request-budget", note: "Finished" },
  ];
  return (
    <div data-harness-decoration aria-hidden="true" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center px-3 text-sm font-semibold text-text-primary">
        Worktrees
      </div>
      {rows.map((row, i) => (
        <div
          key={row.branch}
          className={
            i === 1
              ? "mx-2 mb-1 rounded-[var(--radius-md)] bg-overlay-subtle px-2.5 py-2"
              : "mx-2 mb-1 px-2.5 py-2"
          }
        >
          <div className="truncate text-sm text-text-primary">{row.branch}</div>
          <div className="text-xs text-text-secondary">{row.note}</div>
        </div>
      ))}
      <div className="flex-1" />
    </div>
  );
}

function Sidebar() {
  return (
    <div
      data-preview-shell
      className="flex h-[620px] flex-col border-r border-divider bg-surface-sidebar"
      style={{ width: `${width}px` }}
    >
      <LocalWorktrees />
      <OtherHostsWorktreeGroup projectId={PROJECT} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Sidebar />
    </TooltipProvider>
  </StrictMode>
);
void stage();
