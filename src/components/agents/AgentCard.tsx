import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import { AGENT_DESCRIPTIONS, getAgentConfig, type AgentIconProps } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import {
  isAgentInstalled,
  isAgentBlocked,
  isAgentUnauthenticated,
} from "@shared/utils/agentAvailability";
import type { AgentAvailabilityState, AgentCliDetail } from "@shared/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RefreshCw, ExternalLink, TriangleAlert } from "lucide-react";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { getInstallBlocksForCurrentOS } from "@/lib/agentInstall";
import { CopyableCommand } from "@/components/Setup/InstallBlock";
import { extractInspectUrl } from "@/lib/agentInstall";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export interface AgentIdentity {
  name: string;
  color: string;
  Icon: ComponentType<AgentIconProps>;
  description: string;
}

/**
 * The single place the brand mark, display name and blurb for an agent are resolved.
 * Exported so other surfaces that render an agent row — the System status list in
 * Settings, for one — inherit the same description fallback chain rather than each
 * growing its own.
 */
export function resolveIdentity(agentId: string): AgentIdentity | null {
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

export type AgentCardProps = AgentCardOnboardingProps;

export function AgentCard(props: AgentCardProps) {
  const identity = resolveIdentity(props.agentId);
  if (!identity) return null;

  return <OnboardingCard identity={identity} {...props} />;
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
        "flex items-center gap-3 px-3 rounded-[var(--radius-md)] border border-border-default bg-daintree-bg/30 cursor-pointer hover:bg-daintree-bg/60 transition-colors",
        compact ? "py-2" : "py-2.5"
      )}
    >
      {/* The house checkbox: checked paints in the text colour, because a
          selection is membership and the accent is not spent on it. */}
      <Checkbox
        checked={isChecked}
        onCheckedChange={(checked) => onToggle(agentId, checked === true)}
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
          <span className="text-3xs text-status-info font-medium bg-status-info/10 px-1.5 py-0.5 rounded">
            {presetCount} presets
          </span>
        )}
        {installed ? (
          <span className="text-2xs text-text-secondary font-medium">Installed</span>
        ) : (
          <span className="text-2xs text-text-secondary">Not installed</span>
        )}
      </div>
    </label>
  );
}

