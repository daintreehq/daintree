import { useEffect, useEffectEvent, useMemo, useRef, useState, useCallback } from "react";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { useTabLoad } from "@/hooks";
import { getAgentIds, getAgentConfig, getMergedPresets, type AgentPreset } from "@/config/agents";
import { useAgentSettingsStore, useCliAvailabilityStore, useAgentPreferencesStore } from "@/store";
import { cliAvailabilityClient } from "@/clients";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { logError } from "@/utils/logger";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
  type AgentCliDetails,
} from "@shared/types";
import { isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import { RotateCcw, ExternalLink } from "lucide-react";
import { BrandMark, Plug } from "@/components/icons";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSelect } from "./SettingsSelect";
import { AddPresetDialog } from "./AddPresetDialog";
import { AgentScopeEditor } from "./AgentScopeEditor";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { actionService } from "@/services/ActionService";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { AgentInstallSection } from "@/components/agents/AgentCard";
import { AgentShortcutCapture } from "@/components/KeyboardShortcuts";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { DefaultAgentId } from "@/store/agentPreferencesStore";

const GENERAL_SUBTAB_ID = "general";
/** Radix Select reserves the empty string, so "no default" needs a sentinel value. */
const NO_DEFAULT_AGENT = "__none__";

function AgentShortcutRow({ agentId, agentName }: { agentId: BuiltInAgentId; agentName: string }) {
  const actionId = `agent.${agentId}`;
  const displayCombo = useKeybindingDisplay(actionId);
  const [isEditing, setIsEditing] = useState(false);
  const [isOverridden, setIsOverridden] = useState(() => keybindingService.hasOverride(actionId));

  useEffect(() => {
    const update = () => setIsOverridden(keybindingService.hasOverride(actionId));
    update();
    return keybindingService.subscribe(update);
  }, [actionId]);

  const handleSave = useCallback(
    async (combo: string) => {
      const result = await actionService.dispatch(
        "keybinding.setOverride",
        { actionId, combo: combo === "" ? [] : [combo] },
        { source: "user" }
      );
      if (!result.ok) {
        logError("[AgentSettings] Failed to save agent shortcut", undefined, {
          error: result.error,
        });
        // Stay in capture mode so the user can retry — closing silently after
        // a failed IPC would discard the captured combo with no recovery path.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          message: "Couldn't save shortcut",
          duration: 3000,
          priority: "high",
        });
        return;
      }
      setIsEditing(false);
    },
    [actionId]
  );

  const handleReset = useCallback(async () => {
    const result = await actionService.dispatch(
      "keybinding.removeOverride",
      { actionId },
      { source: "user" }
    );
    if (!result.ok) {
      logError("[AgentSettings] Failed to reset agent shortcut", undefined, {
        error: result.error,
      });
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        message: "Couldn't reset shortcut",
        duration: 3000,
        priority: "high",
      });
    }
  }, [actionId]);

  return (
    <SettingsRow
      id={`agents-shortcut-${agentId}`}
      label="Keyboard shortcut"
      description={`Launch ${agentName} from anywhere with a key combination`}
      layout={isEditing ? "stacked" : "inline"}
      control={
        isEditing ? (
          <AgentShortcutCapture
            agentId={agentId}
            onCapture={(combo) => void handleSave(combo)}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <div className="flex items-center gap-2" data-testid={`agent-shortcut-row-${agentId}`}>
            {isOverridden && (
              <button
                type="button"
                onClick={() => void handleReset()}
                aria-label={`Reset ${agentName} shortcut to default`}
                data-testid={`agent-shortcut-reset-${agentId}`}
                className="p-1 rounded-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
            {displayCombo ? (
              <span
                data-testid={`agent-shortcut-pill-${agentId}`}
                className="px-2 py-0.5 text-xs font-mono rounded-[var(--radius-sm)] bg-overlay-subtle border border-border-default text-text-primary"
              >
                {displayCombo}
              </span>
            ) : (
              <span className="text-xs text-text-secondary">Unbound</span>
            )}
            <Button
              size="sm"
              variant="subtle"
              onClick={() => setIsEditing(true)}
              data-testid={`agent-shortcut-edit-${agentId}`}
            >
              {displayCombo ? "Change" : "Assign"}
            </Button>
          </div>
        )
      }
    />
  );
}

interface AgentSettingsProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
  onSettingsChange?: () => void;
}

