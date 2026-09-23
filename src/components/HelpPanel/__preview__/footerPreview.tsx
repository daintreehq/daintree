import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { getAgentConfig } from "@/config/agents";
import type { McpToolActivityState } from "@/controllers/HelpSessionController";
import type { PinnedActionContextSnapshot } from "@shared/types/ipc/help";
import type { TurnOutcomeAlertClass } from "@shared/types/ipc/mcpServer";
import type { PaneWatchState } from "@shared/types/terminalWatch";
import { installPreviewShims } from "./previewShims";
import { HelpPanelFooter } from "../HelpPanelFooter";
import "@/index.css";

/**
 * Standalone visual-review harness for the assistant panel's footer status row.
 *
 * The footer's busiest states — a turn-outcome alert beside a live tool call, a watch
 * chip, a diverged worktree — only occur mid-session and rarely together, so this
 * renders the real `HelpPanelFooter` from fixtures that name each state, against the
 * theme's real tokens and at the panel's real widths.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=rest             which footer state to render
 *   ?width=380                panel width in CSS px (default 380, the app's default)
 */

interface Fixture {
  agentId: string;
  model: string | null;
  activity: McpToolActivityState | null;
  outcome: TurnOutcomeAlertClass | null;
  pinned: PinnedActionContextSnapshot | null;
  diverged: boolean;
  watching: number;
}

const SAME_NAME: PinnedActionContextSnapshot = {
  worktreeId: "wt-1",
  worktreeName: "design/artifact-overlay",
  worktreeBranch: "design/artifact-overlay",
  terminalId: "t-1",
};

const DISTINCT_NAME: PinnedActionContextSnapshot = {
  worktreeId: "wt-2",
  worktreeName: "daintree",
  worktreeBranch: "feature/assistant-footer-status-row",
  terminalId: "t-1",
};

function call(overrides: Partial<McpToolActivityState>): McpToolActivityState {
  return {
    status: "settled",
    toolId: "worktree.list",
    argsSummary: "{}",
    startedAt: 1,
    danger: false,
    callCount: 1,
    pendingCalls: 0,
    isError: false,
    ...overrides,
  };
}

const BASE: Fixture = {
  agentId: "claude",
  model: null,
  activity: null,
  outcome: null,
  pinned: SAME_NAME,
  diverged: false,
  watching: 0,
};

const FIXTURES = {
  rest: { ...BASE },
  "rest-assistant": {
    ...BASE,
    agentId: "daintree-assistant",
    model: "Sonnet",
    pinned: DISTINCT_NAME,
  },
  "in-flight": {
    ...BASE,
    activity: call({
      status: "in-flight",
      callCount: 2,
      pendingCalls: 1,
      toolId: "terminal.sendCommand",
    }),
  },
  "settled-error": {
    ...BASE,
    activity: call({ isError: true, result: "error", toolId: "git.push" }),
  },
  "outcome-loop": { ...BASE, outcome: "reasoning-loop" },
  "outcome-stuck": { ...BASE, outcome: "agent-stuck" },
  diverged: { ...BASE, diverged: true },
  busy: {
    ...BASE,
    agentId: "daintree-assistant",
    model: "Opus",
    activity: call({
      status: "in-flight",
      callCount: 3,
      pendingCalls: 1,
      toolId: "worktree.createFromBranch",
    }),
    outcome: "reasoning-loop",
    pinned: DISTINCT_NAME,
    diverged: true,
    watching: 2,
  },
  "busy-confirm": {
    ...BASE,
    agentId: "daintree-assistant",
    model: "Opus",
    activity: call({
      status: "in-flight",
      danger: true,
      pendingCalls: 1,
      toolId: "worktree.delete",
    }),
    outcome: "reasoning-loop",
    pinned: DISTINCT_NAME,
    diverged: true,
    watching: 2,
  },
} satisfies Record<string, Fixture>;

type FixtureName = keyof typeof FIXTURES;

function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "rest";
const width = Number(params.get("width")) || 380;
const fixture: Fixture = FIXTURES[fixtureName];

const watchState: PaneWatchState | null =
  fixture.watching > 0
    ? {
        terminalId: "t-1",
        watchCount: fixture.watching,
        watchedTerminalCount: fixture.watching,
        pendingEvents: 0,
        delivery: { status: "idle" },
        revision: 1,
      }
    : null;

installPreviewShims({
  mcpServer: new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "getPaneWatchState"
          ? () => Promise.resolve(watchState)
          : key === "getAuditRecords"
            ? () => Promise.resolve([])
            : () =>
                Object.assign(() => undefined, { then: (r: (v: unknown) => void) => r(undefined) }),
    }
  ),
});

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  const agentConfig = getAgentConfig(fixture.agentId);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready || !agentConfig) return null;

  return (
    <div
      data-preview-panel
      className="flex flex-col bg-surface-panel border border-border-default"
      style={{ width: `${width}px`, height: "160px" }}
    >
      {/* Stand-in for the transcript: the footer's real top neighbour. */}
      <div className="flex-1 min-h-0 px-3 py-3 space-y-2" aria-hidden="true">
        <div className="h-2 w-4/5 rounded-full bg-overlay-soft" />
        <div className="h-2 w-3/5 rounded-full bg-overlay-soft" />
      </div>
      <div data-preview-footer>
        <HelpPanelFooter
          sessionId="preview-session"
          activity={fixture.activity}
          outcomeAlert={fixture.outcome}
          onDismissOutcome={() => {}}
          terminalId={fixture.watching > 0 ? "t-1" : null}
          pinnedContext={fixture.pinned}
          isPinnedWorktreeDiverged={fixture.diverged}
          onReturnToPinnedWorktree={() => {}}
          agentId={fixture.agentId}
          agentConfig={agentConfig}
          launchedModelLabel={fixture.model}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
