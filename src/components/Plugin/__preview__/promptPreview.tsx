import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginQuickPickDialog } from "../PluginQuickPickDialog";
import { PluginInputBoxDialog } from "../PluginInputBoxDialog";
import { PluginConfirmPromptDialog } from "../PluginConfirmPromptDialog";
import { requirePromptFixture } from "./promptFixtures";
import "@/index.css";

installPreviewShims();

/**
 * Standalone visual-review harness for the imperative plugin prompts
 * (`host.showQuickPick` / `showInputBox` / `showConfirm`).
 *
 * The three singleton dialogs are mounted as `ModalHostLayer` mounts them, and
 * the fixture pushes one request through `pluginPromptStore.enqueue` — the same
 * seam the IPC listener feeds. The resolved value lands on
 * `window.__promptResult` so the spec can assert what the plugin would receive.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=qp-basic         one state (see promptFixtures.ts)
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

requirePromptFixture(params.get("fixture") ?? "qp-basic").seed();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="h-screen w-screen">
        <PluginQuickPickDialog />
        <PluginInputBoxDialog />
        <PluginConfirmPromptDialog />
      </div>
    </TooltipProvider>
  </StrictMode>
);
