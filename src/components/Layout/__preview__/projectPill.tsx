import "./launcherShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandSurface } from "@/components/icons";
import { middleTruncate } from "@/utils/textParsing";
import { activeWorkspaceIdentity, branchChipState } from "@/lib/workspaceIdentity";
import { ToolbarProjectPill } from "../ToolbarProjectPill";
import "@/index.css";

/**
 * Standalone visual-review harness for the toolbar's project pill.
 *
 * Mounts the real `ToolbarProjectPill` inside a stand-in of the toolbar's own
 * container — same grid, same `@container/toolbar` name, same surface class — so
 * the pill's container query and material resolve exactly as they do in the app.
 * One row per state; the spec (`project-pill-review.spec.ts`) crops each row.
 *
 * Every state is derived through `activeWorkspaceIdentity` and `branchChipState`,
 * the same resolvers the toolbar calls, so a fixture cannot describe a state the
 * app would never produce.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

interface Fixture {
  slug: string;
  project?: { name: string; emoji: string; gitBacked?: boolean };
  scratch?: { name: string };
  branch?: string;
  open?: boolean;
  /** Width of the stand-in toolbar strip, in px. */
  width?: number;
}

/** Mirrored as `STATES` in the spec — keep the two lists in step. */
const FIXTURES: Fixture[] = [
  { slug: "rest", project: { name: "Daintree", emoji: "🌴" }, branch: "develop" },
  {
    slug: "feature-branch",
    project: { name: "Daintree", emoji: "🌴" },
    branch: "design/project-pill",
  },
  {
    slug: "long-branch",
    project: { name: "Daintree", emoji: "🌴" },
    branch: "feature/12593-multi-window-open-routing-dock-drop",
  },
  {
    slug: "long-name",
    project: { name: "helios-analytics-dashboard-platform", emoji: "☀️" },
    branch: "main",
  },
  {
    slug: "long-both",
    project: { name: "helios-analytics-dashboard-platform", emoji: "☀️" },
    branch: "fix/11958-worktree-sidebar-rail-overflow-at-narrow-widths",
  },
  { slug: "branch-pending", project: { name: "Daintree", emoji: "🌴" } },
  { slug: "no-git", project: { name: "Notes", emoji: "📝", gitBacked: false } },
  { slug: "scratch", scratch: { name: "Scratch 3" } },
  { slug: "none" },
  { slug: "hover", project: { name: "Daintree", emoji: "🌴" }, branch: "develop" },
  { slug: "open", project: { name: "Daintree", emoji: "🌴" }, branch: "develop", open: true },
  { slug: "focus", project: { name: "Daintree", emoji: "🌴" }, branch: "develop" },
  {
    slug: "narrow",
    project: { name: "Daintree", emoji: "🌴" },
    branch: "design/project-pill",
    width: 640,
  },
];

const DEFAULT_WIDTH = 1100;

function PillRow({ fixture }: { fixture: Fixture }) {
  const identity = activeWorkspaceIdentity(fixture.project ?? null, fixture.scratch ?? null);
  const chipState = branchChipState(
    identity.kind,
    fixture.branch,
    fixture.project?.gitBacked ?? true
  );
  return (
    <div data-shot={fixture.slug} className="flex flex-col gap-1 py-2">
      <div className="px-4 font-mono text-2xs text-text-muted">{fixture.slug}</div>
      <BrandSurface surface="surface-toolbar">
        <div
          data-preview-strip=""
          className="@container/toolbar relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-3 h-12 items-center px-4 shrink-0 surface-toolbar border-y border-divider"
          style={{ width: fixture.width ?? DEFAULT_WIDTH }}
        >
          <div />
          <div className="relative flex items-center justify-center min-w-0 max-w-full justify-self-center">
            <ToolbarProjectPill
              workspaceIdentity={identity}
              emoji={fixture.project?.emoji}
              chipState={chipState}
              branchName={fixture.branch}
              truncatedBranchName={fixture.branch ? middleTruncate(fixture.branch, 24) : undefined}
              isDropdownOpen={fixture.open ?? false}
              data-state={fixture.open ? "open" : "closed"}
            />
          </div>
          <div />
        </div>
      </BrandSurface>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    // index.css pins html/body to the viewport; a sheet taller than it would be
    // clipped out of every element capture below the fold.
    for (const el of [document.documentElement, document.body]) {
      el.style.height = "auto";
      el.style.overflow = "visible";
    }
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <TooltipProvider>
      <div data-preview-shell="" className="flex flex-col py-2">
        {FIXTURES.map((fixture) => (
          <PillRow key={fixture.slug} fixture={fixture} />
        ))}
      </div>
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
