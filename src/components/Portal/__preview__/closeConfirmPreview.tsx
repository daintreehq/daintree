// Before anything can write to a TT-gated DOM sink: Radix injects a `<style>`
// through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePortalPendingCloseStore } from "@/store/portalPendingCloseStore";
import { PortalCloseConfirmDialog } from "../PortalCloseConfirmDialog";
import {
  getCloseConfirmFixture,
  isCloseConfirmFixtureName,
  type CloseConfirmFixtureName,
} from "./closeConfirmFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for `PortalCloseConfirmDialog`.
 *
 * Seeds the pending-close store the bulk-close actions write to, and mounts the
 * real dialog host over the real `ConfirmDialog`, theme tokens and `index.css`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=many-tabs        a key of CLOSE_CONFIRM_FIXTURES
 */

installPreviewShims();

const params = new URLSearchParams(window.location.search);
const requested = params.get("fixture") ?? "";
const fixtureName: CloseConfirmFixtureName = isCloseConfirmFixtureName(requested)
  ? requested
  : "many-tabs";
const fixture = getCloseConfirmFixture(fixtureName);

applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

usePortalPendingCloseStore.getState().request({
  kind: fixture.kind,
  tabsToClose: fixture.tabs,
  keepTabId: fixture.kind === "closeAll" ? undefined : "t-kept",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={0}>
      <div data-fixture={fixtureName} className="h-screen w-screen">
        <PortalCloseConfirmDialog />
      </div>
    </TooltipProvider>
  </StrictMode>
);
