import { StrictMode, useEffect, useId, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import type { HelpSessionPhase, VersionTooOld } from "@/controllers/HelpSessionController";
import { installPreviewShims } from "./previewShims";
import { HelpPanelHeader } from "../HelpPanelHeader";
import { HelpLaunchingState } from "../HelpLaunchingState";
import { HelpSessionTabs } from "../HelpSessionTabs";
import { HelpPanelVersionGate } from "../HelpPanelVersionGate";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the assistant panel's pre-session body: the
 * launch skeleton and the CLI version gate.
 *
 * Both only appear on the way into a session — the gate needs an outdated CLI on the
 * machine, and the launch hints need a launch that stalls for 8-20s — so this renders
 * the real components under the real `HelpPanelHeader`, at the panel's real widths,
 * from fixtures that name each state. The capture spec drives the hint ladder with
 * Playwright's fake clock rather than waiting it out.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=launch-provisioning   which body state to render
 *   ?width=380                panel width in CSS px (default 380, the app's default)
 */

type Fixture =
  | { kind: "launch"; phase: HelpSessionPhase }
  | { kind: "gate"; versionTooOld: VersionTooOld; isCheckingVersion: boolean };

const CLAUDE_GATE: VersionTooOld = {
  agentId: "claude",
  agentName: "Claude",
  installedVersion: "2.0.14",
  requiredVersion: "2.1.0",
};

const LONG_GATE: VersionTooOld = {
  agentId: "opencode",
  agentName: "OpenCode",
  installedVersion: "0.15.31-beta.2",
  requiredVersion: "1.0.0",
};

const FIXTURES = {
  "launch-version-checking": { kind: "launch", phase: "version-checking" },
  "launch-provisioning": { kind: "launch", phase: "provisioning" },
  "launch-launching": { kind: "launch", phase: "launching" },
  "launch-hibernating": { kind: "launch", phase: "hibernating" },
  gate: { kind: "gate", versionTooOld: CLAUDE_GATE, isCheckingVersion: false },
  "gate-checking": { kind: "gate", versionTooOld: CLAUDE_GATE, isCheckingVersion: true },
  "gate-long": { kind: "gate", versionTooOld: LONG_GATE, isCheckingVersion: false },
} satisfies Record<string, Fixture>;

type FixtureName = keyof typeof FIXTURES;

function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "launch-provisioning";
const width = Number(params.get("width")) || 380;
const fixture: Fixture = FIXTURES[fixtureName];

function Body() {
  if (fixture.kind === "launch") {
    return <HelpLaunchingState phase={fixture.phase} isLoading onCancel={() => {}} />;
  }
  return (
    <HelpPanelVersionGate
      versionTooOld={fixture.versionTooOld}
      onOpenSettings={() => {}}
      onCheckAgain={() => {}}
      isCheckingVersion={fixture.isCheckingVersion}
    />
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  const idBase = useId();

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
      className="flex flex-col bg-surface-canvas border-l border-border-default"
      style={{ width: `${width}px`, height: "560px" }}
    >
      <HelpPanelHeader
        agentState={null}
        canRestartConversation={false}
        canEndSession={false}
        onRestartConversation={() => {}}
        onEndSession={() => {}}
        onOpenDocs={() => {}}
        onClose={() => {}}
        isFocused
      />
      <HelpSessionTabs
        tabs={[{ slot: 0, label: "Session 1", agentState: null }]}
        activeSlot={0}
        onSelect={() => {}}
        onClose={() => {}}
        canOpenSession
        onOpenSession={() => {}}
        idBase={idBase}
        panelId={`${idBase}-body`}
      />
      {/* Mirrors the panel body's own wrapper so the states sit in their real box. */}
      <div
        id={`${idBase}-body`}
        data-preview-body
        className="flex-1 flex flex-col min-h-0 relative"
      >
        <Body />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      {/* The app mounts one at its root; the gate's copy buttons carry tooltips. */}
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
