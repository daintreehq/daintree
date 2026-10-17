// First: the bridge must exist before any client module reads it.
import { previewState } from "./lifecycleApprovalShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { LifecycleCommandApprovalDialog } from "@/components/Worktree/LifecycleCommandApprovalDialog";
import "@/index.css";

/**
 * Visual-review harness for the repository command approval dialog.
 *
 * Renders the product's own dialog; the shim answers the review and approve
 * requests with fixtures, so the body is whatever the component draws for them.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?state=single|mixed|later|long|many|nothing|loading|load-error|approve-error
 *
 * `later` is `mixed` with no setup waiting on the approval.
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const noop = () => {};

void Promise.all([primeRadix(), import("framer-motion")]).then(
  ([, { LazyMotion, domAnimation }]) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <LazyMotion features={domAnimation}>
          <TooltipProvider>
            <div data-testid="preview-root" />
            <LifecycleCommandApprovalDialog
              isOpen
              worktreeId="/Users/you/Code/helios-dashboard-worktrees/feature-auth-refresh"
              setupAwaitingApproval={previewState !== "later"}
              onClose={noop}
            />
          </TooltipProvider>
        </LazyMotion>
      </StrictMode>
    );
  }
);
