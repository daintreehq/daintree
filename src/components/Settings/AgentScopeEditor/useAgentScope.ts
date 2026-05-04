import { useCallback, useMemo } from "react";
import { getAgentConfig, getMergedPresets, type AgentPreset } from "@/config/agents";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { resolveScopeKind, stripCcrPrefix } from "./scopeUtils";
import type { AgentSettingsEntry } from "@shared/types";

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
    if (scopeKind === "ccr" && selectedPreset) return stripCcrPrefix(selectedPreset.name);
    return selectedPreset?.name ?? "Default";
  }, [scopeKind, selectedPreset]);

  const agentCfg = getAgentConfig(agentId);
  const supportsInlineMode = !!agentCfg?.capabilities?.inlineModeFlag;

  const agentDefaultDangerous = activeEntry.dangerousEnabled ?? false;
  const agentDefaultInline = activeEntry.inlineMode ?? true;
  const agentDefaultCustomFlags = activeEntry.customFlags ?? "";

  const dangerousOverride = selectedPreset?.dangerousEnabled;
  const inlineOverride = selectedPreset?.inlineMode;
  const customFlagsOverride = selectedPreset?.customFlags;

  const effectiveSkipPerms =
    scopeKind === "custom" ? (dangerousOverride ?? agentDefaultDangerous) : agentDefaultDangerous;

  const effectiveInlineMode =
    scopeKind === "custom" ? (inlineOverride ?? agentDefaultInline) : agentDefaultInline;

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

  const handleUpdatePreset = useCallback(
    (presetId: string, patch: Partial<AgentPreset>) => {
      const updated = (activeEntry.customPresets ?? []).map((f) =>
        f.id === presetId ? { ...f, ...patch } : f
      );
      void (async () => {
        try {
          await updateAgent(agentId, { customPresets: updated } as Partial<AgentSettingsEntry>);
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
    },
    [activeEntry.customPresets, agentId, updateAgent, onSettingsChange]
  );

  const openAddDialog = useCallback(() => {
    setAddDialogAgentId(agentId);
    setIsAddDialogOpen(true);
  }, [agentId, setAddDialogAgentId, setIsAddDialogOpen]);

  const handleDuplicatePreset = useCallback(
    (preset: AgentPreset) => {
      const id = `user-${crypto.randomUUID()}`;
      const updated = [
        ...(activeEntry.customPresets ?? []),
        { ...preset, id, name: `${preset.name} (copy)` },
      ];
      void (async () => {
        await updateAgent(agentId, {
          customPresets: updated,
          presetId: id,
        } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
      })();
    },
    [activeEntry.customPresets, agentId, updateAgent, onSettingsChange]
  );

  const handleDeletePreset = useCallback(
    (presetId: string) => {
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
    },
    [activeEntry.customPresets, activeEntry.presetId, agentId, updateAgent, onSettingsChange]
  );

  const handleStartEdit = useCallback(
    (preset: AgentPreset) => {
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
    },
    [setEditingPresetId, setEditName]
  );

  const handleCommitEdit = useCallback(() => {
    const trimmed = editName.trim();
    if (editingPresetId && trimmed && trimmed.length <= 200 && !/[<>'"&]/.test(trimmed)) {
      const now = Date.now();
      if (now - lastEditTimeRef.current < 100) return;
      lastEditTimeRef.current = now;
      handleUpdatePreset(editingPresetId, { name: trimmed });
    }
    setEditingPresetId(null);
    setEditName("");
  }, [
    editName,
    editingPresetId,
    lastEditTimeRef,
    handleUpdatePreset,
    setEditingPresetId,
    setEditName,
  ]);

  const handleCancelEdit = useCallback(() => {
    setEditingPresetId(null);
    setEditName("");
  }, [setEditingPresetId, setEditName]);

  const handleSkipPermsChange = useCallback(() => {
    if (scopeKind === "default") {
      void (async () => {
        await updateAgent(agentId, {
          dangerousEnabled: !agentDefaultDangerous,
        } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
      })();
    } else if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { dangerousEnabled: !effectiveSkipPerms });
    }
  }, [
    scopeKind,
    agentId,
    agentDefaultDangerous,
    selectedPreset,
    effectiveSkipPerms,
    updateAgent,
    onSettingsChange,
    handleUpdatePreset,
  ]);

  const handleInlineModeChange = useCallback(() => {
    if (scopeKind === "default") {
      void (async () => {
        await updateAgent(agentId, {
          inlineMode: !agentDefaultInline,
        } as Partial<AgentSettingsEntry>);
        onSettingsChange?.();
      })();
    } else if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { inlineMode: !effectiveInlineMode });
    }
  }, [
    scopeKind,
    agentId,
    agentDefaultInline,
    selectedPreset,
    effectiveInlineMode,
    updateAgent,
    onSettingsChange,
    handleUpdatePreset,
  ]);

  const handleCustomFlagsChange = useCallback(
    (value: string) => {
      if (scopeKind === "default") {
        void updateAgent(agentId, { customFlags: value } as Partial<AgentSettingsEntry>);
      } else if (scopeKind === "custom" && selectedPreset) {
        handleUpdatePreset(selectedPreset.id, { customFlags: value });
      }
    },
    [scopeKind, agentId, selectedPreset, updateAgent, handleUpdatePreset]
  );

  const handleDangerousOverrideReset = useCallback(() => {
    if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { dangerousEnabled: undefined });
    }
  }, [scopeKind, selectedPreset, handleUpdatePreset]);

  const handleInlineOverrideReset = useCallback(() => {
    if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { inlineMode: undefined });
    }
  }, [scopeKind, selectedPreset, handleUpdatePreset]);

  const handleCustomFlagsOverrideReset = useCallback(() => {
    if (scopeKind === "custom" && selectedPreset) {
      handleUpdatePreset(selectedPreset.id, { customFlags: undefined });
    }
  }, [scopeKind, selectedPreset, handleUpdatePreset]);

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
    effectiveSkipPerms,
    effectiveInlineMode,
    customArgsValue,
    customArgsPlaceholder,
    customArgsDescription,
    agentEnvSuggestions,
    agentDefaultDangerous,
    agentDefaultInline,
    agentDefaultCustomFlags,
    dangerousOverride,
    inlineOverride,
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
    handleSkipPermsChange,
    handleInlineModeChange,
    handleCustomFlagsChange,
    handleDangerousOverrideReset,
    handleInlineOverrideReset,
    handleCustomFlagsOverrideReset,
  };
}
