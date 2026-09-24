// First: the bridge must exist before any client module reads it.
import { fixture } from "./destructiveConfirmShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DevPreviewDestructiveConfirmDialog } from "../DevPreviewDestructiveConfirmDialog";
import "@/index.css";

/**
 * Standalone visual-review harness for `DevPreviewDestructiveConfirmDialog`.
 *
 * The real dialog over the real `ConfirmDialog`, theme tokens and `index.css`,
 * served by Vite. Every loading and failure state is reachable without a project
 * on disk because the bridge reads are answered from a fixture.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?fixture=cache-populated   one state; see destructiveConfirmFixtures.ts
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="h-screen w-screen">
        <DevPreviewDestructiveConfirmDialog
          panelId="dev-preview-bbda886a-4f1c"
          projectId="8e8efe1218ac32d2d9784706"
          tier={fixture.tier}
          isOpen
          onClose={() => undefined}
          onConfirm={() => undefined}
        />
      </div>
    </TooltipProvider>
  </StrictMode>
);
