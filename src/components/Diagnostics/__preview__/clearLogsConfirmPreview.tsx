// First: the bridge must exist before any client module reads it.
import "./clearLogsConfirmShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClearLogsConfirmDialog } from "../ClearLogsConfirmDialog";
import "@/index.css";

/**
 * Standalone visual-review harness for `ClearLogsConfirmDialog`: the real dialog
 * over the real `ConfirmDialog`, theme tokens and `index.css`, held open.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…    built-in theme id
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="h-screen w-screen">
        <ClearLogsConfirmDialog isOpen onOpenChange={() => undefined} />
      </div>
    </TooltipProvider>
  </StrictMode>
);
