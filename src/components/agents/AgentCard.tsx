import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AGENT_DESCRIPTIONS, getAgentConfig, type AgentIconProps } from "@/config/agents";
import { isAgentInstalled, isAgentBlocked } from "@shared/utils/agentAvailability";
import type { AgentAvailabilityState, AgentCliDetail } from "@shared/types";
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
  const agentConfig = getAgentConfig(agentId);
  const presetCount = agentConfig?.presets?.length ?? 0;

  return (
    <label
      className={cn(
        "flex items-center gap-3 px-3 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 cursor-pointer hover:bg-daintree-bg/60 transition-colors",
        compact ? "py-2" : "py-2.5"
      )}
    >
      <input
        type="checkbox"
        className="w-4 h-4 accent-daintree-accent shrink-0"
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
      <div className="flex items-center gap-2 shrink-0">
        {presetCount > 1 && (
          <span className="text-[10px] text-daintree-accent font-medium bg-daintree-accent/10 px-1.5 py-0.5 rounded">
            {presetCount} presets
          </span>
        )}
        {installed ? (
          <span className="text-[11px] text-status-success font-medium">Installed</span>
        ) : (
          <span className="text-[11px] text-daintree-text/30">Not installed</span>
        )}
      </div>
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
    <div className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-daintree-border">
        <div className="flex items-center gap-3">
          <Icon size={24} brandColor={color} />
          <div>
            <h4 className="text-sm font-medium text-daintree-text">{name} Settings</h4>
            <p className="text-xs text-daintree-text/50 select-text">
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
        <div className="text-sm font-medium text-daintree-text">{name}</div>
        {description && (
          <div className="text-[11px] text-daintree-text/40 truncate">{description}</div>
        )}
      </div>
    </>
  );
}

export function AgentInstallSection({
  agentId,
  agentName,
  availability,
  detail,
  isCliLoading,
  isRefreshingCli,
  cliError,
  onRefresh,
}: {
  agentId: string;
  agentName: string;
  availability: AgentAvailabilityState | undefined;
  /** Optional diagnostic detail from `cliAvailabilityClient.getDetails()`. */
  detail?: AgentCliDetail;
  isCliLoading: boolean;
  isRefreshingCli: boolean;
  cliError: string | null;
  onRefresh: () => void;
}) {
  const agentConfig = getAgentConfig(agentId);
  const installBlocks = agentConfig ? getInstallBlocksForCurrentOS(agentConfig) : null;
  const hasInstallConfig = agentConfig?.install;

  // `authConfirmed === false` means the binary is on PATH and launchable,
  // but the passive auth probe didn't find a credential. We still show the
  // section (as "Authentication") so users see the sign-in cue and install
  // docs. `undefined` means no auth probe applies — hide the section when
  // availability is `ready`.
  const authMissing = availability === "ready" && detail?.authConfirmed === false;

  // "ready" + confirmed-or-no-probe hides the whole install section.
  // "blocked" keeps it visible so the user gets actionable info (allowlist
  // guidance, resolved path) — the binary exists, reinstall instructions
  // would be misleading, but we do want to show why it isn't runnable and
  // where it was found. "installed" covers the WSL cap.
  if (availability === "ready" && !authMissing) return null;

  if (isCliLoading) {
    return (
      <div className="pt-4 border-t border-daintree-border">
        <div className="text-xs text-daintree-text/40">Checking CLI availability...</div>
      </div>
    );
  }

  const blocked = isAgentBlocked(availability);
  // WSL-capped `installed` is a distinct case from `ready + authConfirmed:
  // false` — the binary exists in WSL but direct launch from the PTY host
  // isn't wired yet, so sign-in copy would mislead. Keep them separate.
  const showWslNotice = availability === "installed";
  const showAuthNudge = authMissing;

  const headerLabel = blocked
    ? "Blocked"
    : showWslNotice
      ? "Not launchable"
      : showAuthNudge
        ? "Authentication"
        : "Installation";

  const headerDescription = blocked
    ? `${agentName} CLI was found but couldn't run — check your security software or file permissions`
    : showWslNotice
      ? `${agentName} CLI was detected in WSL, but Daintree can't launch WSL binaries directly yet — install a native Windows binary if available`
      : showAuthNudge
        ? `${agentName} CLI found but not signed in — launching will prompt for login`
        : `${agentName} CLI not found`;

  return (
    <div
      id="agents-installation"
      className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4"
    >
      <div className="pb-3 border-b border-daintree-border">
        <div className="flex items-center justify-between">
          <div>
            <h5 className="text-sm font-medium text-daintree-text">{headerLabel}</h5>
            <p className="text-xs text-daintree-text/50 select-text">{headerDescription}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={isRefreshingCli}
            className="text-daintree-text/50 hover:text-daintree-text"
          >
            <RefreshCw size={14} className={cn("mr-1.5", isRefreshingCli && "animate-spin")} />
            Re-check
          </Button>
        </div>
      </div>

      {cliError && (
        <div className="px-3 py-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
          <p className="text-xs text-status-error">
            Re-check failed. Try again or restart the app.
          </p>
        </div>
      )}

      {detail && (detail.resolvedPath || detail.message) && (
        <div
          className={cn(
            "px-3 py-2 rounded-[var(--radius-md)] border",
            blocked
              ? "bg-status-warning/10 border-status-warning/20"
              : "bg-daintree-bg/50 border-daintree-border/50"
          )}
        >
          {detail.resolvedPath && (
            <div className="text-xs font-mono break-all text-daintree-text/70 select-text">
              {detail.via === "npx"
                ? "Available via npx cache"
                : detail.via === "wsl"
                  ? `Available via WSL (${detail.wslDistro ?? "distro"})`
                  : `Resolved path: ${detail.resolvedPath}`}
            </div>
          )}
          {detail.message && (
            <div className="text-xs text-status-warning mt-1 select-text">{detail.message}</div>
          )}
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
                <ul className="space-y-0.5 text-xs text-daintree-text/60">
                  {agentConfig.install.troubleshooting.map((tip, tipIndex) => (
                    <li key={tipIndex}>
                      {"• "}
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            )}

          <div className="px-3 py-2 rounded-[var(--radius-md)] bg-daintree-bg/50 border border-daintree-border/50">
            <p className="text-xs text-daintree-text/40 select-text">
              Warning: Review commands before running them in your terminal
            </p>
          </div>
        </div>
      ) : hasInstallConfig?.docsUrl ? (
        <div className="px-4 py-6 rounded-[var(--radius-md)] border border-daintree-border bg-surface text-center">
          <p className="text-xs text-daintree-text/60 mb-3">
            No OS-specific install instructions available
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const url = agentConfig?.install?.docsUrl;
              if (url) void window.electron.system.openExternal(url);
            }}
            className="text-daintree-accent hover:text-daintree-accent/80"
          >
            <ExternalLink size={14} />
            Open Install Docs
          </Button>
        </div>
      ) : (
        <div className="px-4 py-6 rounded-[var(--radius-md)] border border-daintree-border bg-surface text-center">
          <p className="text-xs text-daintree-text/60">
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
          className="w-full text-daintree-text/50 hover:text-daintree-text"
        >
          <ExternalLink size={14} />
          View Official Documentation
        </Button>
      )}
    </div>
  );
}
