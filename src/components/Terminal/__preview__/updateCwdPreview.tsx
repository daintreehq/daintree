import "./updateCwdShims";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { UpdateCwdDialog } from "../UpdateCwdDialog";
import "@/index.css";

/**
 * Standalone visual-review harness for the update-working-directory dialog.
 *
 * In the app the dialog is reached only after a terminal's folder has been
 * deleted out from under it and a restart has failed. This mounts the real
 * dialog against the real panel store and `index.css`, with the directory
 * check answered by the shim and the restart answered here, so every state the
 * submit path can reach can be photographed.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…     built-in theme id
 *   ?cwd=short|long             which missing directory the terminal had
 *   ?check=ok|hang|error        how `system.checkDirectory` answers (see the shim)
 *   ?restart=ok|fail            how the restart answers
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

const CWDS: Record<string, string> = {
  short: "/Users/greg/Projects/daintree-worktrees/fix-auth-refresh",
  long: "/Users/greg/Projects/Daintree/daintree-worktrees/feature-issue-12486-handback-marker-contract/packages/plugin-sdk/src/runtime",
};
const cwd = CWDS[params.get("cwd") ?? "short"] ?? CWDS.short!;

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

useProjectStore.setState({
  currentProject: {
    id: "proj-daintree",
    path: "/Users/greg/Projects/daintree",
    name: "Daintree",
    emoji: "🌳",
    lastOpened: Date.now(),
  },
});

usePanelStore.setState({
  updateTerminalCwd: () => undefined,
  restartTerminal: () =>
    params.get("restart") === "fail"
      ? Promise.reject(new Error("spawn failed"))
      : Promise.resolve(),
});

/** Panel-shaped boxes behind the scrim, so the dialog is judged over an app rather than a void. */
function BackdropGrid() {
  return (
    <div
      data-harness-decoration
      aria-hidden="true"
      className="grid h-screen gap-1 p-1"
      style={{
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        backgroundColor: "var(--color-grid-bg)",
      }}
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-default bg-surface-panel"
        >
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-divider px-3">
            <div className="h-3 w-3 rounded-full bg-overlay-subtle" />
            <div className="h-3 w-24 rounded-sm bg-overlay-subtle" />
          </div>
          <div className="flex-1 p-3 font-mono text-xs leading-5 text-text-muted">
            <div>$ npm run dev</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <div data-preview-shell>
      <BackdropGrid />
      <UpdateCwdDialog
        isOpen={open}
        terminalId="t1"
        currentCwd={cwd}
        onClose={() => {
          setOpen(false);
          document.documentElement.dataset.dialogClosed = "true";
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
