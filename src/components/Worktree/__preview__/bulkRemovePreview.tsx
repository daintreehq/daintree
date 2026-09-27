// Before anything can write to a TT-gated DOM sink: Radix injects a `<style>`
// through `innerHTML`, which throws without the app's default policy.
import "@/lib/trustedTypesPolicy";
import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeBulkRemoveDialog } from "../WorktreeBulkRemoveDialog";
import { BULK_REMOVE_FIXTURES, isBulkRemoveFixtureName } from "./bulkRemoveFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for `WorktreeBulkRemoveDialog`.
 *
 * The real dialog over the real `ConfirmDialog`, theme tokens and `index.css`,
 * fed a hook snapshot per state. Excluded, blocked and retrying rows need a
 * submodule fixture repo and a failing status read in the full app; here each
 * is one object.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…    built-in theme id
 *   ?fixture=mixed             one state; see bulkRemoveFixtures.ts
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const name = params.get("fixture") ?? "mixed";
const fixture = BULK_REMOVE_FIXTURES[isBulkRemoveFixtureName(name) ? name : "mixed"];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div data-preview-shell className="h-screen w-screen">
        <WorktreeBulkRemoveDialog bulkRemove={fixture.value} />
      </div>
    </TooltipProvider>
  </StrictMode>
);
