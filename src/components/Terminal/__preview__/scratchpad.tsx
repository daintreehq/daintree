import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import { TerminalScratchpad } from "../TerminalScratchpad";
import {
  SCRATCHPAD_FIXTURES,
  isScratchpadFixtureName,
  type ScratchpadFixture,
} from "./scratchpadFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for a terminal's Scratchpad column.
 *
 * Mounts the real `ContentPanel` (so the header, its scratchpad expand control
 * and the pane frame are the product's own) with the real `TerminalScratchpad`
 * beside a stand-in terminal body, in the same flex row `TerminalPane` draws.
 * The panel store is seeded with one PTY row carrying the fixture's scratchpad,
 * which is the only thing the column reads.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|svalbard|…   built-in theme id
 *   ?fixture=notes               see scratchpadFixtures.ts
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "notes";
const fixtureName = isScratchpadFixtureName(fixtureParam) ? fixtureParam : "notes";
const fixture: ScratchpadFixture = SCRATCHPAD_FIXTURES[fixtureName];

const PANE_ID = "scratchpad-pane";
const PANE_HEIGHT = 560;
const noop = () => {};

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const row = {
  id: PANE_ID,
  kind: "terminal",
  title: "auth-refresh",
  location: "grid",
  cwd: "/Users/dev/acme-platform",
  cols: 120,
  rows: 40,
  scratchpad: fixture.scratchpad,
} as PtyPanelData;

usePanelStore.setState({
  panelsById: { [PANE_ID]: row },
  panelIds: [PANE_ID],
  focusedId: PANE_ID,
} as Partial<ReturnType<typeof usePanelStore.getState>>);
usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });

function TerminalLines() {
  return (
    <div
      className="flex-1 min-h-0 px-3 py-2 font-mono text-xs leading-5 text-text-secondary select-none"
      aria-hidden="true"
    >
      <div>$ npm test -- src/auth</div>
      <div className="text-text-muted">✓ refresh token rotates on expiry (41 ms)</div>
      <div className="text-text-muted">✓ rejects a replayed nonce (12 ms)</div>
      <div className="text-text-muted">✗ refresh races a cold cache (1.2 s)</div>
      <div>&nbsp;</div>
      <div>$ git status --short</div>
      <div className="text-text-muted"> M src/auth/session.ts</div>
      <div className="text-text-muted"> M src/auth/tokens.ts</div>
      <div>$ ▍</div>
    </div>
  );
}

function App() {
  return (
    <div
      data-preview-pane={fixtureName}
      className="bg-surface-canvas p-2"
      style={{ width: fixture.paneWidth ?? 820, height: PANE_HEIGHT + 16 }}
    >
      <ContentPanel
        id={PANE_ID}
        title="auth-refresh"
        kind="terminal"
        isFocused
        location="grid"
        isMultiPanelGrid
        onFocus={noop}
        onClose={noop}
        onToggleMaximize={noop}
        onTitleChange={noop}
        onMinimize={noop}
        onRestart={noop}
        onAddTab={noop}
      >
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 min-h-0 bg-surface-canvas flex flex-col">
            <TerminalLines />
          </div>
          <TerminalScratchpad terminalId={PANE_ID} />
        </div>
      </ContentPanel>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorktreeStoreProvider>
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    </WorktreeStoreProvider>
  </StrictMode>
);
