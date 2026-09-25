import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import {
  TERMINAL_BANNER_FIXTURES,
  requireTerminalBannerFixture,
  type TerminalBannerFixture,
} from "./terminalBannerFixtures";
import "@/index.css";

installPreviewShims();
try {
  window.localStorage.clear();
} catch {
  // Storage can be unavailable; the harness renders without it.
}

/**
 * Standalone visual-review harness for the in-panel terminal banner family.
 *
 * These banners live inside one terminal pane each, and a pane only ever shows
 * the one its own failure produced — so the family has never been seen side by
 * side. This page renders the real banner components inside a stand-in pane
 * (header, terminal body, input bar) at the width a grid gives it, against the
 * real theme tokens and `index.css`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…      built-in theme id
 *   ?width=560                   pane width in CSS px
 *   ?group=errors|status         a sheet of every fixture in that group
 *   ?fixture=spawn-enoent        one fixture on its own
 *
 * The pane header, terminal lines and input bar are harness decoration.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "560");
const group = params.get("group");
const fixtureName = params.get("fixture");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

const TERMINAL_LINES = [
  "~/Projects/daintree on develop",
  "$ npm run dev",
  "> daintree@0.9.0 dev",
  "> concurrently -k npm:dev:main npm:dev:renderer",
];

function PaneHeader({ title }: { title: string }) {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs text-text-secondary surface-toolbar"
    >
      <span className="h-3 w-3 rounded-full bg-overlay-medium" />
      <span className="truncate font-medium text-text-primary">{title}</span>
    </div>
  );
}

function TerminalBody() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex-1 bg-surface-canvas px-3 py-2 font-mono text-xs leading-5 text-text-secondary"
      style={{ minHeight: 88 }}
    >
      {TERMINAL_LINES.map((line) => (
        <div key={line} className="truncate">
          {line}
        </div>
      ))}
    </div>
  );
}

function InputBar() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-10 shrink-0 items-center border-t border-divider px-3 text-xs text-text-muted"
    >
      Message Claude…
    </div>
  );
}

function Pane({ fixture, children }: { fixture: TerminalBannerFixture; children: ReactNode }) {
  const bottom = fixture.placement === "bottom";
  return (
    <div data-fixture={fixture.name} className="flex flex-col gap-1">
      <div
        data-harness-decoration
        className="font-mono text-2xs uppercase tracking-wide text-text-muted"
      >
        {fixture.name} — {fixture.what}
      </div>
      <div
        data-pane
        className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
        style={{ width }}
      >
        <PaneHeader title={bottom ? "Claude — tighten auth retries" : "zsh — daintree"} />
        {!bottom && <div data-banner-slot>{children}</div>}
        <TerminalBody />
        {bottom && <div data-banner-slot>{children}</div>}
        {bottom && <InputBar />}
      </div>
    </div>
  );
}

function Sheet({ fixtures }: { fixtures: TerminalBannerFixture[] }) {
  return (
    <div data-preview-shell className="flex flex-col gap-5 p-4" style={{ width: width + 32 }}>
      {fixtures.map((fixture) => (
        <Pane key={fixture.name} fixture={fixture}>
          {fixture.render()}
        </Pane>
      ))}
    </div>
  );
}

const fixtures = fixtureName
  ? [requireTerminalBannerFixture(fixtureName)]
  : TERMINAL_BANNER_FIXTURES.filter((f) => !group || f.group === group);

// Radix loads lazily; a tooltip that mounts before its provider has the
// primitives throws, so prime them before the first render.
void primeRadix().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <Sheet fixtures={fixtures} />
      </TooltipProvider>
    </StrictMode>
  );
});
