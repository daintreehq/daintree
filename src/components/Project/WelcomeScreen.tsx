import { useMemo, useState } from "react";
import {
  FolderOpen,
  FolderPlus,
  Rocket,
  Check,
  Download,
  Newspaper,
  ExternalLink,
  GitBranch,
  X,
  Plug,
  Pin,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DaintreeIcon } from "@/components/icons";
import { useProjectStore } from "@/store/projectStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { keybindingService } from "@/services/KeybindingService";
import { getProjectGradient, getBrandColorHex } from "@/lib/colorUtils";
import { formatTimeAgo } from "@/utils/timeAgo";
import { CHECKLIST_ITEMS } from "@/components/Onboarding/checklistItems";
import { useAgentDiscoveryOnboarding } from "@/hooks/app/useAgentDiscoveryOnboarding";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { getAgentConfig } from "@/config/agents";
import { BUILT_IN_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import { isAgentReady } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import type { GettingStartedChecklistState } from "@/hooks/app/useGettingStartedChecklist";

interface WelcomeScreenProps {
  gettingStarted: GettingStartedChecklistState;
}

const SHORTCUT_TIPS: { label: string; actionId: string }[] = [
  { label: "New Panel", actionId: "panel.palette" },
  { label: "Quick Switcher", actionId: "nav.quickSwitcher" },
  { label: "New Terminal", actionId: "terminal.new" },
  { label: "Command Palette", actionId: "action.palette.open" },
  { label: "Keyboard Shortcuts", actionId: "help.shortcuts" },
  { label: "Settings", actionId: "app.settings" },
];

export function WelcomeScreen({ gettingStarted }: WelcomeScreenProps) {
  const addProject = useProjectStore((state) => state.addProject);
  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);
  const openCloneRepoDialog = useProjectStore((state) => state.openCloneRepoDialog);

  const projects = useProjectStore((state) => state.projects);
  const switchProject = useProjectStore((state) => state.switchProject);

  const recentProjects = useMemo(
    () => [...projects].sort((a, b) => (b.frecencyScore ?? 0) - (a.frecencyScore ?? 0)).slice(0, 5),
    [projects]
  );

  const hasProjects = recentProjects.length > 0;
  const { checklist } = gettingStarted;

  const completedCount = checklist ? Object.values(checklist.items).filter(Boolean).length : 0;
  const allDone = checklist ? Object.values(checklist.items).every(Boolean) : false;
  const showChecklist = gettingStarted.visible && checklist && !checklist.dismissed && !allDone;
  const progressTotal = 4; // 3 real items + endowed "Install Daintree"
  const progressDone = 1 + completedCount; // endowed item always complete

  const setupBanner = <AgentSetupBannerCard />;
  const welcomeCard = <AgentWelcomeCard />;

  return (
    <div className="flex flex-col items-center h-full w-full overflow-y-auto animate-in fade-in duration-500">
      <div className="max-w-2xl w-full flex flex-col items-center px-8 py-12 gap-10">
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <DaintreeIcon className="h-16 w-16 text-tint/50 mb-6" />
          <h1 className="text-2xl font-semibold text-daintree-text tracking-tight mb-2">
            Welcome to Daintree
          </h1>
          <p className="text-sm text-daintree-text/60 leading-relaxed font-medium">
            A habitat for your AI agents.
          </p>
        </div>

        {/* Adaptive layout: returning users see projects first, new users see checklist first */}
        {hasProjects ? (
          <>
            <RecentProjects projects={recentProjects} onSelect={switchProject} />
            {setupBanner}
            {welcomeCard}
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
            {setupBanner}
            {welcomeCard}
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
            <Button size="lg" variant="outline" onClick={openCloneRepoDialog}>
              <GitBranch />
              Clone Repository
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
          <h3 className="text-xs font-medium text-daintree-text/50 uppercase tracking-wider mb-3">
            Keyboard Shortcuts
          </h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2">
            {SHORTCUT_TIPS.map(({ label, actionId }) => {
              const combo = keybindingService.getDisplayCombo(actionId);
              if (!combo) return null;
              return (
                <div key={actionId} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-daintree-text/70">{label}</span>
                  <kbd className="shrink-0 bg-daintree-bg border border-daintree-border rounded px-1.5 py-0.5 text-xs font-mono text-daintree-text/80 shadow-sm">
                    {combo}
                  </kbd>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 text-xs text-daintree-text/40 pt-2">
          <button
            type="button"
            onClick={() => {
              const promise = window.electron?.system?.openExternal(
                "https://daintree.org/newsletter"
              );
              if (promise) {
                safeFireAndForget(promise, { context: "Opening newsletter link" });
              }
            }}
            className="flex items-center gap-1.5 hover:text-daintree-text/60 transition-colors"
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
      <h3 className="text-xs font-medium text-daintree-text/50 uppercase tracking-wider mb-3">
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
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
            )}
          >
            <div
              className="flex items-center justify-center rounded-[var(--radius-lg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 h-8 w-8 text-base"
              style={{
                background: project.color
                  ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(project.color)}`
                  : "linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), var(--color-daintree-sidebar)",
              }}
            >
              <span className="leading-none select-none filter drop-shadow-sm">
                {project.emoji}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-semibold text-daintree-text/85 truncate block">
                {project.name}
              </span>
              <span className="text-xs text-daintree-text/40 truncate block">{project.path}</span>
            </div>
            <span className="text-xs text-daintree-text/40 shrink-0">
              {formatTimeAgo(project.lastOpened)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentSetupBannerCard() {
  const { loaded, setupBannerDismissed, dismissSetupBanner } = useAgentDiscoveryOnboarding();

  // Gate on hydration to prevent flash-of-content before the persisted
  // dismiss flag arrives from electron-store (see #5111 review).
  if (!loaded) return null;
  if (setupBannerDismissed) return null;

  const handleStartSetup = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-agent-setup-wizard", {
        detail: { isFirstRun: true },
      })
    );
  };

  const handleDismiss = () => {
    void dismissSetupBanner();
  };

  return (
    <div className="w-full" data-testid="agent-setup-banner">
      <div className="relative w-full rounded-[var(--radius-md)] border border-daintree-border/60 bg-daintree-sidebar/40 px-4 py-3.5">
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss agent setup banner"
          data-testid="agent-setup-banner-dismiss"
          className="absolute top-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-daintree-text/40 transition-colors hover:bg-overlay-emphasis hover:text-daintree-text/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="flex items-start gap-3 pr-6">
          <Sparkles className="h-4 w-4 text-daintree-accent mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-daintree-text/90">Set up your AI agents</h3>
            <p className="text-xs text-daintree-text/60 mt-1 leading-relaxed">
              Pick a theme, opt into telemetry, and choose which agents to install. You can skip
              this and come back anytime.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <Button size="sm" onClick={handleStartSetup} data-testid="agent-setup-banner-cta">
                <Sparkles className="h-3.5 w-3.5" />
                Set up agents
              </Button>
              <button
                type="button"
                onClick={handleDismiss}
                className="text-xs text-daintree-text/50 hover:text-daintree-text/80 transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentWelcomeCard() {
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const availability = useCliAvailabilityStore((s) => s.availability);
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);
  const { loaded, welcomeCardDismissed, markAgentsSeen, dismissWelcomeCard } =
    useAgentDiscoveryOnboarding();

  const [busy, setBusy] = useState(false);
  const [pinError, setPinError] = useState(false);

  const readyAgentIds = useMemo<BuiltInAgentId[]>(() => {
    return BUILT_IN_AGENT_IDS.filter((id) => isAgentReady(availability?.[id]));
  }, [availability]);

  const hasNoPinnedAgents = useMemo(() => {
    if (!agentSettings?.agents) return true;
    return !BUILT_IN_AGENT_IDS.some((id) => isAgentPinned(agentSettings.agents[id]));
  }, [agentSettings]);

  if (!hasRealData || !loaded) return null;
  if (welcomeCardDismissed) return null;
  if (readyAgentIds.length === 0 || !hasNoPinnedAgents) return null;

  const handlePinAll = async () => {
    if (busy) return;
    setBusy(true);
    setPinError(false);
    try {
      const targets = readyAgentIds.filter((id) => !isAgentPinned(agentSettings?.agents?.[id]));
      const results = await Promise.allSettled(targets.map((id) => setAgentPinned(id, true)));
      const allOk = results.every((r) => r.status === "fulfilled");
      if (!allOk) {
        // Keep the card visible so the user can retry; surface an inline
        // error instead of silently dropping their "Pin all" click.
        setPinError(true);
        return;
      }
      await markAgentsSeen(readyAgentIds);
      await dismissWelcomeCard();
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    // Await seen-before-dismiss so a crash or quit between the two IPCs
    // can't leave `welcomeCardDismissed: true` + `seenAgentIds: []` —
    // which would mark every ready agent as "new" on next launch.
    void (async () => {
      await markAgentsSeen(readyAgentIds);
      await dismissWelcomeCard();
    })();
  };

  return (
    <div className="w-full">
      <div className="relative w-full rounded-[var(--radius-md)] border border-daintree-border/60 bg-daintree-sidebar/40 px-4 py-3.5">
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss welcome card"
          className="absolute top-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-daintree-text/40 transition-colors hover:bg-overlay-emphasis hover:text-daintree-text/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="flex items-start gap-3 pr-6">
          <Plug className="h-4 w-4 text-daintree-accent mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-daintree-text/90">
              We detected your installed agents
            </h3>
            <p className="text-xs text-daintree-text/60 mt-1 leading-relaxed">
              Pin them to your toolbar for one-click launching.
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {readyAgentIds.map((id) => {
                const config = getAgentConfig(id);
                if (!config) return null;
                const Icon = config.icon;
                return (
                  <li
                    key={id}
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] border border-daintree-border/60 bg-daintree-bg/40 px-2 py-1 text-xs text-daintree-text/80"
                  >
                    <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
                      <Icon brandColor={getBrandColorHex(id)} />
                    </span>
                    {config.name}
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void handlePinAll()}
                disabled={busy}
                data-testid="welcome-card-pin-all"
              >
                <Pin className="h-3.5 w-3.5" />
                Pin all to toolbar
              </Button>
              <button
                type="button"
                onClick={handleDismiss}
                className="text-xs text-daintree-text/50 hover:text-daintree-text/80 transition-colors"
              >
                Not now
              </button>
            </div>
            {pinError && (
              <p
                role="alert"
                data-testid="welcome-card-pin-error"
                className="mt-2 text-xs text-red-400"
              >
                Couldn&apos;t pin all agents. Please try again.
              </p>
            )}
          </div>
        </div>
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
        <h3 className="text-xs font-medium text-daintree-text/50 uppercase tracking-wider">
          Getting Started
        </h3>
        <span className="text-[10px] text-daintree-text/40 font-mono">
          {progressDone}/{progressTotal}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 bg-daintree-border/50 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-daintree-accent rounded-full transition-[width] duration-500"
          style={{ width: `${(progressDone / progressTotal) * 100}%` }}
        />
      </div>

      <div className="space-y-1">
        {/* Endowed progress: Install Daintree (always complete) */}
        <div className="flex items-start gap-2.5 px-2 py-1.5 opacity-60">
          <div className="h-4 w-4 rounded-full bg-daintree-accent border border-daintree-accent flex items-center justify-center shrink-0">
            <Check className="h-2.5 w-2.5 text-daintree-bg" />
          </div>
          <Download className="h-3.5 w-3.5 text-daintree-text/40 shrink-0" />
          <span className="text-xs leading-snug text-daintree-text/40">Install Daintree</span>
        </div>

        {/* Real checklist items */}
        {CHECKLIST_ITEMS.map(({ id, label, description, icon: Icon, actionId }) => {
          const done = checklist.items[id];

          const content = (
            <>
              <div
                className={cn(
                  "h-4 w-4 rounded-full border flex items-center justify-center shrink-0 transition-colors duration-150",
                  done ? "bg-daintree-accent border-daintree-accent" : "border-daintree-text/30"
                )}
              >
                {done && <Check className="h-2.5 w-2.5 text-daintree-bg" />}
              </div>
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  done ? "text-daintree-text/40" : "text-daintree-text/70"
                )}
              />
              <div className="flex flex-col min-w-0 flex-1">
                <span
                  className={cn(
                    "text-xs leading-snug",
                    done ? "text-daintree-text/40" : "text-daintree-text/90"
                  )}
                >
                  {label}
                </span>
                {description && (
                  <span
                    className={cn(
                      "text-[10px] leading-snug",
                      done ? "text-daintree-text/30" : "text-daintree-text/50"
                    )}
                  >
                    {description}
                  </span>
                )}
              </div>
            </>
          );

          const sharedClasses = cn(
            "flex items-start gap-2.5 rounded-[var(--radius-xs)] px-2 py-1.5",
            "transition-colors duration-150",
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
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
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
