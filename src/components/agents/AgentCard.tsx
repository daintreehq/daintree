import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AGENT_DESCRIPTIONS, getAgentConfig, type AgentIconProps } from "@/config/agents";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import type { AgentAvailabilityState } from "@shared/types";
import { Button } from "@/components/ui/button";
import { RefreshCw, ExternalLink } from "lucide-react";
import { getInstallBlocksForCurrentOS } from "@/lib/agentInstall";
import { InstallBlock } from "@/components/Setup/InstallBlock";

interface AgentIdentity {
  name: string;
  color: string;
  Icon: ComponentType<AgentIconProps>;
  description: string;
}

function resolveIdentity(agentId: string): AgentIdentity | null {
  const config = getAgentConfig(agentId);
  if (!config) return null;
  return {
    name: config.name,
    color: config.color,
    Icon: config.icon,
    description: AGENT_DESCRIPTIONS[agentId] ?? config.tooltip ?? "",
  };
}

// --- Onboarding mode ---

interface AgentCardOnboardingProps {
  mode: "onboarding";
  agentId: string;
  availability: Record<string, AgentAvailabilityState | undefined>;
  isChecked: boolean;
  isSaving: boolean;
  onToggle: (agentId: string, checked: boolean) => void;
  compact?: boolean;
}

// --- Management mode ---

interface AgentCardManagementProps {
  mode: "management";
  agentId: string;
  actions?: ReactNode;
  children: ReactNode;
}

export type AgentCardProps = AgentCardOnboardingProps | AgentCardManagementProps;

export function AgentCard(props: AgentCardProps) {
  const identity = resolveIdentity(props.agentId);
  if (!identity) return null;

  if (props.mode === "onboarding") {
    return <OnboardingCard identity={identity} {...props} />;
  }

  return <ManagementCard identity={identity} {...props} />;
}

function OnboardingCard({
  identity,
  agentId,
  availability,
  isChecked,
  isSaving,
  onToggle,
  compact = false,
}: AgentCardOnboardingProps & { identity: AgentIdentity }) {
  const { name, color, Icon, description } = identity;
  const installed = isAgentInstalled(availability[agentId]);

  return (
    <label
      className={cn(
        "flex items-center gap-3 px-3 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30 cursor-pointer hover:bg-canopy-bg/60 transition-colors",
        compact ? "py-2" : "py-2.5"
      )}
    >
      <input
        type="checkbox"
        className="w-4 h-4 accent-canopy-accent shrink-0"
        checked={isChecked}
        onChange={(e) => onToggle(agentId, e.target.checked)}
        disabled={isSaving}
      />
      <AgentIdentityBlock
        Icon={Icon}
        color={color}
        name={name}
        description={description}
        compact={compact}
      />
      {installed ? (
        <span className="text-[11px] text-status-success font-medium shrink-0">Installed</span>
      ) : (
        <span className="text-[11px] text-canopy-text/30 shrink-0">Not installed</span>
      )}
    </label>
  );
}

