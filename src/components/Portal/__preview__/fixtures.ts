import type { PortalTab } from "@shared/types/portal";
import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";

/**
 * Portal dock states for the visual-review harness. Type-only imports: the
 * capture spec reads this file under Playwright's Node loader.
 */

export interface PortalFixture {
  width: number;
  height: number;
  tabs: PortalTab[];
  activeTabId: string | null;
  /** Ids whose views count as created; the active page otherwise shows a skeleton. */
  createdTabs?: string[];
  /** Disable every link, for the no-links empty state. */
  noLinks?: boolean;
  showDevDashboard?: boolean;
  devSessions?: DevPreviewSessionState[];
  /** A pointer or keyboard state the spec performs after load. */
  drive?: "hover-row" | "focus-row" | "hover-copy" | "hover-dev-action";
}

const claude: PortalTab = {
  id: "t-claude",
  url: "https://claude.ai/chat/7c1e",
  title: "Claude",
  icon: "claude",
};
const chatgpt: PortalTab = {
  id: "t-chatgpt",
  url: "https://chatgpt.com/c/91ab",
  title: "ChatGPT",
  icon: "codex",
};
const gemini: PortalTab = {
  id: "t-gemini",
  url: "https://gemini.google.com/app/5d2f",
  title: "Gemini",
  icon: "gemini",
};
const docs: PortalTab = {
  id: "t-docs",
  url: "https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver",
  title: "ResizeObserver - Web APIs | MDN",
};
const blank: PortalTab = { id: "t-blank", url: null, title: "New Tab" };

function session(
  panelId: string,
  worktreeId: string,
  status: DevPreviewSessionState["status"],
  port: number | null,
  lastOutput?: string
): DevPreviewSessionState {
  return {
    panelId,
    projectId: "p-1",
    worktreeId,
    status,
    url: port ? `http://localhost:${port}/` : null,
    predictedUrl: null,
    error: status === "error" ? { type: "port-conflict", message: "Port 5173 in use" } : null,
    terminalId: status === "error" ? null : `term-${panelId}`,
    isRestarting: false,
    generation: 1,
    updatedAt: 0,
    ...(lastOutput ? { lastOutput } : {}),
  } as DevPreviewSessionState;
}

const SESSIONS: DevPreviewSessionState[] = [
  session("d1", "wt-main", "running", 5173, "VITE v8.0.14  ready in 412 ms"),
  session(
    "d2",
    "wt-billing",
    "running",
    5174,
    "12:04:51 [vite] hmr update /src/routes/+page.svelte"
  ),
  session("d3", "wt-onboarding", "starting", 5175, "> orchid-studio@0.4.0 dev"),
  session("d4", "wt-search", "error", null),
  session("d5", "wt-legacy", "restored-stopped", null),
];

export const FIXTURES = {
  "launchpad-first-run": { width: 480, height: 900, tabs: [], activeTabId: null },
  "launchpad-blank-tab": {
    width: 480,
    height: 900,
    tabs: [claude, chatgpt, blank],
    activeTabId: "t-blank",
    createdTabs: ["t-claude", "t-chatgpt"],
  },
  "launchpad-hover": {
    width: 480,
    height: 900,
    tabs: [],
    activeTabId: null,
    drive: "hover-row",
  },
  "launchpad-focus": {
    width: 480,
    height: 900,
    tabs: [],
    activeTabId: null,
    drive: "focus-row",
  },
  "launchpad-narrow": { width: 320, height: 900, tabs: [claude], activeTabId: null },
  "launchpad-no-links": { width: 480, height: 700, tabs: [], activeTabId: null, noLinks: true },
  "page-active": {
    width: 480,
    height: 900,
    tabs: [claude, chatgpt, gemini],
    activeTabId: "t-claude",
    createdTabs: ["t-claude", "t-chatgpt", "t-gemini"],
  },
  "page-many-tabs": {
    width: 480,
    height: 900,
    tabs: [
      claude,
      chatgpt,
      gemini,
      docs,
      { ...claude, id: "t-claude-2", url: "https://claude.ai/chat/2" },
      { ...chatgpt, id: "t-chatgpt-2" },
    ],
    activeTabId: "t-docs",
    createdTabs: ["t-claude", "t-chatgpt", "t-gemini", "t-docs", "t-claude-2", "t-chatgpt-2"],
  },
  "page-hover-copy": {
    width: 480,
    height: 600,
    tabs: [claude],
    activeTabId: "t-claude",
    createdTabs: ["t-claude"],
    drive: "hover-copy",
  },
  "dev-servers-empty": {
    width: 480,
    height: 900,
    tabs: [],
    activeTabId: null,
    showDevDashboard: true,
    devSessions: [],
  },
  "dev-servers-populated": {
    width: 480,
    height: 900,
    tabs: [claude, chatgpt],
    activeTabId: "t-claude",
    createdTabs: ["t-claude", "t-chatgpt"],
    showDevDashboard: true,
    devSessions: SESSIONS,
  },
  "dev-servers-hover": {
    width: 480,
    height: 900,
    tabs: [claude],
    activeTabId: "t-claude",
    createdTabs: ["t-claude"],
    showDevDashboard: true,
    devSessions: SESSIONS,
    drive: "hover-dev-action",
  },
} satisfies Record<string, PortalFixture>;

export type FixtureName = keyof typeof FIXTURES;

export function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

export const FIXTURE_NAMES = Object.keys(FIXTURES).filter(isFixtureName);

export function getFixture(name: FixtureName): PortalFixture {
  return FIXTURES[name];
}
