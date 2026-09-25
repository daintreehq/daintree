import { useEffect, useEffectEvent, useMemo, useRef, useState, useCallback } from "react";
import { useEffectiveCombo, useKeybindingDisplay } from "@/hooks/useKeybinding";
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
import { ExternalLink } from "lucide-react";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSelect } from "./SettingsSelect";
import { AddPresetDialog } from "./AddPresetDialog";
import { AgentScopeEditor, resolveSkipPermissions } from "./AgentScopeEditor";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { actionService } from "@/services/ActionService";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { AgentInstallSection } from "@/components/agents/AgentCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AgentInventorySection } from "./AgentInventorySection";
import { AgentQuotaSection } from "./AgentQuotaSection";
import { isAgentLaunchable, isAgentReady } from "../../../shared/utils/agentAvailability";
import { AgentShortcutCapture } from "@/components/KeyboardShortcuts";
import { KbdChord } from "@/components/ui/Kbd";
import { keybindingService } from "@/services/KeybindingService";
import { notify } from "@/lib/notify";
import type { DefaultAgentId } from "@/store/agentPreferencesStore";

const GENERAL_SUBTAB_ID = "general";
/** Radix Select reserves the empty string, so "no default" needs a sentinel value. */
const NO_DEFAULT_AGENT = "__none__";

