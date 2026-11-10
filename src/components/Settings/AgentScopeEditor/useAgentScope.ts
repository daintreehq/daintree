import { useMemo, useState } from "react";
import { getAgentConfig, getMergedPresets, type AgentPreset } from "@/config/agents";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { resolveScopeKind, stripCcrPrefix } from "./scopeUtils";
import {
  isAgentTerminalBypassSupported,
  resolveDangerousMode,
  combineDangerousModes,
  type AgentSettingsEntry,
  type DangerousMode,
} from "@shared/types";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

interface UseAgentScopeProps {
  agentId: string;
  activeEntry: AgentSettingsEntry;
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
  editingPresetId: string | null;
  setEditingPresetId: (id: string | null) => void;
  editName: string;
  setEditName: (name: string) => void;
  lastEditTimeRef: React.MutableRefObject<number>;
  setIsAddDialogOpen: (open: boolean) => void;
  setAddDialogAgentId: (id: string | null) => void;
  updateAgent: (id: string, patch: Partial<AgentSettingsEntry>) => Promise<void>;
  onSettingsChange?: () => void;
}

export function useAgentScope({
  agentId,
  activeEntry,
  ccrPresets,
  projectPresets,
  editingPresetId,
  setEditingPresetId,
  editName,
  setEditName,
  lastEditTimeRef,
  setIsAddDialogOpen,
  setAddDialogAgentId,
  updateAgent,
  onSettingsChange,
}: UseAgentScopeProps) {
  const [renameError, setRenameError] = useState<string | null>(null);

  // ── derived values ──────────────────────────────────────────────────────
  const customPresets = activeEntry.customPresets;
  const allPresets = useMemo(
    () => getMergedPresets(agentId, customPresets, ccrPresets, projectPresets),
    [agentId, customPresets, ccrPresets, projectPresets]
  );
  const selectedPreset = allPresets.find((f) => f.id === activeEntry.presetId);

  const { scopeKind, selectedIsCustom, selectedIsProject, selectedIsCcr } = resolveScopeKind(
    selectedPreset,
    customPresets,
    projectPresets
  );

  const scopeLabel = useMemo(() => {
    if (scopeKind === "default") return "Default";
    if (scopeKind === "ccr" && selectedPreset)
      return selectedPreset.displayTitle ?? stripCcrPrefix(selectedPreset.name);
    return selectedPreset?.displayTitle ?? selectedPreset?.name ?? "Default";
  }, [scopeKind, selectedPreset]);

  const agentCfg = getAgentConfig(agentId);

  const agentDefaultCustomFlags = activeEntry.customFlags ?? "";

  const customFlagsOverride = selectedPreset?.customFlags;

  // Tri-state bypass (#10432 follow-up). The control edits the *active scope's
  // own* mode; "Default" (inherit) defers to its parent (preset → agent →
  // global) and an explicit "off" vetoes a broader "on".
  const agentMode = resolveDangerousMode(activeEntry);
  const presetMode = selectedPreset ? resolveDangerousMode(selectedPreset) : undefined;
  const dangerousMode: DangerousMode =
    scopeKind === "custom" ? (presetMode ?? "inherit") : agentMode;

  // True when the global skip-permissions switch (#10432) turns bypass on for
  // this agent — the baseline an "inherit" resolves to. Only agents with a
  // terminal bypass flag follow it (#16414).
  const globalSkipPermissions = useAgentSettingsStore(
    (s) => s.settings?.globalSkipPermissions ?? false
  );
  const globalBypassReachesAgent = isAgentTerminalBypassSupported(agentId);
  const globalBypassActive = globalSkipPermissions && globalBypassReachesAgent;

  const resolveMode = (mode: DangerousMode): boolean =>
    mode === "on" ? true : mode === "off" ? false : globalBypassActive;

  // What the "Default" (inherit) segment resolves to and where that comes from
  // — drives the explanatory hint under the control.
  const agentResolvedDangerous = resolveMode(agentMode);
  const inheritResolvesToOn = scopeKind === "custom" ? agentResolvedDangerous : globalBypassActive;
  const inheritHint =
    scopeKind === "custom"
      ? "Inherited from agent default"
      : globalBypassReachesAgent
        ? "Inherited from global setting"
        : "The global setting doesn't apply to this agent";

  // Final resolved bypass for the active scope (incl. the global baseline) —
  // drives the "<flag> added to command" chip.
  // Any selected preset layers onto the agent, read-only ones included: they
  // launch through the same resolution, so they report the same way.
  const effectiveSkipPerms = selectedPreset
    ? resolveMode(combineDangerousModes(agentMode, presetMode))
    : agentResolvedDangerous;

  const isEditableScope = scopeKind === "default" || scopeKind === "custom";
  const customArgsValue =
    scopeKind === "custom" ? (customFlagsOverride ?? "") : agentDefaultCustomFlags;
  const customArgsPlaceholder =
    scopeKind === "custom" && customFlagsOverride === undefined
      ? agentDefaultCustomFlags || "Using default (no flags)"
      : "No extra flags";
  // The inherited value goes in the description, not only the placeholder: a
  // placeholder vanishes as soon as the user starts typing over it.
  const customArgsDescription =
    scopeKind === "custom"
      ? customFlagsOverride === undefined
        ? `Using the agent's own arguments (${agentDefaultCustomFlags || "none"}). Type here to replace them for this preset, quoting arguments that contain spaces.`
        : "Extra CLI flags for this preset, used instead of the agent's own; quote arguments that contain spaces"
      : "Extra CLI flags appended to every launch; quote arguments that contain spaces";

  const agentEnvSuggestions = agentCfg?.envSuggestions ?? [];

  // ── handlers ────────────────────────────────────────────────────────────

  const handleUpdatePreset = (presetId: string, patch: Partial<AgentPreset>) => {
    const updated = (activeEntry.customPresets ?? []).map((f) =>
      f.id === presetId ? { ...f, ...patch } : f
    );
    void (async () => {
      try {
        await updateAgent(agentId, { customPresets: updated } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
      } catch (error) {
        logError("Failed to update preset", error);
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Preset update failed",
          message: "Couldn't save the preset changes.",
        });
      }
    })();
  };

  const openAddDialog = () => {
    setAddDialogAgentId(agentId);
    setIsAddDialogOpen(true);
  };

  const handleDuplicatePreset = (preset: AgentPreset) => {
    const id = `user-${crypto.randomUUID()}`;
    const updated = [
      ...(activeEntry.customPresets ?? []),
      // Drop the display title on copy so the duplicate doesn't share an
      // identical custom label with its source — it falls back to the new name.
      { ...preset, id, name: `${preset.name} (copy)`, displayTitle: undefined },
    ];
    void (async () => {
      try {
        await updateAgent(agentId, {
          customPresets: updated,
          presetId: id,
        } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
        // Selecting the copy re-keys the editor, removing the Duplicate button that had
        // focus. Hand it to the preset picker, which now names the copy.
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (!active || active === document.body) {
            document
              .querySelector<HTMLElement>('#agents-presets [data-testid="preset-selector-trigger"]')
              ?.focus();
          }
        });
      } catch (error) {
        logError("Failed to duplicate preset", error);
        notify({
          type: "error",
          title: "Preset not duplicated",
          message: `Couldn't save a copy of ${preset.name}.`,
          action: { label: "Try again", onClick: () => handleDuplicatePreset(preset) },
          context: { eventKind: "uiFeedback" },
        });
      }
    })();
  };

  const handleDeletePreset = (presetId: string) => {
    const updated = (activeEntry.customPresets ?? []).filter((f) => f.id !== presetId);
    void (async () => {
      try {
        if (activeEntry.presetId === presetId) {
          await updateAgent(agentId, {
            customPresets: updated,
            presetId: undefined,
          } as Partial<AgentSettingsEntry>);
        } else {
          await updateAgent(agentId, { customPresets: updated } as Partial<AgentSettingsEntry>);
        }
        onSettingsChange?.();
      } catch (error) {
        logError("Failed to delete preset", error);
        notify({
          type: "error",
          title: "Preset not deleted",
          message: "Couldn't save the change, so the preset is still there.",
          action: { label: "Try again", onClick: () => handleDeletePreset(presetId) },
          context: { eventKind: "uiFeedback" },
        });
      }
    })();
  };

  const handleStartEdit = (preset: AgentPreset) => {
    setRenameError(null);
    setEditingPresetId(preset.id);
    setEditName(preset.name);
  };

  /**
   * Commits the rename, or keeps the draft and says why. The rules are the preset
   * sanitizer's own (`sanitizePreset` in config/agents): a name it would reject is
   * one that would make the preset vanish on the next load, so it is refused here
   * instead — and ordinary punctuation like an apostrophe is not.
   */
  const handleCommitEdit = (): boolean => {
    if (!editingPresetId) return true;
    const trimmed = editName.trim();
    const problem = !trimmed
      ? "Give the preset a name"
      : trimmed.length > 200
        ? "Keep the name under 200 characters"
        : /[<>]/.test(trimmed)
          ? "Names can't contain < or >"
          : null;
    if (problem) {
      setRenameError(problem);
      return false;
    }
    // Stamp lastEditTimeRef so external rate-limit consumers can detect a recent
    // edit. Double-commit between Enter+blur is prevented by the `editingPresetId`
    // guard above (the second call sees null).
    lastEditTimeRef.current = Date.now();
    handleUpdatePreset(editingPresetId, { name: trimmed });
    setRenameError(null);
    setEditingPresetId(null);
    setEditName("");
    return true;
  };

  const handleCancelEdit = () => {
    setRenameError(null);
    setEditingPresetId(null);
    setEditName("");
  };

  const handleDangerousModeChange = (mode: DangerousMode) => {
    if (scopeKind === "default") {
      void (async () => {
        await updateAgent(agentId, {
          dangerousMode: mode,
          // Mirror the legacy boolean so badge / setup-wizard readers stay correct.
          dangerousEnabled: mode === "on",
        } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
      })();
    } else if (scopeKind === "custom" && selectedPreset) {
      // "Default" clears the override (both fields → undefined, dropped on
      // serialize) so the preset inherits the agent's resolved mode.
      handleUpdatePreset(selectedPreset.id, {
        dangerousMode: mode === "inherit" ? undefined : mode,
        dangerousEnabled: mode === "inherit" ? undefined : mode === "on",
      });
    }
  };

  const handleCustomFlagsChange = (value: string) => {
    if (scopeKind === "default") {
      void updateAgent(agentId, { customFlags: value } as Partial<AgentSettingsEntry>);
    } else if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { customFlags: value });
    }
  };

  const handleDisplayTitleChange = (value: string) => {
    if (scopeKind === "custom" && selectedPreset) {
      // Store empty/whitespace as undefined so the title falls back to `name`.
      handleUpdatePreset(selectedPreset.id, { displayTitle: value.trim() ? value : undefined });
    }
  };

  const handleCustomFlagsOverrideReset = () => {
    if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { customFlags: undefined });
    }
  };

  return {
    // derived
    scopeKind,
    scopeLabel,
    allPresets,
    selectedPreset,
    selectedIsCustom,
    selectedIsProject,
    selectedIsCcr,
    isEditableScope,
    dangerousMode,
    effectiveSkipPerms,
    globalBypassActive,
    inheritResolvesToOn,
    inheritHint,
    customArgsValue,
    customArgsPlaceholder,
    customArgsDescription,
    agentEnvSuggestions,
    agentDefaultCustomFlags,
    customFlagsOverride,
    customPresets,
    ccrPresets,
    projectPresets,
    agentCfg,
    // handlers
    openAddDialog,
    handleDuplicatePreset,
    handleDeletePreset,
    handleUpdatePreset,
    handleStartEdit,
    handleCommitEdit,
    handleCancelEdit,
    renameError,
    handleDangerousModeChange,
    handleCustomFlagsChange,
    handleDisplayTitleChange,
    handleCustomFlagsOverrideReset,
  };
}
