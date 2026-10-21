// First: the bridge must exist before the card reads onboarding state.
import "./inviteShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TourInviteCard } from "../TourInviteCard";
import "@/index.css";

/**
 * Visual-review harness for the tour's invitation on the empty panel grid.
 *
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?chapter=<n>              seed a tour stopped at chapter n (resume copy)
 *   ?measure=<rem>            column width (default 38, the launcher measure)
 *
 * The card sits in the canvas column at the launcher's measure, the way
 * `ContentGridEmptyState` places it, minus the section entry motion.
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";
const measure = Number(params.get("measure") ?? 38);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <div className="flex min-h-screen items-start justify-center px-6 pt-10">
        <section
          data-preview-frame
          className="flex w-full flex-col items-center px-4 pt-4 pb-14"
          style={{ maxWidth: `${measure + 2}rem` }}
        >
          <TourInviteCard className="flex w-full justify-center" />
        </section>
      </div>
    </TooltipProvider>
  </StrictMode>
);
