import { useEffect, useEffectEvent, useMemo, useRef, useState, useCallback } from "react";
import { getAgentIds, getAgentConfig, getMergedPresets, type AgentPreset } from "@/config/agents";
import { useAgentSettingsStore, useCliAvailabilityStore, useAgentPreferencesStore } from "@/store";
import { cliAvailabilityClient } from "@/clients";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
  type AgentCliDetails,
} from "@shared/types";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { RotateCcw, ExternalLink, Plus, Copy, Trash2, Pencil, X as XIcon } from "lucide-react";
import { FALLBACK_CHAIN_MAX } from "../../../shared/config/agentRegistry";
import { DaintreeAgentIcon } from "@/components/icons";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
import { PresetSelector } from "./PresetSelector";
import { PresetColorPicker } from "./PresetColorPicker";
import { EnvVarEditor } from "./EnvVarEditor";
import { AddPresetDialog } from "./AddPresetDialog";
import { actionService } from "@/services/ActionService";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { AgentCard, AgentInstallSection } from "@/components/agents/AgentCard";
import type { DefaultAgentId } from "@/store/agentPreferencesStore";

const GENERAL_SUBTAB_ID = "general";

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
    isLoading,
    error: loadError,
    initialize,
    updateAgent,
    setAgentPinned,
    reset,
  } = useAgentSettingsStore();

  const cliAvailability = useCliAvailabilityStore((state) => state.availability);
  const isCliLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isRefreshingCli = useCliAvailabilityStore((state) => state.isRefreshing);
  const cliError = useCliAvailabilityStore((state) => state.error);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    initialize();
    const timer = setTimeout(() => setLoadTimedOut(true), 10_000);
    return () => clearTimeout(timer);
  }, [initialize]);

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
      console.error("[AgentSettings] Failed to fetch CLI details:", error);
    }
  }, []);

  useEffect(() => {
    if (!isCliLoading) {
      void fetchCliDetails();
    }
  }, [isCliLoading, fetchCliDetails]);

  const handleRefreshCliAvailability = useCallback(async () => {
    if (isRefreshingCli) return;
    try {
      // Explicit user gesture — bypass the 30s throttle that exists for
      // passive triggers (tray-open, window focus, visibility change).
      await refreshCliAvailability(true);
      await fetchCliDetails();
    } catch (error) {
      console.error("[AgentSettings] Failed to refresh CLI availability:", error);
    }
  }, [isRefreshingCli, refreshCliAvailability, fetchCliDetails]);

  const defaultAgent = useAgentPreferencesStore((state) => state.defaultAgent);
  const setDefaultAgent = useAgentPreferencesStore((state) => state.setDefaultAgent);

  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);

  // Rate limiting refs
  const lastAddTimeRef = useRef(0);
  const lastEditTimeRef = useRef(0);

  // Preset editing state
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [addDialogAgentId, setAddDialogAgentId] = useState<string | null>(null);

  const handleCreatePreset = async (presetData: Omit<AgentPreset, "id">) => {
    if (!addDialogAgentId) return;
    const now = Date.now();
    const freshSettings = useAgentSettingsStore.getState().settings ?? DEFAULT_AGENT_SETTINGS;
    const entry = getAgentSettingsEntry(freshSettings, addDialogAgentId);
    const existing = entry.customPresets ?? [];
    let id = `user-${now}`;
    if (existing.some((f) => f.id === id)) {
      let suffix = 1;
      while (existing.some((f) => f.id === `user-${now}-${suffix}`)) suffix += 1;
      id = `user-${now}-${suffix}`;
    }
    const updated = [...existing, { ...presetData, id }];
    try {
      await updateAgent(addDialogAgentId, { customPresets: updated, presetId: id });
      onSettingsChange?.();
      lastAddTimeRef.current = now;
      setIsAddDialogOpen(false);
      setAddDialogAgentId(null);
    } catch (error) {
      console.error("[AgentSettings] Failed to create preset:", error);
    }
  };

  // Reset preset-editing state when switching between agent subtabs. Without
  // this, an in-progress rename on one agent's preset would leak into a
  // different agent's panel after a tab switch (and can silently commit the
  // rename to the wrong agent on blur).
  useEffect(() => {
    setEditingPresetId(null);
    setEditName("");
  }, [activeSubtab]);

  const agentIds = useMemo(() => getAgentIds(), []);
  const effectiveSettings = settings ?? DEFAULT_AGENT_SETTINGS;

  const isGeneralActive =
    activeSubtab === GENERAL_SUBTAB_ID || activeSubtab === null || !agentIds.includes(activeSubtab);
  const activeAgentId = isGeneralActive ? null : activeSubtab;

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
            selected: isAgentPinned(entry),
            dangerousEnabled: entry.dangerousEnabled ?? false,
            hasCustomFlags: Boolean(entry.customFlags?.trim()),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    [agentIds, effectiveSettings]
  );

  const activeAgent = activeAgentId ? agentOptions.find((a) => a.id === activeAgentId) : null;
  const activeEntry = activeAgent
    ? getAgentSettingsEntry(effectiveSettings, activeAgent.id)
    : { customFlags: "", dangerousArgs: "", dangerousEnabled: false };

  const defaultDangerousArg = activeAgent ? (DEFAULT_DANGEROUS_ARGS[activeAgent.id] ?? "") : "";

  if (agentOptions.length === 0) {
    return (
      <div className="text-sm text-daintree-text/60">
        No agents registered. Add agents to the registry to configure them here.
      </div>
    );
  }

  if (isLoading && !settings) {
    if (loadTimedOut) {
      return (
        <div className="flex flex-col items-center justify-center h-32 gap-3">
          <div className="text-status-error text-sm">Settings load timed out</div>
          <button
            onClick={() => void actionService.dispatch("ui.refresh", undefined, { source: "user" })}
            className="text-xs px-3 py-1.5 bg-daintree-accent/10 hover:bg-daintree-accent/20 text-daintree-accent rounded transition-colors"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-daintree-text/60 text-sm">Loading settings...</div>
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-3">
        <div className="text-status-error text-sm">{loadError || "Failed to load settings"}</div>
        <button
          onClick={() => void actionService.dispatch("ui.refresh", undefined, { source: "user" })}
          className="text-xs px-3 py-1.5 bg-daintree-accent/10 hover:bg-daintree-accent/20 text-daintree-accent rounded transition-colors"
        >
          Reload Application
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium mb-1">CLI Agents</h4>
            <p className="text-xs text-daintree-text/50 select-text">
              Configure global agent preferences and per-agent settings
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
            }}
            className="text-daintree-text/60 hover:text-daintree-text shrink-0"
          >
            <DaintreeAgentIcon className="w-3.5 h-3.5" />
            Run Setup Wizard
          </Button>
        </div>

        <AgentSelectorDropdown
          agentOptions={agentOptions}
          activeSubtab={isGeneralActive ? GENERAL_SUBTAB_ID : (activeAgentId ?? GENERAL_SUBTAB_ID)}
          onSubtabChange={onSubtabChange}
        />

        {isGeneralActive && (
          <div
            id="agents-general"
            className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4"
          >
            <div className="pb-3 border-b border-daintree-border">
              <h4 className="text-sm font-medium text-daintree-text">Global Agent Settings</h4>
              <p className="text-xs text-daintree-text/50 mt-0.5 select-text">
                Settings that apply across all agents
              </p>
            </div>
            <div id="agents-default-agent" className="space-y-2">
              <label className="text-sm font-medium text-daintree-text block">Default agent</label>
              <select
                value={defaultAgent ?? ""}
                onChange={(e) =>
                  setDefaultAgent(e.target.value ? (e.target.value as DefaultAgentId) : undefined)
                }
                className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-none transition-colors"
              >
                <option value="">None (first available)</option>
                {agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-daintree-text/40 select-text">
                Agent used for the help dock button (⌘⇧H) and automated workflows ("What's Next?",
                onboarding, project explanations). Distinct from the Portal "Default New Tab Agent"
                which controls the browser panel opened by the + button.
              </p>
            </div>
          </div>
        )}

        {!isGeneralActive && activeAgent && agentOptions.some((a) => a.id === activeAgent.id) && (
          <AgentCard
            mode="management"
            agentId={activeAgent.id}
            actions={
              <>
                {activeAgent.usageUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-daintree-text/50 hover:text-daintree-text"
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
                        console.error("Failed to open usage URL:", error);
                      }
                    }}
                  >
                    <ExternalLink size={14} />
                    View Usage
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-daintree-text/50 hover:text-daintree-text"
                  onClick={async () => {
                    await reset(activeAgent.id);
                    onSettingsChange?.();
                  }}
                >
                  <RotateCcw size={14} />
                  Reset
                </Button>
              </>
            }
          >
            {/* Pin to Toolbar */}
            <div id="agents-enable">
              <SettingsSwitchCard
                variant="compact"
                title="Pin to toolbar"
                subtitle="When pinned, this agent appears in the toolbar for quick access"
                isEnabled={isAgentPinned(activeEntry)}
                onChange={() => {
                  const current = isAgentPinned(activeEntry);
                  void (async () => {
                    await setAgentPinned(activeAgent.id, !current);
                    onSettingsChange?.();
                  })();
                }}
                ariaLabel={`Pin ${activeAgent.name} to toolbar`}
              />
            </div>

            {/* Agent-level Defaults — always visible */}
            <div
              id="agents-defaults"
              className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4"
            >
              <div className="pb-3 border-b border-daintree-border">
                <label className="text-sm font-medium text-daintree-text">Defaults</label>
                <p className="text-xs text-daintree-text/40 select-text">
                  Base settings for every launch. Custom presets can override these.
                </p>
              </div>
              <div className="space-y-3">
                {(() => {
                  const agentCfg = getAgentConfig(activeAgent.id);
                  const supportsInlineMode = !!agentCfg?.capabilities?.inlineModeFlag;
                  const skipPerms = activeEntry.dangerousEnabled ?? false;
                  const inlineMode = activeEntry.inlineMode ?? true;
                  const customFlags = activeEntry.customFlags ?? "";
                  return (
                    <>
                      <div id="agents-skip-permissions-default" className="space-y-1.5">
                        <SettingsSwitchCard
                          variant="compact"
                          title="Skip Permissions"
                          subtitle="Auto-approve all file, command, and network actions"
                          isEnabled={skipPerms}
                          onChange={() => {
                            void (async () => {
                              await updateAgent(activeAgent.id, { dangerousEnabled: !skipPerms });
                              onSettingsChange?.();
                            })();
                          }}
                          ariaLabel={`Skip permissions for ${activeAgent.name}`}
                          colorScheme="danger"
                        />
                        {skipPerms && defaultDangerousArg && (
                          <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                            <code className="text-xs text-status-error font-mono">
                              {defaultDangerousArg}
                            </code>
                            <span className="text-xs text-daintree-text/40">added to command</span>
                          </div>
                        )}
                      </div>
                      {supportsInlineMode && (
                        <div id="agents-inline-mode-default">
                          <SettingsSwitchCard
                            variant="compact"
                            title="Inline Mode"
                            subtitle="Disable fullscreen TUI for better resize handling and scrollback"
                            isEnabled={inlineMode}
                            onChange={() => {
                              void (async () => {
                                await updateAgent(activeAgent.id, { inlineMode: !inlineMode });
                                onSettingsChange?.();
                              })();
                            }}
                            ariaLabel={`Inline mode for ${activeAgent.name}`}
                          />
                        </div>
                      )}
                      <div id="agents-custom-args-default" className="space-y-1.5">
                        <label className="text-sm font-medium text-daintree-text">
                          Custom Arguments
                        </label>
                        <input
                          className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-muted"
                          value={customFlags}
                          onChange={(e) => {
                            void updateAgent(activeAgent.id, { customFlags: e.target.value });
                          }}
                          placeholder="--verbose --max-tokens=4096"
                        />
                        <p className="text-xs text-daintree-text/40 select-text">
                          Extra CLI flags appended when launching
                        </p>
                      </div>
                    </>
                  );
                })()}
                <div id="agents-global-env" className="space-y-2">
                  <div>
                    <label className="text-sm font-medium text-daintree-text">
                      Global env vars
                    </label>
                    <p className="text-xs text-daintree-text/40 select-text">
                      Applied to every launch. Preset-specific vars take precedence.
                    </p>
                  </div>
                  <EnvVarEditor
                    env={(activeEntry.globalEnv as Record<string, string>) ?? {}}
                    onChange={(globalEnv) => {
                      void (async () => {
                        await updateAgent(activeAgent.id, {
                          globalEnv: Object.keys(globalEnv).length > 0 ? globalEnv : undefined,
                        });
                        onSettingsChange?.();
                      })();
                    }}
                    suggestions={getAgentConfig(activeAgent.id)?.envSuggestions ?? []}
                    datalistId="env-key-suggestions-global"
                    contextKey={`global-${activeAgent.id}`}
                    valuePlaceholder="value"
                    data-testid="global-env-editor"
                  />
                </div>
              </div>
            </div>

            {/* Preset section — picker + all per-preset settings inside */}
            {(() => {
              const ccrPresets = ccrPresetsByAgent[activeAgent.id];
              const projectPresets = projectPresetsByAgent[activeAgent.id];
              const customPresets = activeEntry.customPresets;
              const allPresets = getMergedPresets(
                activeAgent.id,
                customPresets,
                ccrPresets,
                projectPresets
              );
              const agentCfg = getAgentConfig(activeAgent.id);
              const supportsInlineMode = !!agentCfg?.capabilities?.inlineModeFlag;

              const selectedPreset = allPresets.find((f) => f.id === activeEntry.presetId);
              // A custom preset with the same ID overrides CCR/project in
              // getMergedPresets, so membership in customPresets is the
              // canonical signal for "selected is custom" — prefix-based
              // checks would mis-classify a project preset that happened to
              // start with "user-".
              // Source precedence for display classification (custom > project > CCR):
              // membership checks must beat the ccr- prefix heuristic so that a
              // project preset whose id happens to start with "ccr-" is still
              // surfaced under its true source in the detail view.
              const selectedIsCustom =
                !!selectedPreset && (customPresets ?? []).some((f) => f.id === selectedPreset.id);
              const selectedIsProject =
                !!selectedPreset &&
                !selectedIsCustom &&
                (projectPresets ?? []).some((f) => f.id === selectedPreset.id);
              const selectedIsCcr =
                !!selectedPreset &&
                !selectedIsCustom &&
                !selectedIsProject &&
                selectedPreset.id.startsWith("ccr-");

              // ── handlers ──────────────────────────────────────────────────

              const openAddDialog = () => {
                setAddDialogAgentId(activeAgent.id);
                setIsAddDialogOpen(true);
              };

              const handleDuplicatePreset = (preset: AgentPreset) => {
                const id = `user-${Date.now()}`;
                const updated = [
                  ...(activeEntry.customPresets ?? []),
                  { ...preset, id, name: `${preset.name} (copy)` },
                ];
                void (async () => {
                  await updateAgent(activeAgent.id, { customPresets: updated });
                  onSettingsChange?.();
                })();
              };

              const handleDeletePreset = (presetId: string) => {
                const updated = (activeEntry.customPresets ?? []).filter((f) => f.id !== presetId);
                void (async () => {
                  if (activeEntry.presetId === presetId) {
                    await updateAgent(activeAgent.id, {
                      customPresets: updated,
                      presetId: undefined,
                    });
                  } else {
                    await updateAgent(activeAgent.id, { customPresets: updated });
                  }
                  onSettingsChange?.();
                })();
              };

              const handleUpdatePreset = (presetId: string, patch: Partial<AgentPreset>) => {
                const updated = (activeEntry.customPresets ?? []).map((f) =>
                  f.id === presetId ? { ...f, ...patch } : f
                );
                void (async () => {
                  try {
                    await updateAgent(activeAgent.id, { customPresets: updated });
                    onSettingsChange?.();
                  } catch (error) {
                    console.error("Failed to update preset:", error);
                  }
                })();
              };

              const handleStartEdit = (preset: AgentPreset) => {
                if (!preset.name || preset.name.length > 200) {
                  console.warn("Invalid preset name length");
                  return;
                }
                if (/[<>'"&]/.test(preset.name)) {
                  console.warn("Preset name contains dangerous characters");
                  return;
                }
                setEditingPresetId(preset.id);
                setEditName(preset.name);
              };

              const handleCommitEdit = () => {
                const trimmed = editName.trim();
                if (
                  editingPresetId &&
                  trimmed &&
                  trimmed.length <= 200 &&
                  !/[<>'"&]/.test(trimmed)
                ) {
                  const now = Date.now();
                  if (now - lastEditTimeRef.current < 100) return;
                  lastEditTimeRef.current = now;
                  handleUpdatePreset(editingPresetId, { name: trimmed });
                }
                setEditingPresetId(null);
                setEditName("");
              };

              const handleCancelEdit = () => {
                setEditingPresetId(null);
                setEditName("");
              };

              // ── custom preset behavioral overrides ────────────────────────
              // Only rendered inside the custom-preset detail panel. Reads
              // from the preset, falling back to agent-level defaults when
              // the preset omits an override. Writes via handleUpdatePreset.
              //
              // Booleans render as tri-state selects (Inherit/On/Off): a
              // `boolean | undefined` override where `undefined` inherits the
              // agent-level default at launch. Custom Arguments uses a text
              // input with a reset button that clears the override.

              const agentDefaultDangerous = activeEntry.dangerousEnabled ?? false;
              const agentDefaultInline = activeEntry.inlineMode ?? true;
              const agentDefaultCustomFlags = activeEntry.customFlags ?? "";

              const dangerousOverride = selectedPreset?.dangerousEnabled;
              const inlineOverride = selectedPreset?.inlineMode;
              const customFlagsOverride = selectedPreset?.customFlags;

              // Effective (merged) values — the dangerous-arg strip must
              // reflect what actually gets passed to the CLI at launch.
              const effectiveSkipPerms = dangerousOverride ?? agentDefaultDangerous;

              const onDangerousOverrideChange = (value: boolean | undefined) => {
                if (!selectedPreset) return;
                handleUpdatePreset(selectedPreset.id, { dangerousEnabled: value });
              };

              const onInlineOverrideChange = (value: boolean | undefined) => {
                if (!selectedPreset) return;
                handleUpdatePreset(selectedPreset.id, { inlineMode: value });
              };

              const onCustomFlagsOverrideChange = (value: string) => {
                if (!selectedPreset) return;
                handleUpdatePreset(selectedPreset.id, { customFlags: value });
              };

              const onCustomFlagsOverrideReset = () => {
                if (!selectedPreset) return;
                handleUpdatePreset(selectedPreset.id, { customFlags: undefined });
              };

              // Tri-state select serialization: a non-empty sentinel stands
              // in for "no override" because Radix Select forbids `value=""`
              // on SelectItem. The sentinel is never persisted — it is mapped
              // back to `undefined` in `selectValueToBool` before any write.
              const boolToSelectValue = (v: boolean | undefined): string =>
                v === undefined ? "__inherit__" : v ? "true" : "false";
              // Defensively fall back to `undefined` for unexpected strings so
              // a future option-value typo can't silently write `false`.
              const selectValueToBool = (s: string): boolean | undefined =>
                s === "true" ? true : s === "false" ? false : undefined;

              const dangerousSelectOptions = [
                {
                  value: "__inherit__",
                  label: `Inherit (${agentDefaultDangerous ? "On" : "Off"})`,
                },
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ];

              const inlineSelectOptions = [
                {
                  value: "__inherit__",
                  label: `Inherit (${agentDefaultInline ? "On" : "Off"})`,
                },
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ];

              // Only build when a preset is selected — the aria-label template
              // literals below dereference `selectedPreset.name`, so building
              // this unconditionally would throw on the re-render that follows
              // deleting the currently selected preset (presetId reset to
              // undefined → selectedPreset becomes undefined).
              const behavioralSettings = selectedPreset ? (
                <div className="space-y-3">
                  <div id="agents-skip-permissions-preset" className="space-y-1.5">
                    <SettingsSelect
                      label="Skip Permissions"
                      description="Auto-approve all file, command, and network actions"
                      value={boolToSelectValue(dangerousOverride)}
                      onValueChange={(v) => onDangerousOverrideChange(selectValueToBool(v))}
                      isModified={dangerousOverride !== undefined}
                      onReset={() => onDangerousOverrideChange(undefined)}
                      resetAriaLabel={`Reset skip permissions override for ${selectedPreset.name}`}
                      options={dangerousSelectOptions}
                    />
                    {effectiveSkipPerms && defaultDangerousArg && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                        <code className="text-xs text-status-error font-mono">
                          {defaultDangerousArg}
                        </code>
                        <span className="text-xs text-daintree-text/40">added to command</span>
                      </div>
                    )}
                  </div>

                  {supportsInlineMode && (
                    <div id="agents-inline-mode-preset">
                      <SettingsSelect
                        label="Inline Mode"
                        description="Disable fullscreen TUI for better resize handling and scrollback"
                        value={boolToSelectValue(inlineOverride)}
                        onValueChange={(v) => onInlineOverrideChange(selectValueToBool(v))}
                        isModified={inlineOverride !== undefined}
                        onReset={() => onInlineOverrideChange(undefined)}
                        resetAriaLabel={`Reset inline mode override for ${selectedPreset.name}`}
                        options={inlineSelectOptions}
                      />
                    </div>
                  )}

                  <div id="agents-custom-args-preset" className="group space-y-1.5">
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium text-daintree-text">
                        Custom Arguments
                      </label>
                      {customFlagsOverride !== undefined && (
                        <>
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-daintree-accent"
                            aria-hidden="true"
                          />
                          <button
                            type="button"
                            aria-label={`Reset custom arguments override for ${selectedPreset.name}`}
                            className="p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-accent invisible group-hover:visible group-focus-within:visible focus-visible:visible focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent transition-colors"
                            onClick={onCustomFlagsOverrideReset}
                            data-testid="preset-custom-flags-reset"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                    <input
                      className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-muted"
                      value={customFlagsOverride ?? ""}
                      onChange={(e) => onCustomFlagsOverrideChange(e.target.value)}
                      placeholder={
                        customFlagsOverride === undefined
                          ? agentDefaultCustomFlags || "Inherit (no flags)"
                          : "--verbose --max-tokens=4096"
                      }
                      data-testid="preset-custom-flags-input"
                    />
                    <p className="text-xs text-daintree-text/40 select-text">
                      {customFlagsOverride === undefined
                        ? "Inheriting from agent default. Type to override."
                        : "Extra CLI flags for this preset"}
                    </p>
                  </div>
                </div>
              ) : null;

              // ── env var reference (always shown) ─────────────────────────
              const agentEnvSuggestions = getAgentConfig(activeAgent.id)?.envSuggestions ?? [];
              const envVarReference = (
                <div className="space-y-0.5 pt-1">
                  <p className="text-[11px] text-daintree-text/40 pb-0.5">
                    Available env overrides:
                  </p>
                  <datalist id="env-key-suggestions">
                    {agentEnvSuggestions.map(({ key }) => (
                      <option key={key} value={key} />
                    ))}
                  </datalist>
                  {agentEnvSuggestions.map(({ key, hint }) => (
                    <div key={key} className="flex items-baseline gap-2 font-mono">
                      <span className="text-[11px] text-daintree-text/60 shrink-0">{key}</span>
                      <span className="text-[10px] text-daintree-text/30">{hint}</span>
                    </div>
                  ))}
                </div>
              );

              return (
                <div
                  id="agents-presets"
                  className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4"
                >
                  <div className="pb-3 border-b border-daintree-border">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm font-medium text-daintree-text">Presets</label>
                        <p className="text-xs text-daintree-text/40 select-text">
                          Variants with different env overrides and model routes
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="preset-add-button"
                        className="text-daintree-accent hover:text-daintree-accent/80"
                        onClick={openAddDialog}
                      >
                        <Plus size={14} />
                        Add
                      </Button>
                    </div>
                  </div>

                  {allPresets.length > 0 && (
                    <>
                      {/* Unified preset picker — Popover listbox with color swatches and grouping */}
                      <PresetSelector
                        selectedPresetId={activeEntry.presetId ?? undefined}
                        allPresets={allPresets}
                        ccrPresets={ccrPresets ?? []}
                        projectPresets={projectPresets ?? []}
                        customPresets={customPresets ?? []}
                        onChange={(presetId) => {
                          void (async () => {
                            await updateAgent(activeAgent.id, { presetId: presetId ?? undefined });
                            onSettingsChange?.();
                          })();
                        }}
                        agentColor={getAgentConfig(activeAgent.id)?.color ?? "#888888"}
                      />

                      {/* Hidden datalist retained for any remaining text inputs that still reference it */}
                      <datalist id="env-key-suggestions">
                        {(getAgentConfig(activeAgent.id)?.envSuggestions ?? []).map(({ key }) => (
                          <option key={key} value={key} />
                        ))}
                      </datalist>
                    </>
                  )}

                  {/* Detail view for selected CCR preset */}
                  {selectedPreset && selectedIsCcr && (
                    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50">
                      <div className="px-3 py-2.5 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-daintree-text">
                            {selectedPreset.name.replace(/^CCR:\s*/, "")}
                          </span>
                          <span
                            data-testid="preset-badge-auto"
                            className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
                          >
                            auto
                          </span>
                          <button
                            className="ml-auto text-daintree-text/30 hover:text-daintree-text transition-colors"
                            onClick={() => handleDuplicatePreset(selectedPreset)}
                            aria-label={`Duplicate ${selectedPreset.name.replace(/^CCR:\s*/, "")}`}
                            title="Duplicate as custom"
                          >
                            <Copy size={13} />
                          </button>
                        </div>
                        {selectedPreset.env && Object.keys(selectedPreset.env).length > 0 && (
                          <div className="space-y-1">
                            {Object.entries(selectedPreset.env).map(([k, v]) => (
                              <div
                                key={k}
                                className="flex items-center gap-2 font-mono text-[11px]"
                              >
                                <span className="text-daintree-text/50 shrink-0">{k}</span>
                                <span className="text-daintree-text/30">=</span>
                                <span className="text-daintree-accent/70 truncate">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {selectedPreset.description && (
                          <p className="text-[11px] text-daintree-text/40 select-text">
                            {selectedPreset.description}
                          </p>
                        )}
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-xs text-daintree-text/40 select-text">
                          Uses agent-level defaults above, unless overridden in a custom preset.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Detail view for selected project-shared preset — read-only, mirrors CCR */}
                  {selectedPreset && selectedIsProject && (
                    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50">
                      <div className="px-3 py-2.5 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-daintree-text">
                            {selectedPreset.name}
                          </span>
                          <span
                            data-testid="preset-badge-project"
                            className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
                          >
                            project
                          </span>
                          <button
                            className="ml-auto text-daintree-text/30 hover:text-daintree-text transition-colors"
                            onClick={() => handleDuplicatePreset(selectedPreset)}
                            aria-label={`Duplicate ${selectedPreset.name}`}
                            title="Duplicate as custom"
                          >
                            <Copy size={13} />
                          </button>
                        </div>
                        {selectedPreset.env && Object.keys(selectedPreset.env).length > 0 && (
                          <div className="space-y-1">
                            {Object.entries(selectedPreset.env).map(([k, v]) => (
                              <div
                                key={k}
                                className="flex items-center gap-2 font-mono text-[11px]"
                              >
                                <span className="text-daintree-text/50 shrink-0">{k}</span>
                                <span className="text-daintree-text/30">=</span>
                                <span className="text-daintree-accent/70 truncate">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {selectedPreset.description && (
                          <p className="text-[11px] text-daintree-text/40 select-text">
                            {selectedPreset.description}
                          </p>
                        )}
                        <p className="text-[10px] text-daintree-text/40 select-text">
                          Sourced from <code>.daintree/presets/</code> in this project.
                        </p>
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-xs text-daintree-text/40 select-text">
                          Uses agent-level defaults above, unless overridden in a custom preset.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Detail view for selected custom preset */}
                  {selectedPreset && selectedIsCustom && (
                    <div
                      id="agents-preset-detail"
                      className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50"
                    >
                      {/* Name row */}
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        {/* Color picker — preset palette with Clear + Custom escape hatch */}
                        <PresetColorPicker
                          color={selectedPreset.color}
                          agentColor={getAgentConfig(activeAgent.id)?.color ?? "#888888"}
                          onChange={(color) => handleUpdatePreset(selectedPreset.id, { color })}
                          ariaLabel="Preset color"
                        />

                        {editingPresetId === selectedPreset.id ? (
                          <input
                            className="flex-1 text-sm font-medium bg-daintree-bg border border-daintree-accent rounded px-2 py-0.5 focus:outline-none"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={handleCommitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleCommitEdit();
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                handleCancelEdit();
                              }
                            }}
                            autoFocus
                            data-testid="preset-edit-input"
                            placeholder="Preset name..."
                          />
                        ) : (
                          <button
                            className="flex items-center gap-1.5 text-sm font-medium text-daintree-text hover:text-daintree-accent transition-colors text-left"
                            onClick={() => handleStartEdit(selectedPreset)}
                            aria-label={`Edit ${selectedPreset.name}`}
                            title="Click to rename"
                          >
                            <span>{selectedPreset.name}</span>
                            <Pencil size={12} className="text-daintree-text/30" />
                          </button>
                        )}

                        {/* Duplicate / Delete inline */}
                        <div className="flex items-center gap-1.5 ml-auto shrink-0">
                          <button
                            className="text-daintree-text/30 hover:text-daintree-text transition-colors"
                            onClick={() => handleDuplicatePreset(selectedPreset)}
                            aria-label={`Duplicate ${selectedPreset.name}`}
                            title="Duplicate"
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            className="text-daintree-text/30 hover:text-status-error transition-colors"
                            onClick={() => handleDeletePreset(selectedPreset.id)}
                            aria-label={`Delete ${selectedPreset.name}`}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                          <span
                            data-testid="preset-badge-custom"
                            className="text-[10px] text-daintree-accent bg-daintree-accent/10 px-1.5 py-0.5 rounded"
                          >
                            custom
                          </span>
                        </div>
                      </div>

                      {/* Env var editor — draft-row state with empty/duplicate key validation */}
                      <div className="px-3 py-2.5 space-y-1.5">
                        <span className="text-[11px] text-daintree-text/50 font-medium uppercase tracking-wide block">
                          Env overrides
                        </span>
                        <EnvVarEditor
                          env={selectedPreset.env ?? {}}
                          onChange={(env) => handleUpdatePreset(selectedPreset.id, { env })}
                          suggestions={getAgentConfig(activeAgent.id)?.envSuggestions ?? []}
                          datalistId="env-key-suggestions"
                          contextKey={selectedPreset.id}
                          inheritedEnv={activeEntry.globalEnv as Record<string, string> | undefined}
                          data-testid="preset-env-editor"
                        />
                        {envVarReference}
                      </div>

                      {/* Behavioral settings */}
                      <div className="px-3 py-2.5">{behavioralSettings}</div>

                      {/* Fallback chain editor */}
                      <div className="px-3 py-2.5 space-y-1.5">
                        <div>
                          <label className="text-sm font-medium text-daintree-text">
                            Fallback presets
                          </label>
                          <p className="text-xs text-daintree-text/40 select-text">
                            Tried in order if this preset's provider is unreachable. No retry for
                            rate limits or prompt errors.
                          </p>
                        </div>
                        {(() => {
                          const chain = selectedPreset.fallbacks ?? [];
                          const candidates = allPresets.filter(
                            (p) => p.id !== selectedPreset.id && !chain.includes(p.id)
                          );
                          const removeFallback = (id: string) => {
                            handleUpdatePreset(selectedPreset.id, {
                              fallbacks: chain.filter((f) => f !== id),
                            });
                          };
                          const addFallback = (id: string) => {
                            if (!id || chain.includes(id) || chain.length >= FALLBACK_CHAIN_MAX)
                              return;
                            handleUpdatePreset(selectedPreset.id, {
                              fallbacks: [...chain, id],
                            });
                          };
                          return (
                            <>
                              {chain.length > 0 && (
                                <ul className="space-y-1">
                                  {chain.map((id, idx) => {
                                    const preset = allPresets.find((p) => p.id === id);
                                    const name = preset?.name ?? id;
                                    const missing = !preset;
                                    return (
                                      <li
                                        key={id}
                                        className="flex items-center gap-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 px-2 py-1.5"
                                      >
                                        <span className="text-[10px] text-daintree-text/40 font-mono shrink-0">
                                          {idx + 1}.
                                        </span>
                                        <span
                                          className={
                                            missing
                                              ? "text-xs text-status-error truncate"
                                              : "text-xs text-daintree-text truncate"
                                          }
                                        >
                                          {name}
                                          {missing && " (missing)"}
                                        </span>
                                        <button
                                          className="ml-auto text-daintree-text/30 hover:text-status-error transition-colors shrink-0"
                                          onClick={() => removeFallback(id)}
                                          aria-label={`Remove ${name} from fallback chain`}
                                          title="Remove"
                                        >
                                          <XIcon size={13} />
                                        </button>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                              {chain.length < FALLBACK_CHAIN_MAX && candidates.length > 0 && (
                                <select
                                  className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm"
                                  value=""
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (v) addFallback(v);
                                  }}
                                  aria-label="Add fallback preset"
                                >
                                  <option value="">Add fallback preset…</option>
                                  {candidates.map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {chain.length >= FALLBACK_CHAIN_MAX && (
                                <p className="text-[11px] text-daintree-text/40">
                                  Maximum of {FALLBACK_CHAIN_MAX} fallbacks reached.
                                </p>
                              )}
                              {chain.length < FALLBACK_CHAIN_MAX && candidates.length === 0 && (
                                <p className="text-[11px] text-daintree-text/40">
                                  No other presets available for this agent.
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Share Clipboard Directory — Gemini only, always agent-level */}
            {activeAgent.id === "gemini" && (
              <div id="agents-clipboard">
                <SettingsSwitchCard
                  variant="compact"
                  title="Share Clipboard Directory"
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
              </div>
            )}

            {/* Assistant Model — agent-level */}
            {(() => {
              const agentCfg = getAgentConfig(activeAgent.id);
              if (!agentCfg?.models || agentCfg.models.length <= 1) return null;
              return (
                <div id="agents-assistant-model">
                  <SettingsSelect
                    label="Assistant Model"
                    description="Model used when this agent is launched from the help panel or assistant shortcut"
                    value={(activeEntry.assistantModelId as string) || "__default__"}
                    onValueChange={(v) => {
                      void (async () => {
                        await updateAgent(activeAgent.id, {
                          assistantModelId: v === "__default__" ? undefined : v,
                        });
                        onSettingsChange?.();
                      })();
                    }}
                    isModified={!!activeEntry.assistantModelId}
                    onReset={() => {
                      void (async () => {
                        await updateAgent(activeAgent.id, { assistantModelId: undefined });
                        onSettingsChange?.();
                      })();
                    }}
                    resetAriaLabel={`Reset ${activeAgent.name} assistant model to default`}
                    options={[
                      { value: "__default__", label: "Default (fast model)" },
                      ...agentCfg.models.map((m) => ({ value: m.id, label: m.name })),
                    ]}
                  />
                </div>
              );
            })()}

            {/* Help Output */}
            <AgentHelpOutput
              agentId={activeAgent.id}
              agentName={activeAgent.name}
              usageUrl={activeAgent.usageUrl}
            />

            {/* Installation */}
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
          </AgentCard>
        )}
      </div>

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
