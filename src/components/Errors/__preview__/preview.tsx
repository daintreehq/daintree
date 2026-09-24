import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { CompactErrorList } from "../CompactErrorList";
import {
  ERROR_BANNER_SCENES,
  requireErrorBannerScene,
  type ErrorBannerScene,
} from "./errorBannerFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the compact error banner and the list
 * that stacks it.
 *
 * The list has exactly two hosts — the strip above a terminal pane's output and
 * the details disclosure of a worktree card — and each only fills when its own
 * operations fail, so nobody sees the states side by side. This mounts the real
 * `CompactErrorList` in stand-ins for both hosts, against the real theme tokens
 * and `index.css`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…      built-in theme id
 *   ?scene=terminal-overflow     one scene on its own (default: every scene)
 *
 * The pane chrome, terminal lines and card header are harness decoration. The
 * strip wrapper around the terminal list mirrors `TerminalPane`'s own.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const sceneName = params.get("scene");

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

const noop = () => undefined;

function List({ scene }: { scene: ErrorBannerScene }) {
  return (
    <CompactErrorList
      errors={scene.errors}
      maxInline={scene.maxInline}
      onDismiss={noop}
      onRetry={scene.retry ? noop : undefined}
      onCancelRetry={noop}
    />
  );
}

function TerminalHost({ scene }: { scene: ErrorBannerScene }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-divider bg-surface-panel"
      style={{ width: scene.width }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3 text-xs surface-toolbar"
      >
        <span className="h-3 w-3 rounded-full bg-overlay-medium" />
        <span className="truncate font-medium text-text-primary">Claude — tighten auth retries</span>
      </div>
      <div
        data-banner-slot
        className="px-2 py-1 border-b border-border-default bg-[color-mix(in_oklab,var(--color-status-error)_5%,transparent)] shrink-0"
      >
        <List scene={scene} />
      </div>
      <div
        data-harness-decoration
        aria-hidden="true"
        className="bg-surface-canvas px-3 py-2 font-mono text-xs leading-5 text-text-secondary"
        style={{ minHeight: 72 }}
      >
        <div>~/Projects/daintree on develop</div>
        <div>$ git push</div>
      </div>
    </div>
  );
}

function CardHost({ scene }: { scene: ErrorBannerScene }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-divider bg-surface-panel"
      style={{ width: scene.width }}
    >
      <div
        data-harness-decoration
        aria-hidden="true"
        className="flex flex-col gap-1 px-3 pt-2.5 pb-2 text-xs"
      >
        <span className="font-medium text-sm text-text-primary">feature/auth-retries</span>
        <span className="text-text-secondary">3 files changed · 2 ahead</span>
      </div>
      <div data-banner-slot className="px-3 pb-2.5 space-y-4">
        <List scene={scene} />
        <div
          data-harness-decoration
          aria-hidden="true"
          className="border-l border-divider pl-2 text-xs text-text-secondary"
        >
          Tighten the retry budget on the auth refresh path.
        </div>
      </div>
    </div>
  );
}

function Scene({ scene }: { scene: ErrorBannerScene }) {
  return (
    <div data-scene={scene.name} className="flex flex-col gap-1">
      <div
        data-harness-decoration
        className="font-mono text-2xs uppercase tracking-wide text-text-muted"
      >
        {scene.name} — {scene.what}
      </div>
      {scene.host === "terminal" ? <TerminalHost scene={scene} /> : <CardHost scene={scene} />}
    </div>
  );
}

function Sheet({ scenes }: { scenes: ErrorBannerScene[] }) {
  const widest = Math.max(...scenes.map((s) => s.width));
  return (
    <div data-preview-shell className="flex flex-col gap-5 p-4" style={{ width: widest + 32 }}>
      {scenes.map((scene) => (
        <Scene key={scene.name} scene={scene} />
      ))}
    </div>
  );
}

const scenes = sceneName ? [requireErrorBannerScene(sceneName)] : ERROR_BANNER_SCENES;

// The overflow disclosure is a Radix popover, which loads lazily.
void primeRadix().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider>
        <Sheet scenes={scenes} />
      </TooltipProvider>
    </StrictMode>
  );
});
