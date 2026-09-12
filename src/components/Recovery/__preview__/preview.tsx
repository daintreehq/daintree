import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WindowControlsInsetProvider } from "@/components/ui/WindowControlsInset";
import { isMac, isWindows } from "@/lib/platform";
import { GlobalBannerCoordinator } from "../GlobalBannerCoordinator";
import { HostCrashBanner } from "../HostCrashBanner";
import { WatchdogDisabledBanner } from "../WatchdogDisabledBanner";
import { HostMemoryStallBanner } from "../HostMemoryStallBanner";
import { SafeModeBanner } from "../SafeModeBanner";
import { RestoreConfirmationBanner } from "../RestoreConfirmationBanner";
import { MissingPrerequisiteBanner } from "../MissingPrerequisiteBanner";
import { ForgeTokenBanner } from "../ForgeTokenBanner";
import { CloudSyncBanner } from "../CloudSyncBanner";
import { RosettaBanner } from "../RosettaBanner";
import { PluginDocumentWarning } from "@/components/Plugin/PluginDocumentWarning";
import type { GlobalBannerSlot } from "../useGlobalBannerPriority";
import { BANNER_FIXTURES, SHEET_ROWS, requireBannerFixture } from "./bannerFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the global banner family.
 *
 * Only one of these banners ever holds the top-of-window slot, so in the real
 * app no two of them can be seen together — which is how ten banners came to
 * disagree with each other without anyone noticing. This page renders them
 * against the real stores, the real theme tokens and the real `index.css`,
 * in the band they actually occupy: pinned above the toolbar, sharing the row
 * with the OS window controls.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=host-crash       one state, rendered through GlobalBannerCoordinator
 *   ?fixture=sheet            every slot at once, one canonical state each
 *   ?width=1100               window width in CSS px
 *
 * The traffic lights and the toolbar strip are harness decoration, drawn so a
 * reviewer can judge the banner's relationship to the chrome it shares the
 * band with. They are not the app's.
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("width") ?? "1100");
const fixtureName = params.get("fixture") ?? "sheet";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
// `index.css` pins the document to the window, as the app needs. The sheet is
// taller than any viewport, and an element screenshot of a clipped document is
// a picture of the fold with the rows below it silently missing.
for (const el of [document.documentElement, document.body]) {
  el.style.height = "auto";
  el.style.minHeight = "100vh";
  el.style.overflow = "visible";
}

/** macOS traffic lights sit in the 80px the inset reserves; Windows caption buttons in the 138px on the right. */
function WindowControlsDecoration() {
  if (isMac()) {
    return (
      <div
        data-harness-decoration
        aria-hidden="true"
        className="pointer-events-none absolute left-[13px] top-[18px] z-10 flex gap-2"
      >
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>
    );
  }
  if (isWindows()) {
    return (
      <div
        data-harness-decoration
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-0 z-10 flex h-12 w-[138px] items-center justify-around text-text-secondary"
      >
        <span>—</span>
        <span>▢</span>
        <span>✕</span>
      </div>
    );
  }
  return null;
}

/** A stand-in for the toolbar row beneath, so the banner's bottom edge has something to meet. */
function ToolbarStrip() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="flex h-12 shrink-0 items-center gap-2 border-b border-divider px-4 pt-1 surface-toolbar"
    >
      <div className="h-6 w-24 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="h-6 w-6 rounded-[var(--radius-md)] bg-overlay-subtle" />
      <div className="ml-auto h-6 w-32 rounded-[var(--radius-md)] bg-overlay-subtle" />
    </div>
  );
}

function BannerHost({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div data-banner-host className="relative">
      {label && (
        <div
          data-harness-decoration
          className="px-3 pb-1 pt-3 font-mono text-2xs uppercase tracking-wide text-text-muted"
        >
          {label}
        </div>
      )}
      <div className="relative">
        <WindowControlsDecoration />
        <div data-banner-slot>{children}</div>
      </div>
      <ToolbarStrip />
    </div>
  );
}

function bannerForSlot(slot: Exclude<GlobalBannerSlot, null>) {
  switch (slot) {
    case "host-crash":
      return <HostCrashBanner />;
    case "watchdog-disabled":
      return <WatchdogDisabledBanner />;
    case "host-memory-stall":
      return <HostMemoryStallBanner />;
    case "safe-mode":
      return <SafeModeBanner />;
    case "restore-confirmation":
      return <RestoreConfirmationBanner />;
    case "missing-prerequisite":
      return <MissingPrerequisiteBanner />;
    case "forge-token":
      return <ForgeTokenBanner />;
    case "plugin-document":
      return <PluginDocumentWarning />;
    case "cloud-sync":
      return <CloudSyncBanner />;
    case "rosetta":
      return <RosettaBanner />;
  }
}

function Sheet() {
  return (
    <div data-preview-shell className="flex flex-col gap-4 pb-6" style={{ width: `${width}px` }}>
      {SHEET_ROWS.map((name) => (
        <BannerHost key={name} label={`${name} — ${BANNER_FIXTURES[name].what}`}>
          <WindowControlsInsetProvider onSeverityChange={() => undefined}>
            {bannerForSlot(BANNER_FIXTURES[name].slot)}
          </WindowControlsInsetProvider>
        </BannerHost>
      ))}
    </div>
  );
}

function Single() {
  return (
    <div data-preview-shell className="flex flex-col" style={{ width: `${width}px` }}>
      <BannerHost>
        <GlobalBannerCoordinator />
      </BannerHost>
      <div className="h-24" />
    </div>
  );
}

// Seed before mounting: a store write during render is a cross-component
// update React rightly complains about, and the banners read on first render.
if (fixtureName === "sheet") {
  for (const name of SHEET_ROWS) BANNER_FIXTURES[name].seed();
} else {
  requireBannerFixture(fixtureName).seed();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>{fixtureName === "sheet" ? <Sheet /> : <Single />}</TooltipProvider>
  </StrictMode>
);
