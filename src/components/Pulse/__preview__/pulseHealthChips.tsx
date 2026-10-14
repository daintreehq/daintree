import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { PulseHealthSignals } from "../PulseHealthSignals";
import "@/index.css";

/**
 * Standalone visual-review harness for the Project Pulse card's health-chip
 * strip.
 *
 * Mounts the REAL `PulseHealthSignals` inside the card's own frame (`.pulse-card`
 * surface, `p-4` body, the ruled `min-h-9` health section) once per fixture, so
 * one page shows every state at one card width. The states that matter — a
 * failing build, open security alerts, four-digit counts, a long prerelease tag —
 * are ones a real repository reaches rarely and never on demand.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?width=<card width in px>   default 480
 *   ?only=<fixture[,fixture]>   render a subset
 */

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function health(overrides: Partial<ForgeProjectHealthPayload>): ForgeProjectHealthPayload {
  return {
    hasRemote: true,
    loading: false,
    ciStatus: "success",
    issueCount: 12,
    prCount: 3,
    latestRelease: { tagName: "v2.4.1", publishedAt: ago(5), url: "https://example.com/r" },
    securityAlerts: { visible: true, count: 0 },
    mergeVelocity: { mergedCounts: { 60: 14, 120: 31, 180: 47 } },
    repoUrl: "https://github.com/acme/helios",
    ...overrides,
  };
}

export const FIXTURES: Record<
  string,
  { what: string; health: ForgeProjectHealthPayload; rangeDays?: 60 | 120 | 180 }
> = {
  healthy: { what: "all healthy — CI passing, routine counts", health: health({}) },
  "ci-failing": {
    what: "CI failing",
    health: health({ ciStatus: "failure" }),
  },
  security: {
    what: "CI failing and 3 open security alerts",
    health: health({ ciStatus: "failure", securityAlerts: { visible: true, count: 3 } }),
  },
  pending: {
    what: "CI running, one security alert",
    health: health({ ciStatus: "pending", securityAlerts: { visible: true, count: 1 } }),
  },
  zero: {
    what: "zero counts, nothing merged, no CI",
    health: health({
      ciStatus: "none",
      issueCount: 0,
      prCount: 0,
      mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
    }),
  },
  large: {
    what: "a big public repo — four-digit counts",
    health: health({
      issueCount: 1_342,
      prCount: 287,
      mergeVelocity: { mergedCounts: { 60: 1_204, 120: 2_310, 180: 3_100 } },
    }),
  },
  "long-release": {
    what: "a long prerelease tag",
    health: health({
      latestRelease: {
        tagName: "v12.0.0-beta.17+build.20261012.sha.4f3a9c2",
        publishedAt: ago(2),
        url: "https://example.com/r",
      },
    }),
  },
  "old-release": {
    what: "a release from last year beside a four-digit 180-day merged count",
    rangeDays: 180,
    health: health({
      latestRelease: {
        tagName: "v3.18.0-rc.2",
        publishedAt: ago(420),
        url: "https://example.com/r",
      },
      mergeVelocity: { mergedCounts: { 60: 900, 120: 2_000, 180: 3_100 } },
    }),
  },
  "no-release": {
    what: "no releases",
    health: health({ latestRelease: null, issueCount: 1, prCount: 1 }),
  },
};

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "480");
const only = params.get("only")?.split(",").filter(Boolean);
const names = Object.keys(FIXTURES).filter((n) => !only || only.includes(n));

installPreviewShims();
applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function Preview() {
  return (
    <div data-preview-shell className="flex flex-col gap-3 p-4" style={{ width: width + 32 }}>
      {names.map((name) => (
        <section key={name} data-fixture={name} className="flex flex-col gap-1">
          <span className="font-mono text-3xs text-text-muted">
            {name} — {FIXTURES[name]!.what}
          </span>
          <div
            className="pulse-card w-full min-w-0 rounded-[var(--radius-lg)] border border-border-default p-4"
            style={{ width }}
          >
            <p className="text-xs text-text-primary">14 commits this week across 3 branches.</p>
            <div className="mt-4 border-t border-border-default pt-3 min-h-9">
              <PulseHealthSignals
                health={FIXTURES[name]!.health}
                rangeDays={FIXTURES[name]!.rangeDays ?? 60}
              />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
