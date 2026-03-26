import { useMemo } from "react";
import {
  FolderOpen,
  FolderPlus,
  Rocket,
  Check,
  Download,
  Newspaper,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CanopyIcon } from "@/components/icons";
import { useProjectStore } from "@/store/projectStore";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { getProjectGradient } from "@/lib/colorUtils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { CHECKLIST_ITEMS } from "@/components/Onboarding/checklistItems";
import type { GettingStartedChecklistState } from "@/hooks/app/useGettingStartedChecklist";

interface WelcomeScreenProps {
  gettingStarted: GettingStartedChecklistState;
}

const SHORTCUT_TIPS: { label: string; actionId: string }[] = [
  { label: "New Panel", actionId: "panel.palette" },
  { label: "Quick Switcher", actionId: "nav.quickSwitcher" },
  { label: "New Terminal", actionId: "terminal.new" },
  { label: "Command Palette", actionId: "action.palette" },
  { label: "Keyboard Shortcuts", actionId: "help.shortcuts" },
  { label: "Settings", actionId: "app.settings" },
];

export function WelcomeScreen({ gettingStarted }: WelcomeScreenProps) {
  const addProject = useProjectStore((state) => state.addProject);
  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);

  const projects = useProjectStore((state) => state.projects);
  const switchProject = useProjectStore((state) => state.switchProject);

  const recentProjects = useMemo(
    () => [...projects].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 5),
    [projects]
  );

  const hasProjects = recentProjects.length > 0;
  const { checklist } = gettingStarted;

  const completedCount = checklist ? Object.values(checklist.items).filter(Boolean).length : 0;
  const allDone = checklist ? Object.values(checklist.items).every(Boolean) : false;
  const showChecklist = gettingStarted.visible && checklist && !checklist.dismissed && !allDone;
  const progressTotal = 4; // 3 real items + endowed "Install Canopy"
  const progressDone = 1 + completedCount; // endowed item always complete

  return (
    <div className="flex flex-col items-center h-full w-full overflow-y-auto animate-in fade-in duration-500">
      <div className="max-w-2xl w-full flex flex-col items-center px-8 py-12 gap-10">
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <CanopyIcon className="h-16 w-16 text-tint/80 mb-6" />
          <h1 className="text-2xl font-semibold text-canopy-text tracking-tight mb-2">
            Welcome to Canopy
          </h1>
          <p className="text-sm text-canopy-text/60 leading-relaxed font-medium">
            A habitat for your AI agents.
          </p>
        </div>

        {/* Adaptive layout: returning users see projects first, new users see checklist first */}
        {hasProjects ? (
          <>
            <RecentProjects projects={recentProjects} onSelect={switchProject} />
            {showChecklist && (
              <InlineChecklist
                checklist={checklist}
                progressDone={progressDone}
                progressTotal={progressTotal}
              />
            )}
          </>
        ) : (
          <>
            {showChecklist && (
              <InlineChecklist
                checklist={checklist}
                progressDone={progressDone}
                progressTotal={progressTotal}
              />
            )}
          </>
        )}

        {/* Quick Actions */}
        <div className="w-full">
          <div className="flex flex-wrap gap-3 justify-center">
            <Button size="lg" onClick={() => void addProject()}>
              <FolderOpen />
              Open Folder
            </Button>
            <Button size="lg" variant="outline" onClick={openCreateFolderDialog}>
              <FolderPlus />
              Create Project
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() =>
                void actionService.dispatch("panel.palette", undefined, {
                  source: "user",
                })
              }
            >
              <Rocket />
              Launch Agent
            </Button>
          </div>
        </div>

        {/* Keyboard Shortcuts */}
        <div className="w-full">
          <h3 className="text-xs font-medium text-canopy-text/50 uppercase tracking-wider mb-3">
            Keyboard Shortcuts
          </h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2">
            {SHORTCUT_TIPS.map(({ label, actionId }) => {
              const combo = keybindingService.getDisplayCombo(actionId);
              if (!combo) return null;
              return (
                <div key={actionId} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-canopy-text/70">{label}</span>
                  <kbd className="shrink-0 bg-canopy-bg border border-canopy-border rounded px-1.5 py-0.5 text-xs font-mono text-canopy-text/80 shadow-sm">
                    {combo}
                  </kbd>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 text-xs text-canopy-text/40 pt-2">
          <button
            type="button"
            onClick={() =>
              void window.electron?.system?.openExternal("https://canopyide.com/newsletter")
            }
            className="flex items-center gap-1.5 hover:text-canopy-text/60 transition-colors"
          >
            <Newspaper className="h-3 w-3" />
            Newsletter
            <ExternalLink className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Sub-sections ---------- */

function RecentProjects({
  projects,
  onSelect,
}: {
  projects: ReturnType<typeof useProjectStore.getState>["projects"];
  onSelect: (projectId: string) => Promise<void>;
}) {
  return (
    <div className="w-full">
      <h3 className="text-xs font-medium text-canopy-text/50 uppercase tracking-wider mb-3">
        Recent Projects
      </h3>
      <div className="space-y-1">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => void onSelect(project.id)}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] text-left transition-colors",
              "hover:bg-overlay-soft",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            )}
          >
            <div
              className="flex items-center justify-center rounded-[var(--radius-lg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 h-8 w-8 text-base"
              style={{
                background: project.color
                  ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(project.color)}`
                  : "linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), var(--color-canopy-sidebar)",
              }}
            >
              <span className="leading-none select-none filter drop-shadow-sm">
                {project.emoji}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-semibold text-canopy-text/85 truncate block">
                {project.name}
              </span>
              <span className="text-xs text-canopy-text/40 truncate block">{project.path}</span>
            </div>
            <span className="text-xs text-canopy-text/40 shrink-0">
              {formatTimeAgo(project.lastOpened)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InlineChecklist({
  checklist,
  progressDone,
  progressTotal,
}: {
  checklist: NonNullable<GettingStartedChecklistState["checklist"]>;
  progressDone: number;
  progressTotal: number;
}) {
  return (
    <div className="w-full">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-xs font-medium text-canopy-text/50 uppercase tracking-wider">
          Getting Started
        </h3>
        <span className="text-[10px] text-canopy-text/40 font-mono">
          {progressDone}/{progressTotal}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 bg-canopy-border/50 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-canopy-accent rounded-full transition-all duration-500"
          style={{ width: `${(progressDone / progressTotal) * 100}%` }}
        />
      </div>

      <div className="space-y-1">
        {/* Endowed progress: Install Canopy (always complete) */}
        <div className="flex items-center gap-2.5 px-2 py-1.5 opacity-60">
          <div className="h-4 w-4 rounded-full bg-canopy-accent border border-canopy-accent flex items-center justify-center shrink-0">
            <Check className="h-2.5 w-2.5 text-canopy-bg" />
          </div>
          <Download className="h-3.5 w-3.5 text-canopy-text/40 shrink-0" />
          <span className="text-xs leading-snug text-canopy-text/40">Install Canopy</span>
        </div>

        {/* Real checklist items */}
        {CHECKLIST_ITEMS.map(({ id, label, icon: Icon, actionId }) => {
          const done = checklist.items[id];

          const content = (
            <>
              <div
                className={cn(
                  "h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors duration-200",
                  done ? "bg-canopy-accent border-canopy-accent" : "border-canopy-text/30"
                )}
              >
                {done && <Check className="h-2.5 w-2.5 text-canopy-bg" />}
              </div>
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  done ? "text-canopy-text/40" : "text-canopy-text/70"
                )}
              />
              <span
                className={cn(
                  "text-xs leading-snug",
                  done ? "text-canopy-text/40" : "text-canopy-text/90"
                )}
              >
                {label}
              </span>
            </>
          );

          const sharedClasses = cn(
            "flex items-center gap-2.5 rounded-[var(--radius-xs)] px-2 py-1.5",
            "transition-colors duration-200",
            done ? "opacity-60" : "opacity-100"
          );

          if (done) {
            return (
              <div key={id} className={sharedClasses}>
                {content}
              </div>
            );
          }

          return (
            <button
              key={id}
              type="button"
              onClick={() =>
                void actionService.dispatch(actionId, undefined, {
                  source: "user",
                })
              }
              className={cn(
                sharedClasses,
                "w-full text-left cursor-pointer",
                "hover:bg-tint/10",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
              )}
            >
              {content}
            </button>
          );
        })}
      </div>
    </div>
  );
}
