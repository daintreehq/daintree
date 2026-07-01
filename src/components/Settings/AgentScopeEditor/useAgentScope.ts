import { useMemo } from "react";
import { getAgentConfig, getMergedPresets, type AgentPreset } from "@/config/agents";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { resolveScopeKind, stripCcrPrefix } from "./scopeUtils";
import {
  isAgentBypassSupported,
  resolveDangerousMode,
  combineDangerousModes,
  resolveInlineMode,
  combineInlineModes,
  resolveEffectiveInlineMode,
  type AgentSettingsEntry,
  type DangerousMode,
  type InlineMode,
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
  const supportsInlineMode = !!agentCfg?.capabilities?.inlineModeFlag;

  const agentDefaultCustomFlags = activeEntry.customFlags ?? "";

  const customFlagsOverride = selectedPreset?.customFlags;

  // Tri-state bypass (#10432 follow-up). The control edits the *active scope's
  // own* mode; "Default" (inherit) defers to its parent (preset → agent →
  // global) and an explicit "off" vetoes a broader "on".
  const agentMode = resolveDangerousMode(activeEntry);
  const presetMode = selectedPreset ? resolveDangerousMode(selectedPreset) : undefined;
  const dangerousMode: DangerousMode =
    scopeKind === "custom" ? (presetMode ?? "inherit") : agentMode;

  // True when the global skip-permissions override (#10432) is forcing bypass
  // on for this bypass-supporting agent — the baseline an "inherit" resolves to.
  const globalSkipPermissions = useAgentSettingsStore(
    (s) => s.settings?.globalSkipPermissions ?? false
  );
  const globalBypassActive = globalSkipPermissions && isAgentBypassSupported(agentId);

  const resolveMode = (mode: DangerousMode): boolean =>
    mode === "on" ? true : mode === "off" ? false : globalBypassActive;

  // What the "Default" (inherit) segment resolves to and where that comes from
  // — drives the explanatory hint under the control.
  const agentResolvedDangerous = resolveMode(agentMode);
  const inheritResolvesToOn = scopeKind === "custom" ? agentResolvedDangerous : globalBypassActive;
  const inheritOriginLabel = scopeKind === "custom" ? "agent default" : "global setting";

  // Final resolved bypass for the active scope (incl. the global baseline) —
  // drives the "<flag> added to command" chip.
  const effectiveSkipPerms =
    scopeKind === "custom"
      ? resolveMode(combineDangerousModes(agentMode, presetMode))
      : agentResolvedDangerous;

  // Tri-state alt-screen mode (#10876), mirroring the bypass control above. The
  // stored value polarity is "on" = inline, "off" = alt screen; "Default"
  // (inherit) defers to the agent registry default and then the global
  // "Use alt-screen mode by default" switch.
  const globalUseAltScreen = useAgentSettingsStore((s) => s.settings?.globalUseAltScreen ?? false);
  const agentInlineMode = resolveInlineMode(activeEntry);
  const presetInlineMode = selectedPreset ? resolveInlineMode(selectedPreset) : undefined;
  const inlineMode: InlineMode =
    scopeKind === "custom" ? (presetInlineMode ?? "inherit") : agentInlineMode;

  // Resolve a tri-state to the effective "is inline" decision via the SAME
  // shared chokepoint the launch path uses, so the UI can't drift from behavior.
  const resolveInline = (mode: InlineMode): boolean =>
    resolveEffectiveInlineMode({ inlineMode: mode }, agentId, globalUseAltScreen);

  const agentResolvedInline = resolveInline(agentInlineMode);
  // What the inline "Default" (inherit) segment resolves to and where from.
  const inlineInheritResolvesToInline =
    scopeKind === "custom" ? agentResolvedInline : resolveInline("inherit");
  const inlineInheritOriginLabel = scopeKind === "custom" ? "agent default" : "global setting";

  const effectiveInlineMode =
    scopeKind === "custom"
      ? resolveInline(combineInlineModes(agentInlineMode, presetInlineMode))
      : agentResolvedInline;

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
      await updateAgent(agentId, {
        customPresets: updated,
        presetId: id,
      } as Partial<AgentSettingsEntry>);
      onSettingsChange?.();
    })();
  };

  const handleDeletePreset = (presetId: string) => {
    const updated = (activeEntry.customPresets ?? []).filter((f) => f.id !== presetId);
    void (async () => {
      if (activeEntry.presetId === presetId) {
        await updateAgent(agentId, {
          customPresets: updated,
          presetId: undefined,
        } as Partial<AgentSettingsEntry>);
      } else {
        await updateAgent(agentId, { customPresets: updated } as Partial<AgentSettingsEntry>);
      }
      onSettingsChange?.();
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
    if (editingPresetId && trimmed && trimmed.length <= 200 && !/[<>'"&]/.test(trimmed)) {
      // Stamp lastEditTimeRef so external rate-limit consumers can detect
      // a recent edit. Double-commit between Enter+blur is already prevented
      // by the `editingPresetId &&` guard above (the second call sees null).
      lastEditTimeRef.current = Date.now();
      handleUpdatePreset(editingPresetId, { name: trimmed });
    }
    setEditingPresetId(null);
    setEditName("");
  };

  const handleCancelEdit = () => {
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

  const handleInlineModeChange = (mode: InlineMode) => {
    if (scopeKind === "default") {
      void (async () => {
        await updateAgent(agentId, { inlineMode: mode } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
      })();
    } else if (scopeKind === "custom" && selectedPreset) {
      // "Default" clears the override (undefined, dropped on serialize) so the
      // preset inherits the agent's resolved mode.
      handleUpdatePreset(selectedPreset.id, { inlineMode: mode === "inherit" ? undefined : mode });
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
    supportsInlineMode,
    dangerousMode,
    effectiveSkipPerms,
    globalBypassActive,
    inheritResolvesToOn,
    inheritOriginLabel,
    inlineMode,
    effectiveInlineMode,
    inlineInheritResolvesToInline,
    inlineInheritOriginLabel,
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
    handleDangerousModeChange,
    handleInlineModeChange,
    handleCustomFlagsChange,
    handleDisplayTitleChange,
    handleCustomFlagsOverrideReset,
  };
}
