import { useMemo, useState } from "react";
import { Callout } from "@/components/ui/Callout";
import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMcpReadiness } from "@/hooks/useMcpReadiness";
import { isRemoteHostSupported } from "@/lib/remoteHosts";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";
import { useRemoteHostName } from "@/hooks/useSettingsOwner";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsChoicebox } from "./SettingsChoicebox";
import { SettingsInput } from "./SettingsInput";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { DEFAULT_DANGEROUS_ARGS } from "@shared/types/agentSettings";
import { resolveAssistantModelId } from "@shared/config/agentRegistry";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import {
  resolveLaunchableAssistantAgentId,
  selectInstalledAssistantAgentIds,
} from "@/hooks/assistantAgentSelection";
import { DAINTREE_CONFIRMATION_OPTIONS } from "@/config/assistantDaintreeConfirmations";
import {
  assistantSkipsDaintreeConfirmations,
  isHelpAssistantDaintreeConfirmations,
  resolveAssistantAgentSkip,
} from "@shared/utils/assistantDaintreeConfirmations";
import type { HelpAssistantIdleHibernateMinutes, HelpAssistantTier } from "@shared/types";
import {
  HELP_TIER_CUMULATIVE,
  HELP_TIER_INCREMENTAL,
  HIGH_BLAST_RADIUS_TOOLS,
} from "@shared/config/helpAssistantTierAllowlists";
import { StatusLine } from "./Assistant/AssistantStatus";
import { AssistantExternalClientsSection } from "./Assistant/AssistantExternalClientsSection";
import { AssistantPrivacySection } from "./Assistant/AssistantPrivacySection";
import { SessionLiveStatusCard } from "./Assistant/SessionLiveStatusCard";
import {
  DEFAULT_SETTINGS,
  SETTING_LABEL,
  patchedKeys,
  type SaveGroup,
} from "./Assistant/assistantSettingsModel";
import { TIER_SHORT_LABEL } from "./Assistant/assistantTiers";
import {
  MODEL_DEFAULT_SENTINEL,
  useAssistantModelCatalog,
} from "./Assistant/useAssistantModelCatalog";
import { useAssistantSettingsPersistence } from "./Assistant/useAssistantSettingsPersistence";
import { useAssistantVersionWarning } from "./Assistant/useAssistantVersionWarning";

// One sentence of consequence beside the select; the rest lives in the tool set's
// disclosure with the action inventory, where it can be read in full.
const TIER_SUMMARIES: Record<HelpAssistantTier, string> = {
  core: "Create worktrees, launch and prompt agents, and move, rename or close terminals",
  full: "Adds recipes, workflows, project checks, forge and git reads, context tools and diagnostics",
};

// Descriptive exclusive choice: each tool set's consequence stays readable in full, so
// the larger one can't hide what it adds behind a truncated label.
const TIER_CHOICES: { value: HelpAssistantTier; label: string; description: string }[] = [
  { value: "core", label: "Core (default)", description: TIER_SUMMARIES.core },
  { value: "full", label: "Full", description: TIER_SUMMARIES.full },
];

const TIER_DETAILS: Record<HelpAssistantTier, string> = {
  core: "The assistant can create worktrees, launch agents and send them prompts, read and wait on terminals, and move, rename or close them. It can delete worktrees, including ones an earlier session created, which asks you to confirm unless Daintree confirmations says otherwise. It can message and start assistants on your other hosts, as each host's settings allow. This covers most orchestration and keeps the tool list the model rereads every turn short.",
  full: "Adds recipes and project checks, starting work on an issue, forge PR, issue and CI reads, git activity, CopyTree context, managing worktree resources, and diagnostics. Teardowns ask you to confirm unless Daintree confirmations says otherwise. Git and forge writes and file edits aren't available in either tool set.",
};

