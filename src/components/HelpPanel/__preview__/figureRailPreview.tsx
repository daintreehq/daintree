import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import type { HelpFigure } from "@/store/helpPanelStore";
import { installPreviewShims } from "./previewShims";
import { FigureRail } from "../FigureRail";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the assistant panel's figure rail and the
 * lightbox it opens.
 *
 * Figures only exist after the assistant has called `help.displayImage` mid-session,
 * and the states worth judging — a thumbnail still loading, one that failed, a rail
 * that overflows, the lightbox over a portrait figure — need several calls and a
 * flaky network to reach. So this renders the real `FigureRail` (and through it the
 * real `FigureLightbox` on `AppDialog`) in the panel's real position, from fixtures
 * that name each state.
 *
 * Every figure URL points at `https://daintree.org/docs/figures/…`, which the renderer
 * CSP already allows. The screenshot spec intercepts that host and decides per file
 * whether it loads, fails, or never answers — so the loading and failed states are the
 * component's own, not a prop the harness forces.
 *
 * What is a stand-in: the terminal, the hybrid input bar above the rail and the footer
 * below it are quiet blocks that give the rail its real neighbours and nothing more.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=several          which rail state to render
 *   ?width=380                panel width in CSS px (default 380, the app's default)
 */

const DOCS = "https://daintree.org/docs/figures";

function figure(n: number, file: string, extra: Partial<HelpFigure> = {}): HelpFigure {
  return {
    imageId: `img-${n}-${file}`,
    figureNumber: n,
    figureLabel: `image #${n}`,
    url: `${DOCS}/${file}`,
    ...extra,
  };
}

const LANDSCAPE = figure(1, "worktree-dashboard.png", {
  caption: "The worktree dashboard, with one card per worktree and its agents beneath it.",
  altText: "Worktree dashboard with three worktree cards",
});
const PORTRAIT = figure(2, "bulk-command.png", {
  caption: "Bulk command palette targeting every idle agent.",
  altText: "Bulk command palette",
});
const PANORAMA = figure(3, "theme-banner.webp", {
  caption: "The Daintree theme banner shown in Settings → Appearance.",
  altText: "Theme banner",
});
const SETTINGS = figure(4, "agent-settings.png", {
  caption: "Agent settings, where each CLI's launch flags live.",
  altText: "Agent settings page",
});
const DASHBOARD_2 = figure(5, "fleet-ribbon.png", {
  caption: "The fleet ribbon armed across four terminals.",
  altText: "Fleet ribbon",
});

const FIXTURES = {
  one: [LANDSCAPE],
  several: [LANDSCAPE, PORTRAIT, PANORAMA, SETTINGS, DASHBOARD_2],
  mixed: [
    LANDSCAPE,
    figure(2, "missing.png", { caption: "A figure whose request failed." }),
    figure(3, "slow.png", { caption: "A figure still on its way." }),
  ],
  "no-caption": [
    figure(1, "worktree-dashboard.png"),
    figure(2, "bulk-command.png"),
    figure(3, "theme-banner.webp"),
  ],
  "long-caption": [
    figure(1, "worktree-dashboard.png", {
      caption:
        "The worktree dashboard groups every agent terminal under the worktree it runs in, so a fleet of agents working on separate branches stays legible at a glance. Each card shows the branch, its ahead/behind count against the base branch, the agents running in it and whether any of them is waiting on you. Cards sort by recent activity, and a card whose agents are all idle collapses to a single line.",
      altText: "Worktree dashboard with three worktree cards",
    }),
    PORTRAIT,
  ],
} satisfies Record<string, HelpFigure[]>;

type FixtureName = keyof typeof FIXTURES;

function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const fixtureName: FixtureName = isFixtureName(fixtureParam) ? fixtureParam : "several";
const width = Number(params.get("width")) || 380;

/** Stand-in terminal output, quiet enough that the rail is what the eye lands on. */
function TerminalStandIn() {
  const lines = [
    "The worktree dashboard is where each branch's agents live.",
    "Each card groups the agents running in that worktree — see [image #1].",
    "Bulk commands target every idle agent at once, shown in [image #2].",
  ];
  return (
    <div
      className="flex-1 min-h-0 px-3 py-3 font-mono text-xs leading-5 text-text-secondary"
      aria-hidden="true"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
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
    <div style={{ display: "flex", height: "100vh", width: "100vw" }}>
      {/* The app's grid, which the lightbox's scrim sits over. */}
      <div className="flex-1 bg-surface-grid" aria-hidden="true" />
      <div
        data-preview-panel
        className="flex flex-col h-full border-l border-border-default bg-surface-panel"
        style={{ width: `${width}px` }}
      >
        <TerminalStandIn />
        <div className="shrink-0 px-2 pb-2" aria-hidden="true">
          <div className="h-9 rounded-[var(--radius-md)] border border-border-default bg-surface-input px-3 flex items-center text-xs text-text-muted">
            Ask the assistant…
          </div>
        </div>
        <FigureRail figures={FIXTURES[fixtureName]} />
        <div
          className="shrink-0 h-7 border-t border-border-default bg-surface-toolbar"
          aria-hidden="true"
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