function ManagementCard({
  identity,
  actions,
  children,
}: AgentCardManagementProps & { identity: AgentIdentity }) {
  const { name, color, Icon } = identity;

  return (
    <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-canopy-border">
        <div className="flex items-center gap-3">
          <Icon size={24} brandColor={color} />
          <div>
            <h4 className="text-sm font-medium text-canopy-text">{name} Settings</h4>
            <p className="text-xs text-canopy-text/50 select-text">
              Configure how {name.toLowerCase()} runs in terminals
            </p>
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function AgentIdentityBlock({
  Icon,
  color,
  name,
  description,
  compact = false,
}: {
  Icon: ComponentType<AgentIconProps>;
  color: string;
  name: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <>
      <div
        className={cn(
          "rounded-[var(--radius-sm)] flex items-center justify-center shrink-0",
          compact ? "w-7 h-7" : "w-8 h-8"
        )}
        style={{ backgroundColor: `${color}15` }}
      >
        <Icon size={compact ? 16 : 18} brandColor={color} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-canopy-text">{name}</div>
        {description && (
          <div className="text-[11px] text-canopy-text/40 truncate">{description}</div>
        )}
      </div>
    </>
  );
}

export function AgentInstallSection({
  agentId,
  agentName,
  availability,
  isCliLoading,
  isRefreshingCli,
  cliError,
  onRefresh,
}: {
  agentId: string;
  agentName: string;
  availability: AgentAvailabilityState | undefined;
  isCliLoading: boolean;
  isRefreshingCli: boolean;
  cliError: string | null;
  onRefresh: () => void;
}) {
  const agentConfig = getAgentConfig(agentId);
  const installBlocks = agentConfig ? getInstallBlocksForCurrentOS(agentConfig) : null;
  const hasInstallConfig = agentConfig?.install;

  if (availability === "ready") return null;

  if (isCliLoading) {
    return (
      <div className="pt-4 border-t border-canopy-border">
        <div className="text-xs text-canopy-text/40">Checking CLI availability...</div>
      </div>
    );
  }

  return (
    <div id="agents-installation" className="space-y-3 pt-4 border-t border-canopy-border">
      <div className="flex items-center justify-between">
        <div>
          <h5 className="text-sm font-medium text-canopy-text">
            {availability === "installed" ? "Authentication" : "Installation"}
          </h5>
          <p className="text-xs text-canopy-text/50 select-text">
            {availability === "installed"
              ? `${agentName} CLI found but not authenticated`
              : `${agentName} CLI not found`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefresh}
          disabled={isRefreshingCli}
          className="text-canopy-text/50 hover:text-canopy-text"
        >
          <RefreshCw size={14} className={cn("mr-1.5", isRefreshingCli && "animate-spin")} />
          Re-check
        </Button>
      </div>

      {cliError && (
        <div className="px-3 py-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
          <p className="text-xs text-status-error">
            Re-check failed. Try again or restart the app.
          </p>
        </div>
      )}

      {installBlocks && installBlocks.length > 0 ? (
        <div className="space-y-3">
          {installBlocks.map((block, blockIndex) => (
            <InstallBlock key={blockIndex} block={block} />
          ))}

          {agentConfig?.install?.troubleshooting &&
            agentConfig.install.troubleshooting.length > 0 && (
              <div className="px-3 py-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
                <div className="text-xs font-medium text-status-warning mb-1">Troubleshooting</div>
                <ul className="space-y-0.5 text-xs text-canopy-text/60">
                  {agentConfig.install.troubleshooting.map((tip, tipIndex) => (
                    <li key={tipIndex}>
                      {"• "}
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            )}

          <div className="px-3 py-2 rounded-[var(--radius-md)] bg-canopy-bg/50 border border-canopy-border/50">
            <p className="text-xs text-canopy-text/40 select-text">
              Warning: Review commands before running them in your terminal
            </p>
          </div>
        </div>
      ) : hasInstallConfig?.docsUrl ? (
        <div className="px-4 py-6 rounded-[var(--radius-md)] border border-canopy-border bg-surface text-center">
          <p className="text-xs text-canopy-text/60 mb-3">
            No OS-specific install instructions available
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const url = agentConfig?.install?.docsUrl;
              if (url) void window.electron.system.openExternal(url);
            }}
            className="text-canopy-accent hover:text-canopy-accent/80"
          >
            <ExternalLink size={14} />
            Open Install Docs
          </Button>
        </div>
      ) : (
        <div className="px-4 py-6 rounded-[var(--radius-md)] border border-canopy-border bg-surface text-center">
          <p className="text-xs text-canopy-text/60">
            No installation instructions configured for this agent
          </p>
        </div>
      )}

      {hasInstallConfig?.docsUrl && installBlocks && installBlocks.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const url = agentConfig?.install?.docsUrl;
            if (url) void window.electron.system.openExternal(url);
          }}
          className="w-full text-canopy-text/50 hover:text-canopy-text"
        >
          <ExternalLink size={14} />
          View Official Documentation
        </Button>
      )}
    </div>
  );
}
