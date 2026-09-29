import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import type {
  ActiveGrantState,
  GrantEndedState,
  LaunchErrorState,
  SessionRevokedState,
  TierMismatchState,
} from "@/controllers/HelpSessionController";
import { installPreviewShims } from "./previewShims";
import { HelpPanelBanners } from "../HelpPanelBanners";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the banners at the top of the assistant panel.
 *
 * Every one of these is reached mid-session and most only by a failure — a tool the
 * session's tier refuses, a grant timing out, a launch whose services never came up — so
 * this renders the real `HelpPanelBanners` from fixtures that name each state, against the
 * theme's real tokens and at the panel's real widths.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=resume           which banner state to render
 *   ?width=380                panel width in CSS px (default 380, the app's default)
 */

interface Fixture {
  resume?: boolean;
  tierMismatch?: TierMismatchState;
  launchError?: LaunchErrorState;
  sessionRevoked?: SessionRevokedState;
  activeGrant?: ActiveGrantState;
  grantEnded?: GrantEndedState;
  approving?: boolean;
  revoking?: boolean;
}

const MISMATCH: TierMismatchState = {
  sessionId: "preview-session",
  toolId: "worktree.delete",
  tier: "core",
  targetTier: "full",
  projectId: "p-1",
};

// 14:32 left: long enough that the capture never lands on a boundary tick.
const GRANT: ActiveGrantState = {
  sessionId: "preview-session",
  toolId: "terminal.sendCommand",
  expiresAt: Date.now() + (14 * 60 + 32) * 1000 + 500,
  ttlMs: 15 * 60 * 1000,
};

const FIXTURES = {
  resume: { resume: true },
  "grant-active": { activeGrant: GRANT },
  "grant-revoking": { activeGrant: GRANT, revoking: true },
  "grant-ended": { grantEnded: { toolId: "terminal.sendCommand", reason: "expired" } },
  "grant-ceiling": { grantEnded: { toolId: "terminal.sendCommand", reason: "grant-ceiling" } },
  "tier-mismatch": { tierMismatch: MISMATCH },
  "tier-approving": { tierMismatch: MISMATCH, approving: true },
  "tier-unknown": { tierMismatch: { ...MISMATCH, toolId: "plugin.acme.sync", targetTier: null } },
  "launch-retry": { launchError: { agentId: "claude", kind: "mcp-server-not-started" } },
  "launch-spawn": { launchError: { agentId: "claude", kind: "spawn-failed" } },
  "launch-lanes": { launchError: { agentId: "claude", kind: "mixed-agent-lanes" } },
  "launch-folder": { launchError: { agentId: "claude", kind: "folder-unavailable" } },
  revoked: { sessionRevoked: { sessionId: "preview-session", denialKind: "tier" } },
  // The worst realistic pile-up: a resumed session that immediately asks for a tool it
  // can't have while an earlier grant is still counting down.
  stack: { resume: true, activeGrant: GRANT, tierMismatch: MISMATCH },
} satisfies Record<string, Fixture>;

type FixtureName = keyof typeof FIXTURES;

function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "resume";
const width = Number(params.get("width")) || 380;
const fixture: Fixture = FIXTURES[fixtureName];

const noop = () => {};

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <div
      data-preview-panel
      className="flex flex-col bg-surface-panel border border-border-default"
      style={{ width: `${width}px`, minHeight: "220px" }}
    >
      {/* Stand-in for the header and session strip: the banners' real top neighbour. */}
      <div
        className="flex items-center h-9 px-3 border-b border-border-default text-xs font-medium text-text-primary"
        aria-hidden="true"
      >
        Daintree Assistant
      </div>
      <div data-preview-banners className="flex flex-col">
        <HelpPanelBanners
          showResumeBanner={fixture.resume ?? false}
          tierMismatch={fixture.tierMismatch ?? null}
          launchError={fixture.launchError ?? null}
          sessionRevoked={fixture.sessionRevoked ?? null}
          isApprovingTier={fixture.approving ?? false}
          activeGrant={fixture.activeGrant ?? null}
          grantEnded={fixture.grantEnded ?? null}
          isRevokingGrant={fixture.revoking ?? false}
          onDismissResume={noop}
          onDismissTierMismatch={noop}
          onApproveOnce={noop}
          onAlwaysAllow={noop}
          onRevokeGrant={noop}
          onDismissGrantEnded={noop}
          onRetryLaunch={noop}
          onDismissLaunchError={noop}
          onOpenAssistantSettings={noop}
          onOpenLogs={noop}
          onOpenInstallerPage={noop}
          onStartNewSession={noop}
          onDismissSessionRevoked={noop}
        />
      </div>
      {/* Stand-in for the transcript: the banners' real bottom neighbour. */}
      <div className="flex-1 min-h-16 px-3 py-3 space-y-2" aria-hidden="true">
        <div className="h-2 w-4/5 rounded-full bg-overlay-soft" />
        <div className="h-2 w-3/5 rounded-full bg-overlay-soft" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
