import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getAgentIds, getAgentConfig, getMergedFlavors, type AgentFlavor } from "@/config/agents";
import { useAgentSettingsStore, useCliAvailabilityStore, useAgentPreferencesStore } from "@/store";
import { cliAvailabilityClient } from "@/clients";
import { useCcrFlavorsStore } from "@/store/ccrFlavorsStore";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
  type AgentCliDetails,
} from "@shared/types";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { RotateCcw, ExternalLink, Plus, Copy, Trash2, Pencil } from "lucide-react";
import { DaintreeAgentIcon } from "@/components/icons";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
import { FlavorSelector } from "./FlavorSelector";
import { FlavorColorPicker } from "./FlavorColorPicker";
import { EnvVarEditor } from "./EnvVarEditor";
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

  const ccrFlavorsByAgent = useCcrFlavorsStore((s) => s.ccrFlavorsByAgent);

  // Rate limiting refs
  const lastAddTimeRef = useRef(0);
  const lastEditTimeRef = useRef(0);

  // Flavor editing state
  const [editingFlavorId, setEditingFlavorId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Reset flavor-editing state when switching between agent subtabs. Without
  // this, an in-progress rename on one agent's flavor would leak into a
  // different agent's panel after a tab switch (and can silently commit the
  // rename to the wrong agent on blur).
  useEffect(() => {
    setEditingFlavorId(null);
    setEditName("");
  }, [activeSubtab]);

  const agentIds = useMemo(() => getAgentIds(), []);
  const effectiveSettings = settings ?? DEFAULT_AGENT_SETTINGS;

  const isGeneralActive =
    activeSubtab === GENERAL_SUBTAB_ID || activeSubtab === null || !agentIds.includes(activeSubtab);
  const activeAgentId = isGeneralActive ? null : activeSubtab;

  // Stale-flavor cleanup in Settings: when a saved flavorId no longer resolves
  // (deleted custom flavor, CCR route removed from config), clear it so the
  // Settings UI and the stored settings agree. useAgentLauncher.ts does this
  // cleanup on the next launch, but the UI otherwise shows vanilla with a
  // zombie flavorId in storage until the user launches the agent again.
  useEffect(() => {
    if (!activeAgentId) return;
    const entry = settings?.agents?.[activeAgentId];
    if (!entry?.flavorId) return;
    const ccr = ccrFlavorsByAgent[activeAgentId];
    const merged = getMergedFlavors(activeAgentId, entry.customFlavors, ccr);
    const stillExists = merged.some((f) => f.id === entry.flavorId);
    if (!stillExists) {
      void (async () => {
        await updateAgent(activeAgentId, { flavorId: undefined });
        onSettingsChange?.();
      })();
    }
    // We intentionally omit updateAgent/onSettingsChange from deps — they're
    // stable Zustand actions / prop callbacks and including them causes loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, settings, ccrFlavorsByAgent]);

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

            {/* Flavor section — picker + all per-flavor settings inside */}
            {(() => {
              const ccrFlavors = ccrFlavorsByAgent[activeAgent.id];
              const customFlavors = activeEntry.customFlavors;
              const allFlavors = getMergedFlavors(activeAgent.id, customFlavors, ccrFlavors);
              const agentCfg = getAgentConfig(activeAgent.id);
              const supportsInlineMode = !!agentCfg?.capabilities?.inlineModeFlag;

              const selectedFlavor = allFlavors.find((f) => f.id === activeEntry.flavorId);
              const selectedIsCcr = selectedFlavor?.id.startsWith("ccr-") ?? false;
              const selectedIsCustom = selectedFlavor?.id.startsWith("user-") ?? false;
              const isVanilla = !selectedFlavor;

              // ── handlers ──────────────────────────────────────────────────

              const handleAddFlavor = () => {
                const now = Date.now();
                // Rate limiting: max 5 adds per minute (12s between adds)
                if (now - lastAddTimeRef.current < 12000) {
                  console.warn("Rate limit exceeded for flavor creation");
                  return;
                }
                lastAddTimeRef.current = now;

                const id = `user-${now}`;
                const updated = [
                  ...(activeEntry.customFlavors ?? []),
                  {
                    id,
                    name: "New Flavor",
                    env: Object.fromEntries(
                      (getAgentConfig(activeAgent.id)?.envSuggestions ?? [])
                        .filter((s) => s.defaultValue !== undefined)
                        .map((s) => [s.key, s.defaultValue!])
                    ),
                  },
                ];
                void (async () => {
                  await updateAgent(activeAgent.id, { customFlavors: updated, flavorId: id });
                  onSettingsChange?.();
                })();
              };

              if (allFlavors.length === 0 && !customFlavors?.length) {
                return (
                  <div
                    id="agents-flavors"
                    className="space-y-3 pt-2 border-t border-daintree-border"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm font-medium text-daintree-text">Flavors</label>
                        <p className="text-xs text-daintree-text/40 select-text">
                          Variants with different env overrides and model routes
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-daintree-accent hover:text-daintree-accent/80"
                        onClick={handleAddFlavor}
                      >
                        <Plus size={14} />
                        Add
                      </Button>
                    </div>
                  </div>
                );
              }

              const handleDuplicateFlavor = (flavor: AgentFlavor) => {
                const id = `user-${Date.now()}`;
                const updated = [
                  ...(activeEntry.customFlavors ?? []),
                  { ...flavor, id, name: `${flavor.name} (copy)` },
                ];
                void (async () => {
                  await updateAgent(activeAgent.id, { customFlavors: updated });
                  onSettingsChange?.();
                })();
              };

              const handleDeleteFlavor = (flavorId: string) => {
                const updated = (activeEntry.customFlavors ?? []).filter((f) => f.id !== flavorId);
                void (async () => {
                  if (activeEntry.flavorId === flavorId) {
                    await updateAgent(activeAgent.id, {
                      customFlavors: updated,
                      flavorId: undefined,
                    });
                  } else {
                    await updateAgent(activeAgent.id, { customFlavors: updated });
                  }
                  onSettingsChange?.();
                })();
              };

              const handleUpdateFlavor = (flavorId: string, patch: Partial<AgentFlavor>) => {
                const updated = (activeEntry.customFlavors ?? []).map((f) =>
                  f.id === flavorId ? { ...f, ...patch } : f
                );
                void (async () => {
                  try {
                    await updateAgent(activeAgent.id, { customFlavors: updated });
                    onSettingsChange?.();
                  } catch (error) {
                    console.error("Failed to update flavor:", error);
                  }
                })();
              };

              const handleStartEdit = (flavor: AgentFlavor) => {
                if (!flavor.name || flavor.name.length > 200) {
                  console.warn("Invalid flavor name length");
                  return;
                }
                if (/[<>'"&]/.test(flavor.name)) {
                  console.warn("Flavor name contains dangerous characters");
                  return;
                }
                setEditingFlavorId(flavor.id);
                setEditName(flavor.name);
              };

              const handleCommitEdit = () => {
                const trimmed = editName.trim();
                if (
                  editingFlavorId &&
                  trimmed &&
                  trimmed.length <= 200 &&
                  !/[<>'"&]/.test(trimmed)
                ) {
                  const now = Date.now();
                  if (now - lastEditTimeRef.current < 100) return;
                  lastEditTimeRef.current = now;
                  handleUpdateFlavor(editingFlavorId, { name: trimmed });
                }
                setEditingFlavorId(null);
                setEditName("");
              };

              const handleCancelEdit = () => {
                setEditingFlavorId(null);
                setEditName("");
              };

              // ── reusable behavioral settings block ───────────────────────
              // For vanilla/CCR: reads from activeEntry and writes to agent.
              // For custom: reads from the flavor and writes via handleUpdateFlavor.

              const skipPerms = selectedIsCustom
                ? (selectedFlavor!.dangerousEnabled ?? false)
                : (activeEntry.dangerousEnabled ?? false);

              const inlineMode = selectedIsCustom
                ? (selectedFlavor!.inlineMode ?? activeEntry.inlineMode ?? true)
                : (activeEntry.inlineMode ?? true);

              const customFlags = selectedIsCustom
                ? (selectedFlavor!.customFlags ?? "")
                : (activeEntry.customFlags ?? "");

              const onSkipPermsToggle = () => {
                if (selectedIsCustom) {
                  handleUpdateFlavor(selectedFlavor!.id, { dangerousEnabled: !skipPerms });
                } else {
                  void (async () => {
                    await updateAgent(activeAgent.id, { dangerousEnabled: !skipPerms });
                    onSettingsChange?.();
                  })();
                }
              };

              const onInlineModeToggle = () => {
                if (selectedIsCustom) {
                  handleUpdateFlavor(selectedFlavor!.id, { inlineMode: !inlineMode });
                } else {
                  void (async () => {
                    await updateAgent(activeAgent.id, { inlineMode: !inlineMode });
                    onSettingsChange?.();
                  })();
                }
              };

              const onCustomFlagsChange = (value: string) => {
                if (selectedIsCustom) {
                  const updated = (activeEntry.customFlavors ?? []).map((f) =>
                    f.id === selectedFlavor!.id ? { ...f, customFlags: value } : f
                  );
                  void updateAgent(activeAgent.id, { customFlavors: updated });
                } else {
                  void updateAgent(activeAgent.id, { customFlags: value });
                }
              };

              const behavioralSettings = (
                <div className="space-y-3">
                  <div id="agents-skip-permissions" className="space-y-1.5">
                    <SettingsSwitchCard
                      variant="compact"
                      title="Skip Permissions"
                      subtitle="Auto-approve all file, command, and network actions"
                      isEnabled={skipPerms}
                      onChange={onSkipPermsToggle}
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
                    <div id="agents-inline-mode">
                      <SettingsSwitchCard
                        variant="compact"
                        title="Inline Mode"
                        subtitle="Disable fullscreen TUI for better resize handling and scrollback"
                        isEnabled={inlineMode}
                        onChange={onInlineModeToggle}
                        ariaLabel={`Inline mode for ${activeAgent.name}`}
                      />
                    </div>
                  )}

                  <div id="agents-custom-args" className="space-y-1.5">
                    <label className="text-sm font-medium text-daintree-text">
                      Custom Arguments
                    </label>
                    <input
                      className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-muted"
                      value={customFlags}
                      onChange={(e) => onCustomFlagsChange(e.target.value)}
                      placeholder="--verbose --max-tokens=4096"
                    />
                    <p className="text-xs text-daintree-text/40 select-text">
                      Extra CLI flags appended when launching
                    </p>
                  </div>
                </div>
              );

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
                <div id="agents-flavors" className="space-y-3 pt-2 border-t border-daintree-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium text-daintree-text">Flavors</label>
                      <p className="text-xs text-daintree-text/40 select-text">
                        Variants with different env overrides and model routes
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-daintree-accent hover:text-daintree-accent/80"
                      onClick={handleAddFlavor}
                    >
                      <Plus size={14} />
                      Add
                    </Button>
                  </div>

                  {/* Unified flavor picker — Popover listbox with color swatches and grouping */}
                  <FlavorSelector
                    selectedFlavorId={activeEntry.flavorId ?? undefined}
                    allFlavors={allFlavors}
                    ccrFlavors={ccrFlavors ?? []}
                    customFlavors={customFlavors ?? []}
                    onChange={(flavorId) => {
                      void (async () => {
                        await updateAgent(activeAgent.id, { flavorId: flavorId ?? undefined });
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

                  {/* Detail view for selected CCR flavor */}
                  {selectedFlavor && selectedIsCcr && (
                    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50">
                      <div className="px-3 py-2.5 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-daintree-text">
                            {selectedFlavor.name.replace(/^CCR:\s*/, "")}
                          </span>
                          <span
                            data-testid="flavor-badge-auto"
                            className="text-[10px] text-daintree-text/40 bg-daintree-text/10 px-1.5 py-0.5 rounded"
                          >
                            auto
                          </span>
                          <button
                            className="ml-auto text-daintree-text/30 hover:text-daintree-text transition-colors"
                            onClick={() => handleDuplicateFlavor(selectedFlavor)}
                            aria-label={`Duplicate ${selectedFlavor.name.replace(/^CCR:\s*/, "")}`}
                            title="Duplicate as custom"
                          >
                            <Copy size={13} />
                          </button>
                        </div>
                        {selectedFlavor.env && Object.keys(selectedFlavor.env).length > 0 && (
                          <div className="space-y-1">
                            {Object.entries(selectedFlavor.env).map(([k, v]) => (
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
                        {selectedFlavor.description && (
                          <p className="text-[11px] text-daintree-text/40 select-text">
                            {selectedFlavor.description}
                          </p>
                        )}
                      </div>
                      <div className="px-3 py-2.5">{behavioralSettings}</div>
                    </div>
                  )}

                  {/* Detail view for selected custom flavor */}
                  {selectedFlavor && selectedIsCustom && (
                    <div
                      id="agents-flavor-detail"
                      className="rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 divide-y divide-daintree-border/50"
                    >
                      {/* Name row */}
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        {/* Color picker — preset palette with Clear + Custom escape hatch */}
                        <FlavorColorPicker
                          color={selectedFlavor.color}
                          agentColor={getAgentConfig(activeAgent.id)?.color ?? "#888888"}
                          onChange={(color) => handleUpdateFlavor(selectedFlavor.id, { color })}
                          ariaLabel="Flavor color"
                        />

                        {editingFlavorId === selectedFlavor.id ? (
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
                            data-testid="flavor-edit-input"
                            placeholder="Flavor name..."
                          />
                        ) : (
                          <button
                            className="flex items-center gap-1.5 text-sm font-medium text-daintree-text hover:text-daintree-accent transition-colors text-left"
                            onClick={() => handleStartEdit(selectedFlavor)}
                            aria-label={`Edit ${selectedFlavor.name}`}
                            title="Click to rename"
                          >
                            <span>{selectedFlavor.name}</span>
                            <Pencil size={12} className="text-daintree-text/30" />
                          </button>
                        )}

                        {/* Duplicate / Delete inline */}
                        <div className="flex items-center gap-1.5 ml-auto shrink-0">
                          <button
                            className="text-daintree-text/30 hover:text-daintree-text transition-colors"
                            onClick={() => handleDuplicateFlavor(selectedFlavor)}
                            aria-label={`Duplicate ${selectedFlavor.name}`}
                            title="Duplicate"
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            className="text-daintree-text/30 hover:text-status-error transition-colors"
                            onClick={() => handleDeleteFlavor(selectedFlavor.id)}
                            aria-label={`Delete ${selectedFlavor.name}`}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                          <span
                            data-testid="flavor-badge-custom"
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
                          env={selectedFlavor.env ?? {}}
                          onChange={(env) => handleUpdateFlavor(selectedFlavor.id, { env })}
                          suggestions={getAgentConfig(activeAgent.id)?.envSuggestions ?? []}
                          datalistId="env-key-suggestions"
                          contextKey={selectedFlavor.id}
                          data-testid="flavor-env-editor"
                        />
                        {envVarReference}
                      </div>

                      {/* Behavioral settings */}
                      <div className="px-3 py-2.5">{behavioralSettings}</div>
                    </div>
                  )}

                  {/* Vanilla settings */}
                  {isVanilla && (
                    <div
                      className={
                        allFlavors.length > 0
                          ? "rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30 px-3 py-2.5"
                          : ""
                      }
                    >
                      {behavioralSettings}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Global env vars — agent-level, applied to every launch regardless of flavor */}
            <div id="agents-global-env" className="space-y-2 pt-2 border-t border-daintree-border">
              <div>
                <label className="text-sm font-medium text-daintree-text">Global env vars</label>
                <p className="text-xs text-daintree-text/40 select-text">
                  Applied to every launch of this agent. Flavor-specific vars take precedence.
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
                    value={(activeEntry.assistantModelId as string) ?? ""}
                    onChange={(e) => {
                      void (async () => {
                        await updateAgent(activeAgent.id, {
                          assistantModelId: e.target.value || undefined,
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
                  >
                    <option value="">Default (fast model)</option>
                    {agentCfg.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </SettingsSelect>
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
    </div>
  );
}
