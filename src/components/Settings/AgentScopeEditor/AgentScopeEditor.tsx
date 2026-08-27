import { Card } from "@/components/ui/card";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PresetSelector } from "../PresetSelector";
import { useAgentScope } from "./useAgentScope";
import { ScopeBanner } from "./ScopeBanner";
import { CustomPresetChrome } from "./CustomPresetChrome";
import { BehavioralControls } from "./BehavioralControls";
import { EnvBlock } from "./EnvBlock";
import { FallbackChainEditor } from "./FallbackChainEditor";
import { ReadOnlyDetail } from "./ReadOnlyDetail";
import type { AgentPreset } from "@/config/agents";
import type { AgentSettingsEntry } from "@shared/types";

interface AgentScopeEditorProps {
  agentId: string;
  activeEntry: AgentSettingsEntry;
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
  defaultDangerousArg: string;
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

export function AgentScopeEditor(props: AgentScopeEditorProps) {
  const { defaultDangerousArg } = props;
  const scope = useAgentScope(props);

  const title = "Runtime settings";

  return (
    <Card id="agents-presets" className="space-y-4">
      {/* Header: title + Add button */}
      <div
        className={`pb-3${scope.allPresets.length > 0 ? " border-b border-daintree-border" : ""}`}
      >
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-daintree-text">{title}</label>
            <p className="text-xs text-daintree-text/40 select-text">
              Pick a scope — Default applies everywhere; presets override it.
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            data-testid="preset-add-button"
            onClick={scope.openAddDialog}
          >
            <Plus size={14} />
            Add preset
          </Button>
        </div>
      </div>

      {/* Scope picker */}
      <PresetSelector
        selectedPresetId={props.activeEntry.presetId ?? undefined}
        allPresets={scope.allPresets}
        ccrPresets={scope.ccrPresets ?? []}
        projectPresets={scope.projectPresets ?? []}
        customPresets={scope.customPresets ?? []}
        onChange={(presetId) => {
          void (async () => {
            await props.updateAgent(props.agentId, {
              presetId: presetId ?? undefined,
            } as Partial<AgentSettingsEntry>);
            props.onSettingsChange?.();
          })();
        }}
        agentColor={scope.agentCfg?.color ?? "var(--theme-text-muted)"}
      />

      {/* Scope banner */}
      <ScopeBanner scopeKind={scope.scopeKind} scopeLabel={scope.scopeLabel} />

      {/* Editor body — keyed on scope for natural remount on switch */}
      <div
        key={props.activeEntry.presetId ?? "default"}
        className="space-y-3"
        data-testid="scope-editor-body"
      >
        {/* Custom preset chrome: rename / duplicate / delete */}
        {scope.scopeKind === "custom" && scope.selectedPreset && (
          <CustomPresetChrome
            selectedPreset={scope.selectedPreset}
            agentColor={scope.agentCfg?.color ?? "var(--theme-text-muted)"}
            isEditing={props.editingPresetId === scope.selectedPreset.id}
            editName={props.editName}
            onEditNameChange={props.setEditName}
            onCommitEdit={scope.handleCommitEdit}
            onCancelEdit={scope.handleCancelEdit}
            onStartEdit={scope.handleStartEdit}
            onColorChange={(color) => scope.handleUpdatePreset(scope.selectedPreset!.id, { color })}
            onDisplayTitleChange={scope.handleDisplayTitleChange}
            onDuplicate={scope.handleDuplicatePreset}
            onDelete={scope.handleDeletePreset}
          />
        )}

        {/* Env editor — most common config, shown first */}
        {(scope.scopeKind === "default" || scope.scopeKind === "custom") && (
          <EnvBlock
            scopeKind={scope.scopeKind}
            agentId={props.agentId}
            globalEnv={props.activeEntry.globalEnv as Record<string, string> | undefined}
            selectedPreset={scope.scopeKind === "custom" ? scope.selectedPreset : undefined}
            suggestions={scope.agentEnvSuggestions}
            onGlobalEnvChange={(env) => {
              void (async () => {
                await props.updateAgent(props.agentId, {
                  globalEnv: Object.keys(env).length > 0 ? env : undefined,
                } as Partial<AgentSettingsEntry>);
                props.onSettingsChange?.();
              })();
            }}
            onPresetEnvChange={(env) => scope.handleUpdatePreset(scope.selectedPreset!.id, { env })}
          />
        )}

        {/* Behavioral settings (Default / Custom scopes — editable) */}
        {scope.isEditableScope && (
          <BehavioralControls
            scopeKind={scope.scopeKind}
            scopeLabel={scope.scopeLabel}
            dangerousMode={scope.dangerousMode}
            effectiveSkipPerms={scope.effectiveSkipPerms}
            inheritResolvesToOn={scope.inheritResolvesToOn}
            inheritOriginLabel={scope.inheritOriginLabel}
            inlineMode={scope.inlineMode}
            inlineInheritResolvesToInline={scope.inlineInheritResolvesToInline}
            inlineInheritOriginLabel={scope.inlineInheritOriginLabel}
            customArgsValue={scope.customArgsValue}
            customArgsPlaceholder={scope.customArgsPlaceholder}
            customArgsDescription={scope.customArgsDescription}
            customFlagsOverride={scope.customFlagsOverride}
            supportsInlineMode={scope.supportsInlineMode}
            defaultDangerousArg={defaultDangerousArg}
            onDangerousModeChange={scope.handleDangerousModeChange}
            onInlineModeChange={scope.handleInlineModeChange}
            onCustomFlagsChange={scope.handleCustomFlagsChange}
            onCustomFlagsOverrideReset={scope.handleCustomFlagsOverrideReset}
          />
        )}

        {/* Fallback chain editor (custom scope only) */}
        {scope.scopeKind === "custom" && scope.selectedPreset && (
          <FallbackChainEditor
            selectedPreset={scope.selectedPreset}
            allPresets={scope.allPresets}
            onUpdatePreset={scope.handleUpdatePreset}
          />
        )}

        {/* Read-only detail views for CCR and project presets */}
        {(scope.scopeKind === "ccr" || scope.scopeKind === "project") && scope.selectedPreset && (
          <ReadOnlyDetail
            scopeKind={scope.scopeKind as "ccr" | "project"}
            selectedPreset={scope.selectedPreset}
            onDuplicate={scope.handleDuplicatePreset}
          />
        )}
      </div>
    </Card>
  );
}
