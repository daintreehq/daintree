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
import { Card } from "@/components/ui/card";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
  type AgentCliDetails,
} from "@shared/types";
import { isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import { RotateCcw, ExternalLink } from "lucide-react";
import { Plug } from "@/components/icons";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { AddPresetDialog } from "./AddPresetDialog";
import { AgentScopeEditor } from "./AgentScopeEditor";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { actionService } from "@/services/ActionService";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { AgentCard, AgentInstallSection } from "@/components/agents/AgentCard";
import { AgentShortcutCapture } from "@/components/KeyboardShortcuts";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { DefaultAgentId } from "@/store/agentPreferencesStore";

const GENERAL_SUBTAB_ID = "general";

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
    <Card
      padding="sm"
      id={`agents-shortcut-${agentId}`}
      data-testid={`agent-shortcut-row-${agentId}`}
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">Keyboard shortcut</div>
          <div className="text-xs text-daintree-text/50 mt-0.5 select-text">
            Launch {agentName} from anywhere with a key combination
          </div>
        </div>
        {!isEditing && (
          <div className="flex items-center gap-2 shrink-0">
            {displayCombo ? (
              <span
                data-testid={`agent-shortcut-pill-${agentId}`}
                className="px-2 py-0.5 text-xs font-mono rounded bg-border-default text-text-primary"
              >
                {displayCombo}
              </span>
            ) : (
              <span className="text-xs text-daintree-text/60 italic">Unbound</span>
            )}
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              data-testid={`agent-shortcut-edit-${agentId}`}
              className="px-2 py-0.5 text-xs text-daintree-text/60 hover:text-text-primary transition-colors"
            >
              {displayCombo ? "Change" : "Assign"}
            </button>
            {isOverridden && (
              <button
                type="button"
                onClick={() => void handleReset()}
                aria-label={`Reset ${agentName} shortcut to default`}
                data-testid={`agent-shortcut-reset-${agentId}`}
                className="p-0.5 text-daintree-text/60 hover:text-text-primary transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>
      {isEditing && (
        <AgentShortcutCapture
          agentId={agentId}
          onCapture={(combo) => void handleSave(combo)}
          onCancel={() => setIsEditing(false)}
        />
      )}
    </Card>
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

  if (agentOptions.length === 0) {
    return (
      <div className="text-sm text-daintree-text/60">
        No agents registered. Add agents to the registry to configure them here.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadError && <SettingsLoadErrorBanner message={loadError} onRetry={retryAction} />}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium mb-1">CLI agents</h4>
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
            className="text-daintree-text/60 hover:text-text-primary shrink-0"
          >
            <Plug className="w-3.5 h-3.5" />
            Run setup wizard
          </Button>
        </div>

        <AgentSelectorDropdown
          agentOptions={agentOptions}
          activeSubtab={isGeneralActive ? GENERAL_SUBTAB_ID : (activeAgentId ?? GENERAL_SUBTAB_ID)}
          onSubtabChange={onSubtabChange}
        />

        {isGeneralActive && (
          <Card id="agents-general" className="space-y-4">
            <div className="pb-3 border-b border-border-default">
              <h4 className="text-sm font-medium text-text-primary">Global agent settings</h4>
              <p className="text-xs text-daintree-text/50 mt-0.5 select-text">
                Settings that apply across all agents
              </p>
            </div>
            <div id="agents-default-agent" className="space-y-2">
              <label className="text-sm font-medium text-text-primary block">Default agent</label>
              <select
                value={defaultAgent ?? ""}
                onChange={(e) =>
                  setDefaultAgent(e.target.value ? (e.target.value as DefaultAgentId) : undefined)
                }
                className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas text-text-primary focus:border-daintree-accent/40 focus:outline-hidden transition-colors"
              >
                <option value="">None (first available)</option>
                {agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-secondary select-text">
                Agent used for the help dock button
                {helpShortcut && ` (${helpShortcut})`} and automated workflows ("What's Next?",
                onboarding, project explanations). Distinct from the Portal "Default New Tab Agent"
                which controls the browser panel opened by the + button.
              </p>
            </div>
            <div id="agents-skip-permissions">
              <SettingsSwitchCard
                title="Skip permission prompts for agents"
                subtitle="Agents run commands and edit files without asking — faster, but you won't get a chance to review first. Sets the default for every agent that supports it; override per agent below. Assistant sessions aren't affected"
                ariaLabel="Skip permission prompts for agents"
                isEnabled={settings?.globalSkipPermissions ?? false}
                onChange={() => {
                  void (async () => {
                    await setGlobalSkipPermissions(!(settings?.globalSkipPermissions ?? false));
                    onSettingsChange?.();
                  })();
                }}
              />
            </div>
            <div id="agents-alt-screen">
              <SettingsSwitchCard
                variant="compact"
                title="Use alt-screen mode by default"
                subtitle="Render supported agents on the full-screen alternate buffer instead of inline. Inline is smoother (WebGL scrollback, clean resize); alt-screen matches the CLI's native full-screen TUI. Sets the default for every agent; override per agent below"
                ariaLabel="Use alt-screen mode by default"
                isEnabled={settings?.globalUseAltScreen ?? false}
                onChange={() => {
                  void (async () => {
                    await setGlobalUseAltScreen(!(settings?.globalUseAltScreen ?? false));
                    onSettingsChange?.();
                  })();
                }}
              />
            </div>
          </Card>
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
                    className="text-daintree-text/50 hover:text-text-primary"
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
                  className="text-daintree-text/50 hover:text-text-primary"
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
            </div>

            {/* Keyboard shortcut — built-in agents only; user-defined agents
                don't participate in the keybinding registry. */}
            {isBuiltInAgentId(activeAgent.id) && (
              <AgentShortcutRow agentId={activeAgent.id} agentName={activeAgent.name} />
            )}

            {/* Unified scope editor — one set of controls for Default or any
                preset. Delegates to AgentScopeEditor (useAgentScope hook + six
                leaf components). The editor body is keyed on the scope id so
                rename/edit state resets naturally on scope switch (see #4958). */}
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

            {/* Share Clipboard Directory — Gemini only, always agent-level */}
            {activeAgent.id === "gemini" && (
              <div id="agents-clipboard">
                <SettingsSwitchCard
                  variant="compact"
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
              </div>
            )}

            {/* Help Output */}
            <AgentHelpOutput
              agentId={activeAgent.id}
              agentName={activeAgent.name}
              usageUrl={activeAgent.usageUrl}
              availability={cliAvailability[activeAgent.id] ?? "missing"}
              isCliLoading={isCliLoading}
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
