// First: the bridge must exist before any client module reads it.
import "./clonePreview";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CloneRepoDialog } from "../CloneRepoDialog";
import { CreateProjectFolderDialog } from "../CreateProjectFolderDialog";
import { GitInitDialog } from "../GitInitDialog";
import "@/index.css";

const params = new URLSearchParams(window.location.search);
applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

/** `?dialog=` picks which project-entry twin to render; they share one field module. */
const dialog = params.get("dialog") ?? "clone";

function Preview() {
  return (
    <div data-preview-shell className="h-screen w-screen">
      {dialog === "create-folder" ? (
        <CreateProjectFolderDialog isOpen onClose={() => undefined} />
      ) : dialog === "git-init" ? (
        <GitInitDialog
          isOpen
          directoryPath="/Users/you/Code/helios-dashboard"
          onSuccess={() => undefined}
          onCancel={() => undefined}
        />
      ) : (
        <CloneRepoDialog isOpen onSuccess={() => undefined} onCancel={() => undefined} />
      )}
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
