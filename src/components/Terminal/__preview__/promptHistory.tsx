import "./promptHistoryShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { usePaletteStore } from "@/store/paletteStore";
import { PromptHistoryPalette } from "../PromptHistoryPalette";
import { useProjectStore } from "@/store/projectStore";
import { PROJECTS, PROJECT_ID, TERMINAL_ID, requireFixture } from "./promptHistoryFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the prompt history palette.
 *
 * In the app the palette only has rows once prompts have been sent from an
 * agent composer, and it only mounts inside a focused `HybridInputBar` — so the
 * palette-family harness skips it. This mounts the real palette against the
 * real stores and `index.css`, with the history seeded from a fixture.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…     built-in theme id
 *   ?fixture=populated|empty    which history to seed (see promptHistoryFixtures)
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixture = requireFixture(params.get("fixture") ?? "populated");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

// Seed before mounting — a store write during render is a cross-component update.
useProjectStore.setState({ projects: PROJECTS });
useCommandHistoryStore.setState({ history: fixture.history });
usePaletteStore.getState().openPalette("prompt-history");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell />
      <PromptHistoryPalette terminalId={TERMINAL_ID} projectId={PROJECT_ID} />
    </TooltipProvider>
  </StrictMode>
);
