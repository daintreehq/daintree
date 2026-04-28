import { useEffect, useEffectEvent, useMemo, useRef, useState, useCallback } from "react";
import { getAgentIds, getAgentConfig, getMergedPresets, type AgentPreset } from "@/config/agents";
import { useAgentSettingsStore, useCliAvailabilityStore, useAgentPreferencesStore } from "@/store";
import { cliAvailabilityClient } from "@/clients";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
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
import { Plug } from "@/components/icons";
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
      logError("[AgentSettings] Failed to fetch CLI details", error);
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
      logError("[AgentSettings] Failed to refresh CLI availability", error);
      notify({
        type: "error",
        title: "CLI refresh failed",
        message: "Couldn't refresh agent availability. Try again.",
        priority: "low",
      });
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
      notify({
        type: "error",
        title: "Preset creation failed",
        message: "Couldn't save the new preset. Try again.",
        priority: "low",
      });
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
            className="text-xs px-3 py-1.5 border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
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
          className="text-xs px-3 py-1.5 border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft rounded transition-colors"
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
            <Plug className="w-3.5 h-3.5" />
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
                        logError("Failed to open usage URL", error);
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

            {/* Unified scope editor — one set of controls for Default or a
                preset. The scope selector lives at the top; the editor body
                is keyed on the scope id so rename/edit state resets naturally
                when the user switches scopes (avoids a parallel reset effect
                — see issue #4958). CCR and project presets render read-only
                with a Duplicate affordance; the shared `globalEnv` and agent
                defaults apply when scope is "default". */}
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

              type ScopeKind = "default" | "custom" | "project" | "ccr";
              const scopeKind: ScopeKind = !selectedPreset
                ? "default"
                : selectedIsCustom
                  ? "custom"
                  : selectedIsProject
                    ? "project"
                    : selectedIsCcr
                      ? "ccr"
                      : "default";
              const stripCcr = (n: string) => n.replace(/^CCR:\s*/, "");
              const scopeLabel =
                scopeKind === "default"
                  ? "Default"
                  : scopeKind === "ccr" && selectedPreset
                    ? stripCcr(selectedPreset.name)
                    : (selectedPreset?.name ?? "Default");

              // ── handlers ──────────────────────────────────────────────────

              const openAddDialog = () => {
                setAddDialogAgentId(activeAgent.id);
                setIsAddDialogOpen(true);
              };

              const handleDuplicatePreset = (preset: AgentPreset) => {
                const id = `user-${crypto.randomUUID()}`;
                const updated = [
                  ...(activeEntry.customPresets ?? []),
                  { ...preset, id, name: `${preset.name} (copy)` },
                ];
                // Select the new copy so the user lands in the editor for the
                // duplicated preset — parallels handleCreatePreset's auto-select.
                void (async () => {
                  await updateAgent(activeAgent.id, { customPresets: updated, presetId: id });
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
                    logError("Failed to update preset", error);
                    notify({
                      type: "error",
                      title: "Preset update failed",
                      message: "Couldn't save the preset changes. Try again.",
                      priority: "low",
                    });
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

              // ── scope-aware values ────────────────────────────────────────
              const agentDefaultDangerous = activeEntry.dangerousEnabled ?? false;
              const agentDefaultInline = activeEntry.inlineMode ?? true;
              const agentDefaultCustomFlags = activeEntry.customFlags ?? "";

              const dangerousOverride = selectedPreset?.dangerousEnabled;
              const inlineOverride = selectedPreset?.inlineMode;
              const customFlagsOverride = selectedPreset?.customFlags;

              // Dangerous-arg strip reflects what actually gets passed to the
              // CLI at launch — agent default in Default scope, preset merge
              // result in custom scope.
              const effectiveSkipPerms =
                scopeKind === "custom"
                  ? (dangerousOverride ?? agentDefaultDangerous)
                  : agentDefaultDangerous;

              const effectiveInlineMode =
                scopeKind === "custom"
                  ? (inlineOverride ?? agentDefaultInline)
                  : agentDefaultInline;

              const handleSkipPermsChange = () => {
                if (scopeKind === "default") {
                  void (async () => {
                    await updateAgent(activeAgent.id, {
                      dangerousEnabled: !agentDefaultDangerous,
                    });
                    onSettingsChange?.();
                  })();
                } else if (scopeKind === "custom" && selectedPreset) {
                  handleUpdatePreset(selectedPreset.id, { dangerousEnabled: !effectiveSkipPerms });
                }
              };

              const handleInlineModeChange = () => {
                if (scopeKind === "default") {
                  void (async () => {
                    await updateAgent(activeAgent.id, { inlineMode: !agentDefaultInline });
                    onSettingsChange?.();
                  })();
                } else if (scopeKind === "custom" && selectedPreset) {
                  handleUpdatePreset(selectedPreset.id, { inlineMode: !effectiveInlineMode });
                }
              };

              const handleCustomFlagsChange = (value: string) => {
                if (scopeKind === "default") {
                  void updateAgent(activeAgent.id, { customFlags: value });
                } else if (scopeKind === "custom" && selectedPreset) {
                  handleUpdatePreset(selectedPreset.id, { customFlags: value });
                }
              };

              const handleDangerousOverrideReset = () => {
                if (scopeKind === "custom" && selectedPreset) {
                  handleUpdatePreset(selectedPreset.id, { dangerousEnabled: undefined });
                }
              };

              const handleInlineOverrideReset = () => {
                if (scopeKind === "custom" && selectedPreset) {
                  handleUpdatePreset(selectedPreset.id, { inlineMode: undefined });
                }
              };

              const handleCustomFlagsOverrideReset = () => {
                if (scopeKind === "custom" && selectedPreset) {
                  handleUpdatePreset(selectedPreset.id, { customFlags: undefined });
                }
              };

              // Env var suggestions for the always-visible reference strip
              // shown under the custom preset's env editor.
              const agentEnvSuggestions = getAgentConfig(activeAgent.id)?.envSuggestions ?? [];
              const envVarReference = (
                <div className="space-y-0.5 pt-1">
                  <p className="text-[11px] text-daintree-text/40 pb-0.5">
                    Available env overrides:
                  </p>
                  {agentEnvSuggestions.map(({ key, hint }) => (
                    <div key={key} className="flex items-baseline gap-2 font-mono">
                      <span className="text-[11px] text-daintree-text/60 shrink-0">{key}</span>
                      <span className="text-[10px] text-daintree-text/30">{hint}</span>
                    </div>
                  ))}
                </div>
              );

              const isEditableScope = scopeKind === "default" || scopeKind === "custom";
              const customArgsValue =
                scopeKind === "custom" ? (customFlagsOverride ?? "") : agentDefaultCustomFlags;
              const customArgsPlaceholder =
                scopeKind === "custom" && customFlagsOverride === undefined
                  ? agentDefaultCustomFlags || "Using default (no flags)"
                  : "--verbose --max-tokens=4096";
              const customArgsDescription =
                scopeKind === "custom"
                  ? customFlagsOverride === undefined
                    ? "Using default. Type to override."
                    : "Extra CLI flags for this preset"
                  : "Extra CLI flags appended when launching";

              return (
                <div
                  id="agents-presets"
                  className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4"
                >
                  {/* Header: title + Add button */}
                  <div
                    className={`pb-3${allPresets.length > 0 ? " border-b border-daintree-border" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm font-medium text-daintree-text">
                          Runtime Settings
                        </label>
                        <p className="text-xs text-daintree-text/40 select-text">
                          Pick a scope — Default applies everywhere; presets override it.
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
                        Add Preset
                      </Button>
                    </div>
                  </div>

                  {/* Scope picker — always shown so Default and presets live on the same selector */}
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
                    agentColor={getAgentConfig(activeAgent.id)?.color ?? "var(--theme-text-muted)"}
                  />

                  {/* Scope banner — mitigates context-hijack confusion when
                      a new preset is auto-selected on create */}
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-daintree-text/50">Editing:</span>
                    <span
                      className="text-daintree-text font-medium"
                      data-testid="scope-banner-label"
                    >
                      {scopeLabel}
                    </span>
                    {scopeKind === "ccr" && (
                      <span
                        data-testid="preset-badge-auto"
                        className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
                      >
                        auto
                      </span>
                    )}
                    {scopeKind === "project" && (
                      <span
                        data-testid="preset-badge-project"
                        className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
                      >
                        project
                      </span>
                    )}
                    {scopeKind === "custom" && (
                      <span
                        data-testid="preset-badge-custom"
                        className="text-[10px] text-daintree-accent bg-daintree-accent/10 px-1.5 py-0.5 rounded"
                      >
                        custom
                      </span>
                    )}
                  </div>

                  {/* Editor body — keyed on the scope so React unmounts/remounts
                      the rename input and form state naturally on scope change.
                      Outer card (scope picker + header) stays mounted. */}
                  <div
                    key={activeEntry.presetId ?? "default"}
                    className="space-y-3"
                    data-testid="scope-editor-body"
                  >
                    {/* Custom preset scope chrome: rename / duplicate / delete */}
                    {scopeKind === "custom" && selectedPreset && (
                      <div
                        id="agents-preset-detail"
                        className="flex items-center gap-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 px-3 py-2.5"
                      >
                        {/* Color picker — preset palette with Clear + Custom escape hatch */}
                        <PresetColorPicker
                          color={selectedPreset.color}
                          agentColor={
                            getAgentConfig(activeAgent.id)?.color ?? "var(--theme-text-muted)"
                          }
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
                        </div>
                      </div>
                    )}

                    {/* Behavioral settings (Default / Custom scopes — editable) */}
                    {isEditableScope && (
                      <>
                        <div id="agents-skip-permissions" className="space-y-1.5">
                          <SettingsSwitchCard
                            variant="compact"
                            title="Skip Permissions"
                            subtitle={
                              scopeKind === "custom" && dangerousOverride === undefined
                                ? `Using default (${agentDefaultDangerous ? "On" : "Off"})`
                                : "Auto-approve all file, command, and network actions"
                            }
                            isEnabled={effectiveSkipPerms}
                            onChange={handleSkipPermsChange}
                            ariaLabel={`Skip permissions for ${scopeLabel}`}
                            colorScheme="danger"
                            isModified={scopeKind === "custom" && dangerousOverride !== undefined}
                            onReset={
                              scopeKind === "custom" ? handleDangerousOverrideReset : undefined
                            }
                            resetAriaLabel={
                              scopeKind === "custom"
                                ? `Reset skip permissions override for ${scopeLabel}`
                                : undefined
                            }
                          />
                          {effectiveSkipPerms && defaultDangerousArg && (
                            <div className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                              <code className="text-xs text-status-error font-mono">
                                {defaultDangerousArg}
                              </code>
                              <span className="text-xs text-daintree-text/40">
                                added to command
                              </span>
                            </div>
                          )}
                        </div>

                        {supportsInlineMode && (
                          <div id="agents-inline-mode">
                            <SettingsSwitchCard
                              variant="compact"
                              title="Inline Mode"
                              subtitle={
                                scopeKind === "custom" && inlineOverride === undefined
                                  ? `Using default (${agentDefaultInline ? "On" : "Off"})`
                                  : "Disable fullscreen TUI for better resize handling and scrollback"
                              }
                              isEnabled={effectiveInlineMode}
                              onChange={handleInlineModeChange}
                              ariaLabel={`Inline mode for ${scopeLabel}`}
                              isModified={scopeKind === "custom" && inlineOverride !== undefined}
                              onReset={
                                scopeKind === "custom" ? handleInlineOverrideReset : undefined
                              }
                              resetAriaLabel={
                                scopeKind === "custom"
                                  ? `Reset inline mode override for ${scopeLabel}`
                                  : undefined
                              }
                            />
                          </div>
                        )}

                        <div id="agents-custom-args" className="group/args space-y-1.5">
                          <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-daintree-text">
                              Custom Arguments
                            </label>
                            {scopeKind === "custom" && customFlagsOverride !== undefined && (
                              <>
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-daintree-accent"
                                  aria-hidden="true"
                                />
                                <button
                                  type="button"
                                  aria-label={`Reset custom arguments override for ${scopeLabel}`}
                                  className="p-0.5 rounded-sm text-daintree-text/40 hover:text-daintree-accent invisible group-hover/args:visible group-focus-within/args:visible focus-visible:visible focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent transition-colors"
                                  onClick={handleCustomFlagsOverrideReset}
                                  data-testid="preset-custom-flags-reset"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                </button>
                              </>
                            )}
                          </div>
                          <input
                            className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-muted"
                            value={customArgsValue}
                            onChange={(e) => handleCustomFlagsChange(e.target.value)}
                            placeholder={customArgsPlaceholder}
                            data-testid={
                              scopeKind === "custom" ? "preset-custom-flags-input" : undefined
                            }
                          />
                          <p className="text-xs text-daintree-text/40 select-text">
                            {customArgsDescription}
                          </p>
                        </div>
                      </>
                    )}

                    {/* Env editor — Default scope writes globalEnv; custom
                        scope writes preset.env with inheritance surfaced. */}
                    {scopeKind === "default" && (
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
                                globalEnv:
                                  Object.keys(globalEnv).length > 0 ? globalEnv : undefined,
                              });
                              onSettingsChange?.();
                            })();
                          }}
                          suggestions={getAgentConfig(activeAgent.id)?.envSuggestions ?? []}
                          datalistId="env-key-suggestions-global"
                          contextKey={`global-${activeAgent.id}`}
                          data-testid="global-env-editor"
                        />
                      </div>
                    )}

                    {scopeKind === "custom" && selectedPreset && (
                      <>
                        <div className="space-y-1.5">
                          <span className="text-[11px] text-daintree-text/50 font-medium uppercase tracking-wide block">
                            Env overrides
                          </span>
                          <EnvVarEditor
                            env={selectedPreset.env ?? {}}
                            onChange={(env) => handleUpdatePreset(selectedPreset.id, { env })}
                            suggestions={getAgentConfig(activeAgent.id)?.envSuggestions ?? []}
                            datalistId="env-key-suggestions"
                            contextKey={selectedPreset.id}
                            inheritedEnv={
                              activeEntry.globalEnv as Record<string, string> | undefined
                            }
                            data-testid="preset-env-editor"
                          />
                          {envVarReference}
                        </div>

                        {/* Fallback chain editor */}
                        <div className="space-y-1.5">
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
                      </>
                    )}

                    {/* Read-only detail views for CCR and project presets */}
                    {(scopeKind === "ccr" || scopeKind === "project") && selectedPreset && (
                      <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50">
                        <div className="px-3 py-2.5 space-y-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-daintree-text">
                              {scopeKind === "ccr"
                                ? stripCcr(selectedPreset.name)
                                : selectedPreset.name}
                            </span>
                            <button
                              className="ml-auto text-daintree-text/30 hover:text-daintree-text transition-colors"
                              onClick={() => handleDuplicatePreset(selectedPreset)}
                              aria-label={`Duplicate ${scopeKind === "ccr" ? stripCcr(selectedPreset.name) : selectedPreset.name}`}
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
                          {scopeKind === "project" && (
                            <p className="text-[10px] text-daintree-text/40 select-text">
                              Sourced from <code>.daintree/presets/</code> in this project.
                            </p>
                          )}
                        </div>
                        <div className="px-3 py-2">
                          <p className="text-xs text-daintree-text/40 select-text">
                            Read-only. Duplicate as custom to override behavioral settings or env.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
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