function groupToolsByNamespace(tools: readonly string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const dot = tool.indexOf(".");
    const ns = dot >= 0 ? tool.slice(0, dot) : tool;
    const list = groups.get(ns);
    if (list) {
      list.push(tool);
    } else {
      groups.set(ns, [tool]);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const HIBERNATE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "5", label: "5 minutes (default)" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
];

interface BypassCopy {
  title: string;
  subtitle: string;
  /** Only when the spoken name must add to the visible title; it has to contain it. */
  ariaLabel?: string;
  warning: string;
}

// Names the tier rather than pointing at "the selector above" (#11907): with
// the gate off, the tier carries most of the remaining boundary, so the
// warning has to say which one. It isn't the *entire* boundary though, and
// claiming so was the #12119 overclaim: a `danger: "confirm"` action still
// opens the host confirmation dialog no matter the tier or the bypass flag
// (`tierAuth.ts` — `requiresConfirmation: danger === "confirm" &&
// !nativeGranted`), and only a native automation grant pre-authorizes it. So
// the second sentence names that exception instead of dropping the warning.
// Scoped to new sessions because both the tier and the bypass preference are
// provision-time snapshots — a session already running keeps the tier it was
// minted with, which the live-status card reports.
// While Daintree confirmations skips them (#12874, #12989) those
// confirmations are skipped too, so the second sentence says that instead.
const tierBoundsNewSessions = (tier: HelpAssistantTier, confirmationsSkipped: boolean): string =>
  `New sessions are limited to the Daintree actions in the ${TIER_SHORT_LABEL[tier]} tool set. ${
    confirmationsSkipped
      ? "Daintree's own confirmations, closing panels included, are skipped as well, as set by Daintree confirmations below."
      : "Actions that need confirmation still open Daintree's own prompt unless an automation grant covers them."
  }`;

/**
 * Per-agent wording for the one stored `bypassPermissions` preference. The
 * generic template below is accurate for a plain confirmation gate, but
 * understates any agent whose flag gives up more than that — Codex drops its
 * sandbox alongside its approvals — and understating the blast radius is the
 * same failure as labelling every agent with Claude's flag.
 */
// `warning` carries the agent-specific half only; `getBypassCopy` appends the
// tier-naming safeguard sentences so every branch names the same effective tier.
const BYPASS_COPY: Record<string, Omit<BypassCopy, "subtitle"> & { effect: string }> = {
  claude: {
    title: "Bypass Claude permission prompts",
    effect: "Skip Claude's per-tool confirmation gate",
    ariaLabel: "Bypass Claude permission prompts during help sessions",
    warning:
      "With this on, Claude's permission gate is bypassed for all tools — built-in (Bash, Write) and MCP.",
  },
  codex: {
    title: "Bypass Codex approvals and sandbox",
    effect: "Skip Codex's approval prompts and run tools unsandboxed",
    ariaLabel: "Bypass Codex approvals and sandbox during help sessions",
    warning:
      "With this on, Codex runs every tool without its own approval prompts and outside its sandbox, so it reaches anywhere the process can.",
  },
};

/**
 * What "bypass permissions" means for the selected agent, or `null` when the
 * agent has no bypass mechanism and the control should stay hidden.
 *
 * The flag always comes from `DEFAULT_DANGEROUS_ARGS` — the same map the launch
 * path appends from (`electron/ipc/handlers/terminal/lifecycle.ts`) — so the
 * subtitle can't drift from what actually reaches the command line.
 */
function getBypassCopy(
  agentId: string | null,
  tier: HelpAssistantTier,
  confirmationsSkipped: boolean
): BypassCopy | null {
  if (!agentId) return null;

  const safeguard = tierBoundsNewSessions(tier, confirmationsSkipped);

  const flag = DEFAULT_DANGEROUS_ARGS[agentId];
  const config = getAgentConfig(agentId);
  if (!flag || config?.supports === false || config?.supports?.permissionBypass !== true) {
    return null;
  }

  const agentName = config?.name ?? agentId;
  const known = BYPASS_COPY[agentId];
  if (known) {
    const { effect, warning, ...rest } = known;
    return { ...rest, subtitle: `${effect} (passes ${flag})`, warning: `${warning} ${safeguard}` };
  }
  return {
    title: `Bypass ${agentName} permission prompts`,
    subtitle: `Skip ${agentName}'s confirmation gate (passes ${flag})`,
    ariaLabel: `Bypass ${agentName} permission prompts during help sessions`,
    warning: `With this on, ${agentName} skips its own confirmation gate for every tool. ${safeguard}`,
  };
}

export function DaintreeAssistantSettingsTab() {
  const {
    settings,
    loading,
    loadError,
    retryLoadSettings,
    saveFailure,
    persist,
    displayedCustomArgs,
    setPendingCustomArgs,
    mcpStatus,
    retryMcpStatus,
    updateApiKey,
  } = useAssistantSettingsPersistence();
  // One readiness subscription for the page: Behavior's status row and the
  // external-clients section both read it.
  const runtimeSnapshot = useMcpReadiness();
  // Only a machine that can be a host is reached by other machines' assistants.
  const remoteControlOffered = isRemoteHostSupported();
  const [showBlastRadius, setShowBlastRadius] = useState(false);

  const preferredAgentId = useHelpPanelStore((s) => s.preferredAgentId);
  const setPreferredAgent = useHelpPanelStore((s) => s.setPreferredAgent);
  const droppedPreferredAgentId = useHelpPanelStore((s) => s.droppedPreferredAgentId);
  const clearDroppedPreferredAgent = useHelpPanelStore((s) => s.clearDroppedPreferredAgent);

  const cliAvailability = useCliAvailabilityStore((s) => s.availability);
  const cliAvailabilityKnown = useCliAvailabilityStore((s) => s.hasRealData);
  // The registry is read again whenever availability changes, as the dock's
  // choices hook does: Reload configuration can add or drop a user-defined
  // backend, and both sides must keep agreeing on which agent is the only one.
  const installedAgentIds = useMemo(
    () =>
      selectInstalledAssistantAgentIds(
        getAssistantSupportedAgentIds(),
        cliAvailability,
        cliAvailabilityKnown
      ),
    [cliAvailability, cliAvailabilityKnown]
  );
  // The agent a new session starts on: the saved choice, or the only installed
  // agent the dock launches without asking. Everything that belongs to "the
  // assistant's agent" (model, bypass, skip, version) follows it, because the
  // launch reads those for the agent it starts, not for the saved choice.
  const effectiveAgentId = resolveLaunchableAssistantAgentId(preferredAgentId, installedAgentIds);

  const versionWarning = useAssistantVersionWarning(effectiveAgentId);

  const agentOptions = useMemo(() => {
    return getAssistantSupportedAgentIds().map((id) => ({
      value: id,
      label: getAgentConfig(id)?.name ?? id,
    }));
  }, []);
  // The select tracks the persisted choice exactly. Showing the only installed
  // agent as selected would read as saved, and picking a value the select
  // already shows never fires onChange, so the user couldn't save it. The
  // description names the agent in use instead.
  const agentSelectValue = preferredAgentId ?? "";
  const agentDescription = preferredAgentId
    ? "The CLI that runs the help assistant in the dock"
    : effectiveAgentId
      ? `Using ${getAgentConfig(effectiveAgentId)?.name ?? effectiveAgentId}, the only installed agent the assistant supports`
      : "The help assistant can't start until you choose one";

  const globalSkipPermissions = useAgentSettingsStore(
    (state) => state.settings?.globalSkipPermissions === true
  );
  const agentEntries = useAgentSettingsStore((state) => state.settings?.agents);
  const assistantAgentSkip = resolveAssistantAgentSkip(effectiveAgentId, {
    agents: agentEntries ?? {},
    globalSkipPermissions,
  });
  const confirmationsSkipped = assistantSkipsDaintreeConfirmations(
    settings.daintreeConfirmations,
    assistantAgentSkip.skips
  );
  const bypassCopy = useMemo(
    () => getBypassCopy(effectiveAgentId, settings.tier, confirmationsSkipped),
    [effectiveAgentId, settings.tier, confirmationsSkipped]
  );

  const {
    modelCatalogFailed,
    retryModelCatalog,
    savedModelId,
    catalogIds,
    modelOptions,
    modelSelectValue,
    showModelPicker,
  } = useAssistantModelCatalog(effectiveAgentId, settings.modelIds);

  const saveError = (group: SaveGroup) =>
    saveFailure?.group === group ? (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message={`${SETTING_LABEL[patchedKeys(saveFailure.patch)[0] ?? "modelIds"]} is back to its previous value.`}
        onRetry={() => void persist(saveFailure.patch)}
      />
    ) : null;

  const toggleDocSearch = () => {
    void persist({ docSearch: !settings.docSearch });
  };

  const toggleDaintreeControl = () => {
    void persist({ daintreeControl: !settings.daintreeControl });
  };

  const toggleRunbookSearch = () => {
    void persist({ runbookSearch: !settings.runbookSearch });
  };

  const setTier = (value: string) => {
    if (value !== "core" && value !== "full") return;
    void persist({ tier: value });
  };

  const toggleBypassPermissions = () => {
    void persist({ bypassPermissions: !settings.bypassPermissions });
  };

  const setDaintreeConfirmations = (value: string) => {
    if (!isHelpAssistantDaintreeConfirmations(value)) return;
    void persist({ daintreeConfirmations: value });
  };

  const toggleAcceptRemoteControl = () => {
    void persist({ acceptRemoteControl: !settings.acceptRemoteControl });
  };

  const toggleLoadGlobalHooksAndServers = () => {
    void persist({ loadGlobalHooksAndServers: !settings.loadGlobalHooksAndServers });
  };

  const setHibernateMinutes = (value: string) => {
    const parsed = Number(value);
    if (
      parsed !== 0 &&
      parsed !== 5 &&
      parsed !== 15 &&
      parsed !== 30 &&
      parsed !== 60 &&
      parsed !== 120
    ) {
      return;
    }
    void persist({ idleHibernateMinutes: parsed as HelpAssistantIdleHibernateMinutes });
  };

  // Each agent keeps its own model entry, so switching only changes which one
  // is read — switching back finds the earlier choice intact.
  const handleAgentChange = (value: string) => {
    setPreferredAgent(value || null);
  };

  const handleModelChange = (value: string) => {
    if (!effectiveAgentId) return;
    const modelId = value === MODEL_DEFAULT_SENTINEL ? "" : value;
    // Picking the recommended model stores "no choice", so it keeps tracking
    // the recommendation and doesn't read as modified.
    const recommended = resolveAssistantModelId(effectiveAgentId, null, catalogIds);
    void persist({
      modelIds: {
        [effectiveAgentId]: modelId !== "" && modelId === recommended ? null : modelId,
      },
    });
  };

  const handleCustomArgsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPendingCustomArgs(event.target.value);
  };

  const handleGoToMcpSettings = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "mcp" }, { source: "user" });
  };

  const handleGoToAgentSettings = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
  };

  const handleGoToSkipPermissions = () => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "agents", subtab: "general", sectionId: "agents-skip-permissions" },
      { source: "user" }
    );
  };

  const handleGoToAssistantAgentSettings = () => {
    if (!effectiveAgentId) return;
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "agents", subtab: effectiveAgentId },
      { source: "user" }
    );
  };

  // Names the assistant's agent and where its skip value came from (#14141),
  // so the row says why Daintree will or won't ask under the default.
  const renderConfirmationsDefault = (): ReactNode => {
    const skipState = assistantAgentSkip.skips ? "on" : "off";
    const globalLink = (
      <Button variant="link" onClick={handleGoToSkipPermissions}>
        Settings &gt; Agents &gt; Skip permission prompts
      </Button>
    );
    if (!effectiveAgentId) {
      return (
        <>
          By default it follows the assistant agent&apos;s skip permission prompts setting. With no
          agent chosen, that&apos;s {globalLink}, which is {skipState}.
        </>
      );
    }
    const agentName = getAgentConfig(effectiveAgentId)?.name ?? effectiveAgentId;
    if (assistantAgentSkip.source === "agent") {
      return (
        <>
          By default it follows{" "}
          <Button variant="link" onClick={handleGoToAssistantAgentSettings}>
            {agentName}&apos;s skip permission prompts setting
          </Button>
          , which is {skipState}, set on {agentName}.
        </>
      );
    }
    if (assistantAgentSkip.source === "unsupported") {
      return (
        <>
          By default it follows {agentName}&apos;s skip permission prompts setting, which is off
          because {agentName} can&apos;t skip permission prompts.
        </>
      );
    }
    return (
      <>
        By default it follows {agentName}&apos;s skip permission prompts setting, which is{" "}
        {skipState}, inherited from {globalLink}.
      </>
    );
  };

  const remoteHostName = useRemoteHostName();
  const handleOpenCommandsFolder = () => {
    void actionService.dispatch("help.openCommandsFolder", undefined, { source: "user" });
  };

  // Until the saved values arrive, the controls show defaults. They stay inert so a
  // click can't overwrite a real setting with a value the user never saw.
  const settingsUnavailable = loading || Boolean(loadError);
  const unavailableReason = loadError
    ? "Your saved settings couldn't be read. Retry above."
    : undefined;

  const mcpState = runtimeSnapshot.state;
  const mcpStatusRow = (
    <SettingsRow
      label="MCP server"
      description={
        mcpState === "ready" ? (
          <StatusLine live tone="ok">
            {runtimeSnapshot.port ? `Running on port ${runtimeSnapshot.port}` : "Running"}
          </StatusLine>
        ) : mcpState === "starting" ? (
          <StatusLine live tone="idle">
            Server is starting…
          </StatusLine>
        ) : mcpState === "failed" ? (
          <StatusLine live tone="error">
            MCP server failed to start.{" "}
            {runtimeSnapshot.lastError ?? "Check the MCP server tab for details."}
          </StatusLine>
        ) : (
          <StatusLine live tone="idle">
            {settings.daintreeControl
              ? "MCP server is off, so the assistant can't reach Daintree actions"
              : "MCP server is off. Turning on Daintree control starts it."}
          </StatusLine>
        )
      }
      control={
        mcpState === "failed" || mcpState === "disabled" ? (
          <Button variant="outline" size="sm" onClick={handleGoToMcpSettings}>
            Open MCP server settings
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className="space-y-8" id="settings-panel-assistant-content">
      {loadError && (
        <SettingsLoadErrorBanner
          title="Couldn't load assistant settings"
          message={loadError}
          onRetry={retryLoadSettings}
        />
      )}

      {/* A pick isn't future-only: HelpPanel answers the switch request against the
          project's selected lane, even while Global is on screen, and
          GlobalAssistantService ends a global run on another agent. */}
      <SettingsSection
        title="Agent"
        description="Picking an agent switches this project's selected assistant tab to it, asking first if a conversation there has started. A global assistant on another agent stops."
      >
        {saveError("agent")}
        <SettingsGroup>
          <SettingsSelect
            label="Agent"
            description={agentDescription}
            value={agentSelectValue}
            onValueChange={handleAgentChange}
            options={agentOptions}
            placeholder="Choose an agent"
            disabled={settingsUnavailable || agentOptions.length === 0}
            disabledReason={unavailableReason}
          />
          {showModelPicker && (
            <SettingsSelect
              label="Model"
              description={
                modelCatalogFailed ? (
                  <>
                    Couldn&apos;t load this agent&apos;s models, so only the saved choice is listed
                    ·{" "}
                    <Button variant="link" onClick={retryModelCatalog}>
                      Retry
                    </Button>
                  </>
                ) : (
                  "Applies the next time this agent starts. A --model flag in Custom CLI args overrides it."
                )
              }
              value={modelSelectValue}
              onValueChange={handleModelChange}
              options={modelOptions}
              controlWidth="wide"
              disabled={settingsUnavailable}
              isModified={savedModelId !== null}
              onReset={() => {
                if (effectiveAgentId) void persist({ modelIds: { [effectiveAgentId]: null } });
              }}
            />
          )}
        </SettingsGroup>
        {droppedPreferredAgentId && (
          <AgentNotice
            testId="assistant-dropped-agent-banner"
            title={`${getAgentConfig(droppedPreferredAgentId)?.name ?? droppedPreferredAgentId} is no longer available`}
            body="The agent was removed or is no longer supported as an assistant backend. Choose another agent above."
            action={
              <Button variant="ghost" size="sm" onClick={clearDroppedPreferredAgent}>
                Dismiss
              </Button>
            }
          />
        )}
        {versionWarning && (
          <AgentNotice
            testId="assistant-version-warning-banner"
            title={`${versionWarning.agentName} needs an update`}
            body={`Version ${versionWarning.required} or later is required, but ${versionWarning.installed} is installed. Update the CLI to avoid a blocked or degraded session.`}
            action={
              <Button variant="outline" size="sm" onClick={handleGoToAgentSettings}>
                Open agent settings
              </Button>
            }
          />
        )}
      </SettingsSection>

      {/* All three are read once, when the session is provisioned. */}
      <SettingsSection
        title="Behavior"
        description="Which tools the assistant gets when it starts. A conversation already running keeps the tools it started with."
      >
        {saveError("behavior")}
        <SettingsGroup>
          <SettingsSwitchCard
            id="assistant-doc-search"
            title="Search documentation"
            subtitle="Let the assistant search Daintree docs and changelog while answering"
            isEnabled={settings.docSearch}
            onChange={toggleDocSearch}
            disabled={settingsUnavailable}
            isModified={settings.docSearch !== DEFAULT_SETTINGS.docSearch}
            onReset={() => void persist({ docSearch: DEFAULT_SETTINGS.docSearch })}
          />
          <SettingsSwitchCard
            id="assistant-daintree-control"
            title="Daintree control"
            subtitle={
              !loading && settings.daintreeControl
                ? "Let the assistant call Daintree actions. This starts a local HTTP server on 127.0.0.1."
                : "Let the assistant call Daintree actions through the local MCP server"
            }
            isEnabled={settings.daintreeControl}
            onChange={toggleDaintreeControl}
            ariaLabel="Allow the assistant to call Daintree control tools"
            disabled={settingsUnavailable}
            isModified={settings.daintreeControl !== DEFAULT_SETTINGS.daintreeControl}
            onReset={() => void persist({ daintreeControl: DEFAULT_SETTINGS.daintreeControl })}
          />
          {!loading && <SettingsDependents>{mcpStatusRow}</SettingsDependents>}
          <SettingsSwitchCard
            id="assistant-runbook-search"
            title="Follow runbooks"
            subtitle={
              !loading && !settings.daintreeControl
                ? "Needs Daintree control. Runbooks are procedures for Daintree actions."
                : "Before each task, the assistant loads Daintree's step-by-step procedure for it"
            }
            isEnabled={settings.runbookSearch}
            onChange={toggleRunbookSearch}
            disabled={settingsUnavailable || !settings.daintreeControl}
            isModified={settings.runbookSearch !== DEFAULT_SETTINGS.runbookSearch}
            onReset={() => void persist({ runbookSearch: DEFAULT_SETTINGS.runbookSearch })}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Security"
        description={
          remoteControlOffered
            ? "How much of Daintree the assistant can reach, which confirmations it skips, and whether other machines' assistants can work here"
            : "How much of Daintree the assistant can reach, and which confirmations it skips"
        }
      >
        {saveError("security")}
        <SettingsGroup>
          <SettingsChoicebox
            label="Tool set"
            description="The Daintree actions new sessions can call"
            value={settings.tier}
            onChange={setTier}
            options={TIER_CHOICES}
            disabled={settingsUnavailable}
            isModified={settings.tier !== DEFAULT_SETTINGS.tier}
            onReset={() => setTier(DEFAULT_SETTINGS.tier)}
          />

          {/* The stored preference is agent-agnostic but its effect is not, so the
              row only renders once an agent with a real bypass mechanism is
              selected. */}
          {bypassCopy && (
            <SettingsSwitchCard
              id="assistant-skip-permissions"
              title={bypassCopy.title}
              subtitle={bypassCopy.subtitle}
              isEnabled={settings.bypassPermissions}
              onChange={toggleBypassPermissions}
              ariaLabel={bypassCopy.ariaLabel}
              colorScheme="amber"
              disabled={settingsUnavailable}
              isModified={settings.bypassPermissions !== DEFAULT_SETTINGS.bypassPermissions}
              onReset={() =>
                void persist({ bypassPermissions: DEFAULT_SETTINGS.bypassPermissions })
              }
            />
          )}
          {bypassCopy && settings.bypassPermissions && (
            <div className="flex items-start gap-2 py-2.5 pl-4 pr-4">
              <AlertTriangle
                className="w-4 h-4 text-status-warning shrink-0 mt-px"
                aria-hidden="true"
              />
              <div className="text-xs text-text-secondary select-text">{bypassCopy.warning}</div>
            </div>
          )}

          {/* The live value lives in the row's description, where the select's narrow
              rail cannot clip it. */}
          <SettingsSelect
            id="assistant-daintree-confirmations"
            label="Daintree confirmations"
            description={
              <>
                Whether Daintree asks before the assistant deletes a worktree, closes a panel it
                didn't open, or runs another action that needs confirmation.{" "}
                {renderConfirmationsDefault()}
              </>
            }
            value={settings.daintreeConfirmations}
            onValueChange={setDaintreeConfirmations}
            options={DAINTREE_CONFIRMATION_OPTIONS}
            disabled={settingsUnavailable}
            isModified={settings.daintreeConfirmations !== DEFAULT_SETTINGS.daintreeConfirmations}
            onReset={() => setDaintreeConfirmations(DEFAULT_SETTINGS.daintreeConfirmations)}
          />

          {/* The inventory comes last so opening it never pushes the bypass switch away
              from the tier it works with. */}
          <BlastRadiusPreview
            tier={settings.tier}
            isOpen={showBlastRadius}
            onToggle={() => setShowBlastRadius((v) => !v)}
          />
        </SettingsGroup>

        {remoteControlOffered && (
          <SettingsGroup label="Other machines">
            <SettingsSwitchCard
              id="assistant-accept-remote-control"
              title="Let other machines' assistants work here"
              subtitle="An assistant on a machine connected to this one as its host can run Daintree's tools here, within this machine's own tool sets. That includes finding, starting and messaging the assistants running here."
              isEnabled={settings.acceptRemoteControl}
              onChange={toggleAcceptRemoteControl}
              disabled={settingsUnavailable}
              isModified={settings.acceptRemoteControl !== DEFAULT_SETTINGS.acceptRemoteControl}
              onReset={() =>
                void persist({ acceptRemoteControl: DEFAULT_SETTINGS.acceptRemoteControl })
              }
            />
          </SettingsGroup>
        )}

        <SessionLiveStatusCard configuredTier={settings.tier} />
      </SettingsSection>

      <AssistantPrivacySection
        auditRetention={settings.auditRetention}
        persist={persist}
        saveError={saveError("privacy")}
        settingsUnavailable={settingsUnavailable}
        loading={loading}
      />

      <SettingsSection
        title="Launch options"
        description="Changes apply to new assistant sessions."
      >
        {saveError("launch")}
        <SettingsGroup>
          <SettingsInput
            label="Custom CLI args"
            description="Whitespace-separated flags appended to the launch command"
            type="text"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="e.g. --verbose"
            className="font-mono"
            value={displayedCustomArgs}
            onChange={handleCustomArgsChange}
            disabled={settingsUnavailable}
            isModified={displayedCustomArgs !== DEFAULT_SETTINGS.customArgs}
            onReset={() => {
              setPendingCustomArgs(null);
              void persist({ customArgs: DEFAULT_SETTINGS.customArgs });
            }}
          />
          <SettingsSelect
            label="Hibernate after"
            description="How long the panel stays hidden before the assistant shuts down. Reopening resumes the same conversation."
            value={String(settings.idleHibernateMinutes)}
            onValueChange={setHibernateMinutes}
            options={HIBERNATE_OPTIONS}
            disabled={settingsUnavailable}
            isModified={settings.idleHibernateMinutes !== DEFAULT_SETTINGS.idleHibernateMinutes}
            onReset={() => setHibernateMinutes(String(DEFAULT_SETTINGS.idleHibernateMinutes))}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Custom commands and skills">
        {saveError("content")}
        <SettingsGroup>
          <SettingsRow
            label="Assistant folder"
            description={
              <>
                Commands, skills, instructions and reference files in{" "}
                <code className="font-mono">~/.daintree/assistant</code> join every new session. A
                project&apos;s own <code className="font-mono">.daintree/assistant</code> takes
                precedence.
              </>
            }
            control={
              <Button variant="outline" size="sm" onClick={handleOpenCommandsFolder}>
                <FolderOpen />
                {remoteHostName ? `Open folder on ${remoteHostName}` : "Open folder"}
              </Button>
            }
          />
          <SettingsSwitchCard
            title="Load my MCP servers and hooks"
            subtitle="Starts the servers in mcp.json and runs the Claude hooks in hooks.json from ~/.daintree/assistant. A project's folder can never add these."
            isEnabled={settings.loadGlobalHooksAndServers}
            onChange={toggleLoadGlobalHooksAndServers}
            ariaLabel="Load my MCP servers and hooks"
            disabled={settingsUnavailable}
            isModified={
              settings.loadGlobalHooksAndServers !== DEFAULT_SETTINGS.loadGlobalHooksAndServers
            }
            onReset={() =>
              void persist({
                loadGlobalHooksAndServers: DEFAULT_SETTINGS.loadGlobalHooksAndServers,
              })
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <AssistantExternalClientsSection
        runtimeSnapshot={runtimeSnapshot}
        mcpStatus={mcpStatus}
        loading={loading}
        retryMcpStatus={retryMcpStatus}
        updateApiKey={updateApiKey}
      />
    </div>
  );
}
/** A notice about the chosen agent, directly under the group that chooses it. */
function AgentNotice({
  testId,
  title,
  body,
  action,
}: {
  testId: string;
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <Callout
      severity="warning"
      role="alert"
      data-testid={testId}
      title={title}
      action={action}
      className="select-text"
    >
      <p>{body}</p>
    </Callout>
  );
}

interface BlastRadiusPreviewProps {
  tier: HelpAssistantTier;
  isOpen: boolean;
  onToggle: () => void;
}

const HIGH_BLAST_RADIUS_GROUP = "high blast radius";

function BlastRadiusPreview({ tier, isOpen, onToggle }: BlastRadiusPreviewProps) {
  const totalCount = HELP_TIER_CUMULATIVE[tier].length;
  const newAtTier = HELP_TIER_INCREMENTAL[tier].length;
  const groups = useMemo(() => {
    const cumulative = HELP_TIER_CUMULATIVE[tier];
    // Pin the load-bearing dangerous actions at the top of whichever tool set
    // is being previewed, so they can't be missed in a long alphabetical list.
    // Intersected with this set rather than pinned only on the largest (#12116):
    // the preview's job is to show what selecting THIS set grants, so a tool
    // has to be called out at the set that first reaches it.
    const pinnedList = HIGH_BLAST_RADIUS_TOOLS.filter((tool) => cumulative.includes(tool));
    if (pinnedList.length === 0) return groupToolsByNamespace(cumulative);
    const pinned = new Set(pinnedList);
    const rest = cumulative.filter((tool) => !pinned.has(tool));
    return [
      [HIGH_BLAST_RADIUS_GROUP, pinnedList] as [string, string[]],
      ...groupToolsByNamespace(rest),
    ];
  }, [tier]);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cn(
          "w-full flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-xs",
          "text-text-secondary hover:bg-overlay-subtle hover:text-text-primary transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        )}
      >
        <span className="flex items-center gap-2">
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3.5 h-3.5 transition-transform duration-150 ease-out",
              isOpen ? "rotate-90" : "rotate-0"
            )}
            aria-hidden="true"
          />
          <span>
            What this tool set allows · {totalCount} actions
            {tier !== "core" && <span> ({newAtTier} more than core)</span>}
          </span>
        </span>
      </button>
      {isOpen && (
        <div className="px-4 pb-3 pt-1 space-y-2">
          <p className="text-xs text-text-secondary select-text">{TIER_DETAILS[tier]}</p>
          {groups.map(([ns, tools]) => (
            <div key={ns} className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-secondary font-mono">
                {ns === HIGH_BLAST_RADIUS_GROUP && (
                  <AlertTriangle className="w-3 h-3 text-status-warning" aria-hidden="true" />
                )}
                {ns}
                <span className="ml-1 text-text-placeholder">({tools.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tools.map((tool) => (
                  <span
                    key={tool}
                    className={cn(
                      "px-1.5 py-0.5 rounded-[var(--radius-sm)] text-3xs font-mono",
                      "bg-surface-canvas border border-border-default text-text-secondary"
                    )}
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
