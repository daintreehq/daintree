import { AlertTriangle, Settings } from "lucide-react";
import { DaintreeIcon } from "@/components/icons";
import { ProjectPulseCard } from "@/components/Pulse";
import { svgToDataUrl, sanitizeSvg } from "@/lib/svg";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { RotatingTip } from "./contentGridTips";
import { RecipeRunner } from "./RecipeRunner/RecipeRunner";

export function ContentGridEmptyState({
  hasActiveWorktree,
  activeWorktreeName,
  activeWorktreeId,
  showProjectPulse,
  projectIconSvg,
  defaultCwd,
}: {
  hasActiveWorktree: boolean;
  activeWorktreeName?: string | null;
  activeWorktreeId?: string | null;
  showProjectPulse: boolean;
  projectIconSvg?: string;
  defaultCwd?: string;
}) {
  "use memo";

  const hasEverLaunchedAgent = usePanelStore((state) =>
    state.panelIds.some((id) => {
      const p = state.panelsById[id];
      return (
        Boolean(p?.launchAgentId) || Boolean(p?.detectedAgentId) || p?.everDetectedAgent === true
      );
    })
  );

  const handleOpenHelp = () => {
    void actionService.dispatch(
      "system.openExternal",
      { url: "https://github.com/daintreehq/daintree#readme" },
      { source: "user" }
    );
  };

  const handleOpenProjectSettings = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", {
        detail: { tab: "project:general" },
      })
    );
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-3xl w-full flex flex-col items-center">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="relative group mb-4">
            {projectIconSvg ? (
              (() => {
                const sanitized = sanitizeSvg(projectIconSvg);
                if (!sanitized.ok) {
                  return <DaintreeIcon className="h-28 w-28 text-tint/65" />;
                }
                return (
                  <img
                    src={svgToDataUrl(sanitized.svg)}
                    alt="Project icon"
                    className="h-28 w-28 object-contain"
                  />
                );
              })()
            ) : (
              <DaintreeIcon className="h-28 w-28 text-tint/65" />
            )}
            {hasActiveWorktree && (
              <button
                type="button"
                onClick={handleOpenProjectSettings}
                className="absolute -bottom-1 -right-1 p-1.5 bg-daintree-sidebar border border-daintree-border rounded-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-daintree-bg focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-daintree-accent"
                aria-label="Change project icon"
              >
                <Settings className="h-3 w-3 text-daintree-text/70" />
              </button>
            )}
          </div>
          <h3 className="text-2xl font-semibold text-daintree-text tracking-tight mb-3">
            {activeWorktreeName || "Daintree"}
          </h3>
          {!activeWorktreeName && (
            <p className="text-sm text-daintree-text/60 max-w-md leading-relaxed font-medium">
              A habitat for your AI agents.
            </p>
          )}
        </div>

        {!hasActiveWorktree && (
          <div
            className="flex items-center gap-2 text-xs text-status-warning bg-status-warning/10 border border-status-warning/20 rounded px-3 py-2 mb-6 max-w-md text-center"
            role="status"
            aria-live="polite"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Select a worktree in the sidebar to set the working directory for agents</span>
          </div>
        )}

        {hasActiveWorktree && hasEverLaunchedAgent && (
          <div className="mb-6 w-full flex justify-center">
            <RecipeRunner activeWorktreeId={activeWorktreeId} defaultCwd={defaultCwd} />
          </div>
        )}

        {showProjectPulse && hasActiveWorktree && activeWorktreeId && (
          <div className="flex justify-center mb-8">
            <ProjectPulseCard worktreeId={activeWorktreeId} />
          </div>
        )}

        <div className="flex flex-col items-center gap-4 mt-4">
          {hasActiveWorktree && hasEverLaunchedAgent && <RotatingTip />}

          {!hasActiveWorktree && (
            <button
              type="button"
              onClick={handleOpenHelp}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-tint/5 transition-colors group focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-daintree-accent/50"
            >
              <div className="w-0 h-0 border-t-[2.5px] border-t-transparent border-l-[5px] border-l-daintree-text/50 border-b-[2.5px] border-b-transparent group-hover:border-l-daintree-text/70 transition-colors" />
              <span className="text-xs text-daintree-text/50 group-hover:text-daintree-text/70 transition-colors">
                View documentation
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