function AgentShortcutRow({ agentId, agentName }: { agentId: BuiltInAgentId; agentName: string }) {
  const actionId = `agent.${agentId}`;
  const currentCombo = useEffectiveCombo(actionId) ?? "";
  const [isEditing, setIsEditing] = useState(false);
  const [isOverridden, setIsOverridden] = useState(() => keybindingService.hasOverride(actionId));
  const editRef = useRef<HTMLButtonElement>(null);
  // The Change button unmounted with the row's rest state; closing the recorder
  // hands focus back to it rather than letting it fall to the dialog.
  const restoreFocusRef = useRef(false);

  const closeEditor = useCallback(() => {
    restoreFocusRef.current = true;
    setIsEditing(false);
  }, []);

  useEffect(() => {
    if (isEditing || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    editRef.current?.focus();
  }, [isEditing]);

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
      closeEditor();
    },
    [actionId, closeEditor]
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
      isModified={isOverridden && !isEditing}
      onReset={() => void handleReset()}
      resetAriaLabel={`Reset ${agentName} shortcut to default`}
      control={
        isEditing ? (
          <AgentShortcutCapture
            agentId={agentId}
            currentCombo={currentCombo}
            onCapture={(combo) => void handleSave(combo)}
            onCancel={closeEditor}
          />
        ) : (
          <div className="flex items-center gap-3" data-testid={`agent-shortcut-row-${agentId}`}>
            {currentCombo ? (
              <span data-testid={`agent-shortcut-pill-${agentId}`}>
                <KbdChord shortcut={currentCombo} density="bare" foreground="primary" />
              </span>
            ) : (
              <span className="text-xs text-text-secondary">Not set</span>
            )}
            <Button
              ref={editRef}
              size="sm"
              variant="outline"
              onClick={() => setIsEditing(true)}
              data-testid={`agent-shortcut-edit-${agentId}`}
            >
              {currentCombo ? "Change" : "Assign"}
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

  const [recheckStatus, setRecheckStatus] = useState("");
  const pickerRowRef = useRef<HTMLDivElement>(null);

  const handleRefreshCliAvailability = async () => {
    if (isRefreshingCli) return;
    setRecheckStatus("");
    try {
      // Explicit user gesture — bypass the 30s throttle that exists for
      // passive triggers (tray-open, window focus, visibility change).
      await refreshCliAvailability(true);
      await fetchCliDetails();
      const agentId = activeAgentId;
      if (agentId) {
        const state = useCliAvailabilityStore.getState().availability[agentId];
        const name = getAgentConfig(agentId)?.name ?? agentId;
        setRecheckStatus(
          isAgentReady(state) ? `${name} is ready` : `${name} still needs attention`
        );
      } else {
        setRecheckStatus("Agent check finished");
      }
      // A re-check that fixes the agent unmounts the section holding the Re-check
      // button, which would drop keyboard focus onto the page. Hand it to the picker.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement) {
          pickerRowRef.current
            ?.querySelector<HTMLElement>('[data-testid="agent-selector-trigger"]')
            ?.focus({ preventScroll: true });
        }
      });
    } catch (error) {
      logError("[AgentSettings] Failed to refresh CLI availability", error);
      setRecheckStatus("Agent check failed");
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
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

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
      // The dialog stays open and says so; swallowing this left it open with no
      // explanation.
      throw error;
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
          const launchPreset = entry.presetId
            ? getMergedPresets(
                id,
                entry.customPresets,
                ccrPresetsByAgent[id],
                projectPresetsByAgent[id]
              ).find((p) => p.id === entry.presetId)
            : undefined;
          return {
            id,
            name: config.name,
            color: config.color,
            Icon: config.icon,
            usageUrl: config.usageUrl,
            selected: isAgentToolbarVisible(entry, cliAvailability?.[id]),
            availability: cliAvailability?.[id],
            // What a launch would actually do — the launch preset and the global
            // switch included — not the legacy per-agent boolean.
            dangerousEnabled: resolveSkipPermissions(
              id,
              entry,
              launchPreset,
              effectiveSettings.globalSkipPermissions ?? false
            ),
            hasCustomFlags: Boolean(entry.customFlags?.trim()),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    [agentIds, effectiveSettings, cliAvailability, ccrPresetsByAgent, projectPresetsByAgent]
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

      {/* The picker names the agent, so an agent's page opens straight on its sections
          rather than repeating the name as a second heading. */}
      <p role="status" className="sr-only">
        {recheckStatus}
      </p>
      <div ref={pickerRowRef} className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <AgentSelectorDropdown
            agentOptions={agentOptions}
            activeSubtab={
              isGeneralActive ? GENERAL_SUBTAB_ID : (activeAgentId ?? GENERAL_SUBTAB_ID)
            }
            onSubtabChange={onSubtabChange}
          />
        </div>
        {activeAgent?.usageUrl && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
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
            <ExternalLink aria-hidden="true" />
            View usage
          </Button>
        )}
      </div>

      {activeAgentId && <AgentQuotaSection agentId={activeAgentId} />}

      {isGeneralActive && (
        <AgentInventorySection
          agents={agentOptions}
          availability={cliAvailability}
          isLoading={isCliLoading}
          error={cliError}
          isRefreshing={isRefreshingCli}
          onRefresh={() => void handleRefreshCliAvailability()}
          onOpenAgent={onSubtabChange}
          onRunSetupWizard={() =>
            window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"))
          }
        />
      )}

      {isGeneralActive && (
        <SettingsSection
          id="agents-general"
          title="All agents"
          description="Each agent's page can override these"
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
              subtitle="Agents run commands and edit files without asking — faster, but you won't get a chance to review first. Applies to every agent that supports it; Assistant sessions aren't affected."
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
              subtitle="Render supported agents on the full-screen alternate buffer instead of inline. Inline is smoother (WebGL scrollback, clean resize); alt-screen matches the CLI's native full-screen TUI."
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
          {/* First on the page when it renders at all: an agent that is missing,
              blocked or has no credentials is usually why this page was opened. */}
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

          <SettingsSection title="Launching">
            <SettingsGroup>
              <SettingsSwitchCard
                id="agents-enable"
                title="Pin to toolbar"
                subtitle={`Show ${activeAgent.name} in the toolbar for quick access`}
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
                // No modified bar: pinning has no stable default to differ from. First
                // run pins only the first few installed agents and explicitly unpins the
                // rest (buildInitialAgentPinUpdates), so any "default" comparison lights
                // the bar on agents the user never touched.
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
                  isModified={activeEntry.decorativeEffects === true}
                  onReset={() => {
                    void (async () => {
                      await updateAgent(activeAgent.id, { decorativeEffects: false });
                      onSettingsChange?.();
                    })();
                  }}
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
                  isModified={activeEntry.shareClipboardDirectory === false}
                  onReset={() => {
                    void (async () => {
                      await updateAgent(activeAgent.id, { shareClipboardDirectory: undefined });
                      onSettingsChange?.();
                    })();
                  }}
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

          {/* Loading help runs the CLI, so it is offered only for one that can run —
              not a missing or blocked binary, which the section above explains. */}
          {isAgentLaunchable(cliAvailability[activeAgent.id]) && (
            <AgentHelpOutput
              agentId={activeAgent.id}
              agentName={activeAgent.name}
              availability={cliAvailability[activeAgent.id] ?? "missing"}
            />
          )}

          {/* Last on the page and in a group of its own: it deletes custom presets. */}
          <SettingsGroup id="agents-reset">
            <SettingsRow
              label={`Reset ${activeAgent.name} settings`}
              description={`Returns launch and runtime settings to their defaults and deletes ${activeAgent.name}'s custom presets`}
              control={
                <Button
                  size="sm"
                  variant="ghost-danger"
                  onClick={() => setIsResetConfirmOpen(true)}
                >
                  Reset settings
                </Button>
              }
            />
          </SettingsGroup>

          <ConfirmDialog
            isOpen={isResetConfirmOpen}
            variant="destructive"
            onClose={() => setIsResetConfirmOpen(false)}
            onConfirm={() => {
              setIsResetConfirmOpen(false);
              void (async () => {
                await reset(activeAgent.id);
                onSettingsChange?.();
              })();
            }}
            title={`Reset ${activeAgent.name} settings?`}
            description={`Launch and runtime settings go back to their defaults, and ${activeAgent.name}'s custom presets are deleted. Project and CCR presets aren't affected.`}
            confirmLabel="Reset settings"
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
