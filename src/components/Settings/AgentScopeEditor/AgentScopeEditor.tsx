import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { PresetSelector } from "../PresetSelector";
import { SettingsSection } from "../SettingsSection";
import { SETTINGS_CONTROL_WIDTH, SettingsGroup, SettingsRow } from "../SettingsGroup";
import { useAgentScope } from "./useAgentScope";
import { ScopeBadge, describeScope } from "./ScopeBanner";
import { CustomPresetChrome, PresetDeleteRow } from "./CustomPresetChrome";
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

/**
 * The preset an agent launches with, and that preset's settings.
 *
 * Choosing a preset here saves it as the agent's launch preset — it is not a view
 * filter — so the picker is the group's first row, labelled for what it does, and every
 * row under it edits (or, for a read-only source, shows) the preset it names. One group:
 * the picker is the parent the rest depends on.
 */
export function AgentScopeEditor(props: AgentScopeEditorProps) {
  const { defaultDangerousArg } = props;
  const scope = useAgentScope(props);
  const agentName = scope.agentCfg?.name ?? props.agentId;
  const agentColor = scope.agentCfg?.color ?? "var(--theme-text-secondary)";

  return (
    <SettingsSection
      id="agents-presets"
      title="Launch preset"
      description="A preset bundles environment variables, arguments and permissions under one name"
      action={
        <Button
          size="sm"
          variant="outline"
          data-testid="preset-add-button"
          onClick={scope.openAddDialog}
        >
          Add preset
        </Button>
      }
    >
      <SettingsGroup>
        <SettingsRow
          label="Preset"
          accessory={<ScopeBadge scopeKind={scope.scopeKind} />}
          description={describeScope(scope.scopeKind, agentName)}
          control={({ labelId, descriptionId }) => (
            <div className={SETTINGS_CONTROL_WIDTH.wide}>
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
                agentColor={agentColor}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
              />
            </div>
          )}
        />

        {/* Keyed on scope so rename/edit state resets naturally on switch (#4958). A
            fragment rather than a wrapper, so the group's hairlines still fall between
            rows. */}
        <Fragment key={props.activeEntry.presetId ?? "default"}>
          {scope.scopeKind === "custom" && scope.selectedPreset && (
            <CustomPresetChrome
              selectedPreset={scope.selectedPreset}
              agentColor={agentColor}
              isEditing={props.editingPresetId === scope.selectedPreset.id}
              editName={props.editName}
              onEditNameChange={props.setEditName}
              onCommitEdit={scope.handleCommitEdit}
              onCancelEdit={scope.handleCancelEdit}
              onStartEdit={scope.handleStartEdit}
              onColorChange={(color) =>
                scope.handleUpdatePreset(scope.selectedPreset!.id, { color })
              }
              onDisplayTitleChange={scope.handleDisplayTitleChange}
              onDuplicate={scope.handleDuplicatePreset}
            />
          )}

          {(scope.scopeKind === "default" || scope.scopeKind === "custom") && (
            <EnvBlock
              scopeKind={scope.scopeKind}
              agentId={props.agentId}
              agentName={agentName}
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
              onPresetEnvChange={(env) =>
                scope.handleUpdatePreset(scope.selectedPreset!.id, { env })
              }
            />
          )}

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

          {scope.scopeKind === "custom" && scope.selectedPreset && (
            <>
              <FallbackChainEditor
                selectedPreset={scope.selectedPreset}
                allPresets={scope.allPresets}
                onUpdatePreset={scope.handleUpdatePreset}
              />
              <PresetDeleteRow preset={scope.selectedPreset} onDelete={scope.handleDeletePreset} />
            </>
          )}

          {(scope.scopeKind === "ccr" || scope.scopeKind === "project") && scope.selectedPreset && (
            <ReadOnlyDetail
              scopeKind={scope.scopeKind}
              selectedPreset={scope.selectedPreset}
              onDuplicate={scope.handleDuplicatePreset}
            />
          )}
        </Fragment>
      </SettingsGroup>
    </SettingsSection>
  );
}
