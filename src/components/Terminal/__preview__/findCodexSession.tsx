import "./findCodexSessionShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { usePanelStore } from "@/store/panelStore";
import { FindCodexSessionAction } from "../FindCodexSessionAction";
import { RestoreRecoveryGate } from "../RestoreRecoveryGate";
import { TerminalRestartStatusBanner } from "../TerminalRestartStatusBanner";
import "@/index.css";

/**
 * Standalone visual-review harness for the "Find session" popover (#12182).
 *
 * The popover only appears on a Codex pane whose conversation restore couldn't
 * name, which a real session reaches rarely and never on cue. This mounts the
 * real `FindCodexSessionAction` in both places it ships — the lost-session
 * banner and the restore gate — against a seeded Codex pane, with
 * `codex.findSessions` answered from a fixture (see the shim).
 *
 * Query parameters (the capture spec drives these):
 *   ?theme=<built-in theme id>
 *   ?fixture=three|many|long|empty|unavailable|loading
 *   ?host=banner|offer|gate   which surface hosts the trigger (default banner):
 *                             the session-lost banner, the "quit to the shell"
 *                             offer, or the restore gate
 *   ?width=560           pane width in CSS px
 *
 * The pane header and terminal lines are harness decoration.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const hostParam = params.get("host");
const host = hostParam === "gate" || hostParam === "offer" ? hostParam : "banner";
const width = Number(params.get("width") ?? "560");

const PANE_ID = "pane-under-review";
const noop = () => {};

usePanelStore.setState({
  panelsById: {
    [PANE_ID]: {
      id: PANE_ID,
      kind: "terminal",
      title: "Codex",
      location: "grid",
      cwd: "/Users/dev/Projects/acme-platform",
      cols: 120,
      rows: 40,
      launchAgentId: "codex",
      detectedAgentId: "codex",
      ...(host === "gate"
        ? { restoreRecovery: { reason: "sibling-owns-resume-latest-slot" } }
        : {}),
    } as PtyPanelData,
  },
  panelIds: [PANE_ID],
} as Partial<ReturnType<typeof usePanelStore.getState>>);

const TERMINAL_LINES = [
  "~/Projects/acme-platform on develop",
  "$ codex",
  ">_ OpenAI Codex",
  "  model: gpt-5-codex   directory: ~/Projects/acme-platform",
];

function PaneHeader() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs text-text-secondary surface-toolbar"
    >
      <span className="h-3 w-3 rounded-full bg-overlay-medium" />
      <span className="truncate font-medium text-text-primary">Codex</span>
    </div>
  );
}

function TerminalBody() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex-1 bg-surface-canvas px-3 py-2 font-mono text-xs leading-5 text-text-secondary"
    >
      {TERMINAL_LINES.map((line) => (
        <div key={line} className="truncate">
          {line}
        </div>
      ))}
    </div>
  );
}

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
    <div className="p-4">
      <div
        data-preview-pane
        // The popover opens toward the pane's interior, found by this attribute.
        data-panel-id={PANE_ID}
        className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
        style={{ width, height: host === "gate" ? 420 : 300 }}
      >
        <PaneHeader />
        {host === "gate" ? (
          <RestoreRecoveryGate panelId={PANE_ID} />
        ) : (
          <>
            {host === "offer" ? (
              <TerminalRestartStatusBanner
                variant={{ type: "agent-resume-offer", agentId: "codex", sessionId: undefined }}
                onRestart={noop}
                onDismiss={noop}
                findSessionSlot={<FindCodexSessionAction panelId={PANE_ID} />}
              />
            ) : (
              <TerminalRestartStatusBanner
                variant={{
                  type: "session-resume-unavailable",
                  reason: "sibling-owns-resume-latest-slot",
                }}
                onRestart={noop}
                onDismiss={noop}
                findSessionSlot={<FindCodexSessionAction panelId={PANE_ID} />}
              />
            )}
            <TerminalBody />
          </>
        )}
      </div>
    </div>
  );
}

// Radix loads lazily; a popover that mounts before its provider has the
// primitives throws, so prime them before the first render.
void primeRadix().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </StrictMode>
  );
});