export function AgentSettings({
  activeSubtab,
  onSubtabChange,
  onSettingsChange,
}: AgentSettingsProps) {
  const {
    settings,
    error: storeError,
    initialize,
    refresh,
    updateAgent,
    setAgentPinned,
    setGlobalSkipPermissions,
    setGlobalUseAltScreen,
    reset,
  } = useAgentSettingsStore();

  const cliAvailability = useCliAvailabilityStore((state) => state.availability);
  const isCliLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isRefreshingCli = useCliAvailabilityStore((state) => state.isRefreshing);
  const cliError = useCliAvailabilityStore((state) => state.error);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  // initialize() is singleflight via the store's `initPromise` — retries must
  // route through refresh() to issue a fresh IPC. The store catches load
  // failures internally and surfaces them via its `error` field; the hook
  // only watches for the timeout case.
  const { loadError: timeoutError, retryAction } = useTabLoad({
    initialize,
    retry: refresh,
    timeoutMessage: "Agent settings took too long to load.",
  });
  const loadError = timeoutError ?? storeError;

  useEffect(() => {
    void initializeCliAvailability();
  }, [initializeCliAvailability]);

  // Detail map (resolved path, probe source, block reason) is a separate,
  // read-only IPC call populated by the same detection cycle as availability.
  // Refetched after a user-initiated refresh so the surfaced path/blocked
  // state stays in sync.
  const [cliDetails, setCliDetails] = useState<AgentCliDetails>({});
  const fetchCliDetails = useCallback(async () => {
    try {
      const details = await cliAvailabilityClient.getDetails();
      setCliDetails(details);
    } catch (error) {
      logError("[AgentSettings] Failed to fetch CLI details", error);
    }
  }, []);

  useEffect(() => {
    if (!isCliLoading) {
      void fetchCliDetails();
    }
  }, [isCliLoading, fetchCliDetails]);

  const handleRefreshCliAvailability = async () => {
    if (isRefreshingCli) return;
    try {
      // Explicit user gesture — bypass the 30s throttle that exists for
      // passive triggers (tray-open, window focus, visibility change).
      await refreshCliAvailability(true);
      await fetchCliDetails();
    } catch (error) {
      logError("[AgentSettings] Failed to refresh CLI availability", error);
    }
  };

  const defaultAgent = useAgentPreferencesStore((state) => state.defaultAgent);
  const setDefaultAgent = useAgentPreferencesStore((state) => state.setDefaultAgent);

  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);

  // Rate limiting refs
  const lastAddTimeRef = useRef(0);
  const lastEditTimeRef = useRef(0);

  const helpShortcut = useKeybindingDisplay("help.launchAgent");

  // Preset editing state
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [addDialogAgentId, setAddDialogAgentId] = useState<string | null>(null);

  const handleCreatePreset = async (presetData: Omit<AgentPreset, "id">) => {
    if (!addDialogAgentId) return;
    const freshSettings = useAgentSettingsStore.getState().settings ?? DEFAULT_AGENT_SETTINGS;
    const entry = getAgentSettingsEntry(freshSettings, addDialogAgentId);
    const existing = entry.customPresets ?? [];
    const id = `user-${crypto.randomUUID()}`;
    const updated = [...existing, { ...presetData, id }];
    try {
      await updateAgent(addDialogAgentId, { customPresets: updated, presetId: id });
      onSettingsChange?.();
      lastAddTimeRef.current = Date.now();
      setIsAddDialogOpen(false);
      setAddDialogAgentId(null);
    } catch (error) {
      logError("[AgentSettings] Failed to create preset", error);
    }
  };

  const agentIds = useMemo(() => getAgentIds(), []);
  const effectiveSettings = settings ?? DEFAULT_AGENT_SETTINGS;

  const isGeneralActive =
    activeSubtab === GENERAL_SUBTAB_ID || activeSubtab === null || !agentIds.includes(activeSubtab);
  const activeAgentId = isGeneralActive ? null : activeSubtab;

  // Reset preset-editing state when switching agent subtabs OR scopes. Without
  // activeSubtab we leak an in-progress rename from one agent into another on
  // tab switch; without presetId the unified scope editor's keyed remount
  // unmounts the input (editingPresetId stays set, so returning to that preset
  // reopens it in edit mode with stale buffer text). Cancel rather than
  // commit — matches handleCancelEdit's existing gesture semantics for blur.
  const activeEntryPresetId = activeAgentId
    ? (settings?.agents?.[activeAgentId]?.presetId ?? null)
    : null;
  useEffect(() => {
    setEditingPresetId(null);
    setEditName("");
  }, [activeSubtab, activeEntryPresetId]);

  // Stale-preset cleanup in Settings: when a saved presetId no longer resolves
  // (deleted custom preset, CCR route removed from config), clear it so the
  // Settings UI and the stored settings agree. useAgentLauncher.ts does this
  // cleanup on the next launch, but the UI otherwise shows default with a
  // zombie presetId in storage until the user launches the agent again.
  // updateAgent/onSettingsChange are stable Zustand actions / prop callbacks;
  // calling them via useEffectEvent keeps them out of the deps array so the
  // effect only reruns on activeAgentId/settings/ccrPresetsByAgent changes.
  const clearStalePreset = useEffectEvent(() => {
    if (!activeAgentId) return;
    const entry = settings?.agents?.[activeAgentId];
    if (!entry?.presetId) return;
    const ccr = ccrPresetsByAgent[activeAgentId];
    const project = projectPresetsByAgent[activeAgentId];
    const merged = getMergedPresets(activeAgentId, entry.customPresets, ccr, project);
    const stillExists = merged.some((f) => f.id === entry.presetId);
    if (!stillExists) {
      void (async () => {
        await updateAgent(activeAgentId, { presetId: undefined });
        onSettingsChange?.();
      })();
    }
  });
  useEffect(() => {
    void activeAgentId;
    void settings;
    void ccrPresetsByAgent;
    void projectPresetsByAgent;
    clearStalePreset();
  }, [activeAgentId, settings, ccrPresetsByAgent, projectPresetsByAgent]);

  const agentOptions = useMemo(
    () =>
      agentIds
        .map((id) => {
          const config = getAgentConfig(id);
          if (!config) return null;
          const entry = getAgentSettingsEntry(effectiveSettings, id);
          return {
            id,
            name: config.name,
            color: config.color,
            Icon: config.icon,
            usageUrl: config.usageUrl,
            selected: isAgentToolbarVisible(entry, cliAvailability?.[id]),
            dangerousEnabled: entry.dangerousEnabled ?? false,
            hasCustomFlags: Boolean(entry.customFlags?.trim()),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    [agentIds, effectiveSettings, cliAvailability]
  );

  const activeAgent = activeAgentId ? agentOptions.find((a) => a.id === activeAgentId) : null;
  const activeEntry = activeAgent
    ? getAgentSettingsEntry(effectiveSettings, activeAgent.id)
    : { customFlags: "", dangerousArgs: "", dangerousEnabled: false };

  const defaultDangerousArg = activeAgent ? (DEFAULT_DANGEROUS_ARGS[activeAgent.id] ?? "") : "";
  const activeDecorations = activeAgent
    ? getAgentConfig(activeAgent.id)?.capabilities?.decorations
    : undefined;

  const defaultAgentOptions = useMemo(
    () => [
      { value: NO_DEFAULT_AGENT, label: "None (first available)" },
      ...agentOptions.map((agent) => ({ value: agent.id, label: agent.name })),
    ],
    [agentOptions]
  );

  if (agentOptions.length === 0) {
    return (
      <div className="text-sm text-text-secondary">
        No agents registered. Add agents to the registry to configure them here.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <AgentSelectorDropdown
            agentOptions={agentOptions}
            activeSubtab={
              isGeneralActive ? GENERAL_SUBTAB_ID : (activeAgentId ?? GENERAL_SUBTAB_ID)
            }
            onSubtabChange={onSubtabChange}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
          }}
          className="shrink-0"
        >
          <Plug className="w-3.5 h-3.5" />
          Run setup wizard
        </Button>
      </div>

      {isGeneralActive && (
        <SettingsSection
          id="agents-general"
          title="Global agent settings"
          description="Defaults for every agent. Each agent's page can override them"
        >
          <SettingsGroup>
            <SettingsSelect
              id="agents-default-agent"
              label="Default agent"
              description={
                <>
                  Used by the help dock button{helpShortcut && ` (${helpShortcut})`} and automated
                  workflows such as "What's next?", onboarding and project explanations. The
                  portal's default new tab agent is set separately
                </>
              }
              value={defaultAgent ?? NO_DEFAULT_AGENT}
              onValueChange={(value) =>
                setDefaultAgent(value === NO_DEFAULT_AGENT ? undefined : (value as DefaultAgentId))
              }
              options={defaultAgentOptions}
              isModified={defaultAgent !== undefined}
              onReset={() => setDefaultAgent(undefined)}
            />
            <SettingsSwitchCard
              id="agents-skip-permissions"
              title="Skip permission prompts"
              subtitle="Agents run commands and edit files without asking — faster, but you won't get a chance to review first. Applies to every agent that supports it; Assistant sessions aren't affected"
              isEnabled={settings?.globalSkipPermissions ?? false}
              onChange={() => {
                void (async () => {
                  await setGlobalSkipPermissions(!(settings?.globalSkipPermissions ?? false));
                  onSettingsChange?.();
                })();
              }}
              isModified={
                (settings?.globalSkipPermissions ?? false) !==
                DEFAULT_AGENT_SETTINGS.globalSkipPermissions
              }
              onReset={() => {
                void (async () => {
                  await setGlobalSkipPermissions(
                    DEFAULT_AGENT_SETTINGS.globalSkipPermissions ?? false
                  );
                  onSettingsChange?.();
                })();
              }}
            />
            <SettingsSwitchCard
              id="agents-alt-screen"
              title="Use alt-screen mode"
              subtitle="Render supported agents on the full-screen alternate buffer instead of inline. Inline is smoother (WebGL scrollback, clean resize); alt-screen matches the CLI's native full-screen TUI"
              isEnabled={settings?.globalUseAltScreen ?? false}
              onChange={() => {
                void (async () => {
                  await setGlobalUseAltScreen(!(settings?.globalUseAltScreen ?? false));
                  onSettingsChange?.();
                })();
              }}
              isModified={
                (settings?.globalUseAltScreen ?? false) !==
                DEFAULT_AGENT_SETTINGS.globalUseAltScreen
              }
              onReset={() => {
                void (async () => {
                  await setGlobalUseAltScreen(DEFAULT_AGENT_SETTINGS.globalUseAltScreen ?? false);
                  onSettingsChange?.();
                })();
              }}
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {!isGeneralActive && activeAgent && (
        <>
          <div className="flex items-center gap-3">
            <BrandMark brandColor={activeAgent.color}>
              <activeAgent.Icon size={20} />
            </BrandMark>
            <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              {activeAgent.name}
            </h4>
            <div className="flex shrink-0 items-center gap-2">
              {activeAgent.usageUrl && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const url = activeAgent.usageUrl?.trim();
                    if (!url) return;
                    try {
                      const result = await actionService.dispatch(
                        "system.openExternal",
                        { url },
                        { source: "user" }
                      );
                      if (!result.ok) throw new Error(result.error.message);
                    } catch (error) {
                      logError("Failed to open usage URL", error);
                    }
                  }}
                >
                  <ExternalLink size={14} />
                  View usage
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await reset(activeAgent.id);
                  onSettingsChange?.();
                }}
              >
                <RotateCcw size={14} />
                Reset
              </Button>
            </div>
          </div>

          <SettingsSection title="Launching">
            <SettingsGroup>
              <SettingsSwitchCard
                id="agents-enable"
                title="Pin to toolbar"
                subtitle="Show this agent in the toolbar for quick access"
                isEnabled={isAgentToolbarVisible(activeEntry, cliAvailability?.[activeAgent.id])}
                onChange={() => {
                  // Tri-state toggle (#7673): flip the *currently visible* state so
                  // an undefined-pinned installed agent gets `pinned: false` (hide)
                  // and an undefined-pinned missing agent gets `pinned: true` (show).
                  const current = isAgentToolbarVisible(
                    activeEntry,
                    cliAvailability?.[activeAgent.id]
                  );
                  void (async () => {
                    await setAgentPinned(activeAgent.id, !current);
                    onSettingsChange?.();
                  })();
                }}
                ariaLabel={`Pin ${activeAgent.name} to toolbar`}
              />

              {/* Built-in agents only; user-defined agents don't participate in the keybinding registry. */}
              {isBuiltInAgentId(activeAgent.id) && (
                <AgentShortcutRow agentId={activeAgent.id} agentName={activeAgent.name} />
              )}

              {activeDecorations && (
                <SettingsSwitchCard
                  id="agents-decorations"
                  title={activeDecorations.label}
                  subtitle={activeDecorations.description}
                  isEnabled={activeEntry.decorativeEffects === true}
                  onChange={() => {
                    const next = activeEntry.decorativeEffects !== true;
                    void (async () => {
                      await updateAgent(activeAgent.id, { decorativeEffects: next });
                      onSettingsChange?.();
                    })();
                  }}
                  ariaLabel={`${activeDecorations.label} for ${activeAgent.name}`}
                />
              )}

              {activeAgent.id === "gemini" && (
                <SettingsSwitchCard
                  id="agents-clipboard"
                  title="Share clipboard directory"
                  subtitle="Allow Gemini to read pasted clipboard images via --include-directories"
                  isEnabled={activeEntry.shareClipboardDirectory !== false}
                  onChange={() => {
                    const current = activeEntry.shareClipboardDirectory !== false;
                    void (async () => {
                      await updateAgent(activeAgent.id, { shareClipboardDirectory: !current });
                      onSettingsChange?.();
                    })();
                  }}
                  ariaLabel="Share clipboard directory with Gemini"
                />
              )}
            </SettingsGroup>
          </SettingsSection>

          {/* Unified scope editor — one set of controls for Default or any preset.
              The editor body is keyed on the scope id so rename/edit state resets
              naturally on scope switch (see #4958). */}
          <AgentScopeEditor
            agentId={activeAgent.id}
            activeEntry={activeEntry}
            ccrPresets={ccrPresetsByAgent[activeAgent.id]}
            projectPresets={projectPresetsByAgent[activeAgent.id]}
            defaultDangerousArg={defaultDangerousArg}
            editingPresetId={editingPresetId}
            setEditingPresetId={setEditingPresetId}
            editName={editName}
            setEditName={setEditName}
            lastEditTimeRef={lastEditTimeRef}
            setIsAddDialogOpen={setIsAddDialogOpen}
            setAddDialogAgentId={setAddDialogAgentId}
            updateAgent={updateAgent}
            onSettingsChange={onSettingsChange}
          />

          <AgentHelpOutput
            agentId={activeAgent.id}
            agentName={activeAgent.name}
            usageUrl={activeAgent.usageUrl}
            availability={cliAvailability[activeAgent.id] ?? "missing"}
            isCliLoading={isCliLoading}
          />

          <AgentInstallSection
            agentId={activeAgent.id}
            agentName={activeAgent.name}
            availability={cliAvailability[activeAgent.id]}
            detail={cliDetails[activeAgent.id]}
            isCliLoading={isCliLoading}
            isRefreshingCli={isRefreshingCli}
            cliError={cliError}
            onRefresh={() => void handleRefreshCliAvailability()}
          />
        </>
      )}

      {addDialogAgentId && (
        <AddPresetDialog
          isOpen={isAddDialogOpen}
          onClose={() => {
            setIsAddDialogOpen(false);
            setAddDialogAgentId(null);
          }}
          agentId={addDialogAgentId}
          currentPreset={(() => {
            if (!addDialogAgentId) return null;
            const entry = getAgentSettingsEntry(effectiveSettings, addDialogAgentId);
            if (!entry.presetId) return null;
            const ccr = ccrPresetsByAgent[addDialogAgentId];
            const project = projectPresetsByAgent[addDialogAgentId];
            const merged = getMergedPresets(addDialogAgentId, entry.customPresets, ccr, project);
            return merged.find((f) => f.id === entry.presetId) ?? null;
          })()}
          onCreate={handleCreatePreset}
        />
      )}
    </div>
  );
}
