import "./promptHistoryShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import {
  openSendToAgentPaletteWithText,
  useSendToAgentPalette,
} from "@/hooks/useSendToAgentPalette";
import { SendToAgentPalette } from "../SendToAgentPalette";
import { SOURCE_ID, requireFixture } from "./sendToAgentFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the send-to-agent palette.
 *
 * In the app the palette only opens from a live terminal selection with at
 * least one other PTY pane to receive it, so the palette-family harness skips
 * it. This mounts the real palette driven by its real hook, against the real
 * panel and worktree stores, `index.css` and theme tokens, and opens it through
 * the same opener the agent handoff banner uses.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…                    built-in theme id
 *   ?fixture=mixed|worktrees|all-locked|empty  see sendToAgentFixtures
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = requireFixture(params.get("fixture") ?? "mixed");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

usePanelStore.setState({
  panelsById: Object.fromEntries(fixture.panes.map((p) => [p.id, p])),
  panelIds: fixture.panes.map((p) => p.id),
  focusedId: SOURCE_ID,
});

const worktreeStore = createWorktreeStore();
worktreeStore.setState({ worktrees: new Map(fixture.worktrees.map((w) => [w.id, w])) });

if (!openSendToAgentPaletteWithText("npm test -- src/auth", SOURCE_ID)) {
  throw new Error("send-to-agent opener refused the fixture");
}
if (fixture.closeAfterOpen) {
  const closed = new Set(fixture.closeAfterOpen);
  const remaining = fixture.panes.filter((p) => !closed.has(p.id));
  usePanelStore.setState({
    panelsById: Object.fromEntries(remaining.map((p) => [p.id, p])),
    panelIds: remaining.map((p) => p.id),
  });
}

function Host() {
  const palette = useSendToAgentPalette();
  return (
    <SendToAgentPalette
      isOpen={palette.isOpen}
      query={palette.query}
      results={palette.results}
      totalResults={palette.totalResults}
      selectedIndex={palette.selectedIndex}
      close={palette.close}
      setQuery={palette.setQuery}
      selectPrevious={palette.selectPrevious}
      selectNext={palette.selectNext}
      selectItem={palette.selectItem}
      confirmSelection={palette.confirmSelection}
      setSelectedIndex={palette.setSelectedIndex}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={worktreeStore}>
        <div data-preview-shell />
        <Host />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  </StrictMode>
);