export function AgentIdentityBlock({
  Icon,
  color,
  name,
  description,
  compact = false,
  showDescription = true,
}: {
  Icon: ComponentType<AgentIconProps>;
  color: string;
  name: string;
  description: string;
  compact?: boolean;
  /**
   * Drop the blurb and render the row on one line. In a long roster the blurbs stop
   * distinguishing anything — "Open-source CLI" is true of three different agents — while
   * still costing a second line on every row, so the mark does the recognition work alone.
   */
  showDescription?: boolean;
}) {
  return (
    <>
      {/* The box only aligns the row; the mark carries its own colour and no
          longer sits on a wash tile of the raw brand hex. */}
      <div
        className={cn("flex items-center justify-center shrink-0", compact ? "w-7 h-7" : "w-8 h-8")}
      >
        <BrandMark brandColor={color}>
          <Icon size={compact ? 16 : 18} />
        </BrandMark>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">{name}</div>
        {showDescription && description && (
          <div className="text-2xs text-text-secondary truncate">{description}</div>
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
  const authMissing = isAgentUnauthenticated(availability);

  // "ready" + confirmed-or-no-probe hides the whole install section.
  // "unauthenticated" keeps it visible for the auth nudge.
  // "blocked" keeps it visible so the user gets actionable info (allowlist
  // guidance, resolved path) — the binary exists, reinstall instructions
  // would be misleading, but we do want to show why it isn't runnable and
  // where it was found. "installed" covers the WSL cap.
  if (availability === "ready" && !authMissing) return null;
  // Not part of CLI detection (the built-in assistant, say): there is nothing to
  // install and no probe result to report, so a "Not installed" heading would be a guess.
  if (availability === undefined && !isCliLoading) return null;

  if (isCliLoading) {
    return (
      <SettingsSection
        id="agents-installation"
        title="Installation"
        description="Checking CLI availability..."
      >
        {null}
      </SettingsSection>
    );
  }

  const blocked = isAgentBlocked(availability);
  // WSL-capped `installed` is a distinct case from `ready + authConfirmed:
  // false` — the binary exists in WSL but direct launch from the PTY host
  // isn't wired yet, so sign-in copy would mislead. Keep them separate.
  const showWslNotice = availability === "installed";
  const showAuthNudge = authMissing;

  // The title states what the probe found, so the section reads as a status line
  // from its heading down — the same words the agent picker and inventory use.
  const headerLabel = blocked
    ? "Blocked"
    : showWslNotice
      ? "Not launchable"
      : showAuthNudge
        ? "No credentials detected"
        : "Not installed";

  const installCommandCount =
    installBlocks?.reduce((n, block) => n + (block.commands?.length ?? 0), 0) ?? 0;

  const headerDescription = blocked
    ? `${agentName} CLI was found but couldn't run — check your security software or file permissions`
    : showWslNotice
      ? `${agentName} CLI was detected in WSL, but WSL binaries can't be launched directly yet — install a native Windows binary if available`
      : showAuthNudge
        ? // Two claims the probe cannot support: that the user is not signed in, and that
          // launching will prompt. `unauthenticated` only means no credentials were found
          // where we looked, and the state is launchable — the CLI resolves auth at run
          // time and may well just work.
          `${agentName} CLI found, but no credentials were detected — it may still launch, or ask you to sign in`
        : installCommandCount > 0
          ? `Install the ${agentName} CLI with ${installCommandCount === 1 ? "the command" : "one of the commands"} below, then re-check`
          : `The ${agentName} CLI isn't on your PATH. Install it, then re-check.`;

  const openDocs = () => {
    const url = agentConfig?.install?.docsUrl;
    if (url) {
      safeFireAndForget(window.electron.system.openExternal(url), {
        context: "Opening agent install docs",
      });
    }
  };

  const openDocsButton = (
    <Button size="sm" variant="outline" onClick={openDocs}>
      <ExternalLink aria-hidden="true" />
      Open install docs
    </Button>
  );

  // A binary that was found needs a different fix than one that wasn't: offering to
  // install it again would send the user to reinstall something already on disk. The
  // commands stay for a missing CLI only; everything else keeps the diagnosis, the
  // troubleshooting and the docs.
  const binaryFound = isAgentInstalled(availability);
  const hasBlocks = !binaryFound && !!installBlocks && installBlocks.length > 0;
  const troubleshooting = agentConfig?.install?.troubleshooting ?? [];
  const location = detail?.resolvedPath
    ? detail.via === "wsl"
      ? `Available via WSL (${detail.wslDistro ?? "distro"})`
      : detail.via === "npm-global"
        ? `npm global: ${detail.resolvedPath}`
        : `Resolved path: ${detail.resolvedPath}`
    : null;

  return (
    <SettingsSection
      id="agents-installation"
      title={headerLabel}
      description={headerDescription}
      action={
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={isRefreshingCli}>
          <SpinningIcon icon={RefreshCw} active={isRefreshingCli} size={14} />
          Re-check
        </Button>
      }
    >
      <SettingsGroup>
        {cliError && (
          <p
            className="flex items-start gap-1.5 px-4 py-3 text-xs text-text-secondary"
            role="alert"
          >
            <TriangleAlert
              className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            <span>Re-check failed. Try again, or restart Daintree if it keeps failing.</span>
          </p>
        )}

        {detail && (location || detail.message) && (
          <SettingsRow
            label="Detected CLI"
            layout="stacked"
            control={
              <div className="grid gap-1">
                {location && (
                  <div className="text-xs font-mono break-all text-text-secondary select-text">
                    {location}
                  </div>
                )}
                {detail.message && (
                  // Severity rides the glyph; the sentence stays body text so it holds
                  // contrast on every theme.
                  <div className="flex items-start gap-1.5 text-xs text-text-secondary select-text">
                    <TriangleAlert
                      className="mt-px h-3.5 w-3.5 shrink-0 text-status-warning"
                      aria-hidden="true"
                    />
                    <span>{detail.message}</span>
                  </div>
                )}
              </div>
            }
          />
        )}

        {hasBlocks && (
          <>
            {installBlocks.map((block, blockIndex) => (
              <SettingsRow
                key={blockIndex}
                label={block.label ?? `Install ${agentName}`}
                layout="stacked"
                description={
                  block.steps && block.steps.length > 0 ? (
                    <ol className="list-decimal list-inside space-y-1">
                      {block.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                  ) : undefined
                }
                control={
                  (block.commands && block.commands.length > 0) ||
                  (block.notes && block.notes.length > 0) ? (
                    <div className="grid gap-1.5">
                      {block.commands?.map((cmd) => (
                        <CopyableCommand
                          key={cmd}
                          command={cmd}
                          inspectUrl={extractInspectUrl(cmd)}
                        />
                      ))}
                      {block.notes && block.notes.length > 0 && (
                        <div className="text-xs text-text-secondary space-y-0.5 select-text">
                          {block.notes.map((note, i) => (
                            <p key={i}>{note}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : undefined
                }
              />
            ))}
          </>
        )}

        {!binaryFound && !hasBlocks && (
          <SettingsEmptyRow action={hasInstallConfig?.docsUrl ? openDocsButton : undefined}>
            {hasInstallConfig?.docsUrl
              ? "No install commands for this operating system — the docs have the steps"
              : "No install instructions for this agent yet"}
          </SettingsEmptyRow>
        )}

        {troubleshooting.length > 0 && (
          <SettingsRow
            label="Troubleshooting"
            layout="stacked"
            control={
              <ul className="list-disc list-inside space-y-0.5 text-xs text-text-secondary select-text">
                {troubleshooting.map((tip, tipIndex) => (
                  <li key={tipIndex}>{tip}</li>
                ))}
              </ul>
            }
          />
        )}

        {hasInstallConfig?.docsUrl && (hasBlocks || binaryFound) && (
          <SettingsRow
            label="Official documentation"
            description={
              hasBlocks
                ? "Review commands before running them in your terminal"
                : `Setup, sign-in and permissions help for ${agentName}`
            }
            control={openDocsButton}
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
