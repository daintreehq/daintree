// First: the bridge must exist before any client module reads it.
import { issueShot } from "./issuePickerBridge";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeState } from "@/types";
import { IssuePickerDialog } from "../IssuePickerDialog";
import "@/index.css";

/**
 * Standalone visual-review harness for `IssuePickerDialog`.
 *
 * The real dialog against the real theme tokens and `index.css`, with its one
 * bridge call answered by `issuePickerBridge.ts`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?attached=11957           the worktree's current issue, if any
 *   ?outcome=…                see issuePickerBridge.ts
 *
 * Attach and detach are recorded on `window.__issueShot.last` so a spec can
 * assert what the dialog actually did.
 */

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const attachedParam = Number(params.get("attached"));
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const worktree = {
  id: "/Users/you/Code/helios-dashboard-worktrees/feature-scratch-restore",
  path: "/Users/you/Code/helios-dashboard-worktrees/feature-scratch-restore",
  branch: "feature/scratch-restore",
} as unknown as WorktreeState;

function record(event: string) {
  issueShot.last = event;
}

function Preview() {
  const [open, setOpen] = useState(true);
  return (
    <div data-preview-shell className="h-screen w-screen">
      <IssuePickerDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        worktree={worktree}
        currentIssueNumber={attachedParam > 0 ? attachedParam : undefined}
        onAttach={(issue) => record(`attach:${issue.number}`)}
        onDetach={() => record("detach")}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
