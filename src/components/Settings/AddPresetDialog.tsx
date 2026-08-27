import { useState, useEffect, useMemo, useId } from "react";
import { getAgentConfig, type AgentPreset } from "@/config/agents";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  RadioChoiceGroup,
  RadioChoiceRow,
  CHOICE_SHELL,
  CHOICE_PAD,
  CHOICE_SELECTED,
  CHOICE_UNSELECTED,
  CHOICE_LABEL_INSET,
} from "@/components/ui/RadioChoice";
import { cn } from "@/lib/utils";

type CreationChoice = "blank" | "clone" | "template";

interface AddPresetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  currentPreset: AgentPreset | null;
  onCreate: (preset: Omit<AgentPreset, "id">) => void | Promise<void>;
}

export function AddPresetDialog({
  isOpen,
  onClose,
  agentId,
  currentPreset,
  onCreate,
}: AddPresetDialogProps) {
  const [choice, setChoice] = useState<CreationChoice>("blank");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const providerId = useId();

  const templates = useMemo(() => getAgentConfig(agentId)?.providerTemplates ?? [], [agentId]);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  // Both are offers the dialog can only honour when it has something to honour
  // them with, so neither is rendered otherwise — an option that silently
  // falls back to Blank asks the user to interpret a choice that isn't real.
  const canClone = !!currentPreset;
  const canUseTemplate = templates.length > 0;
  const hasChoice = canClone || canUseTemplate;

  useEffect(() => {
    if (isOpen) {
      setChoice("blank");
      setSelectedTemplateId(templates[0]?.id ?? "");
    }
  }, [isOpen, templates]);

  const handleCreate = () => {
    switch (choice) {
      case "blank":
        onCreate({ name: "New preset", env: {} });
        break;
      case "clone":
        // Guarded rather than defaulted: `canCreate` keeps the button disabled
        // instead of quietly creating something other than what was asked for.
        if (!currentPreset) return;
        onCreate({
          name: `${currentPreset.name} (copy)`,
          env: currentPreset.env ? { ...currentPreset.env } : {},
          args: currentPreset.args ? [...currentPreset.args] : undefined,
          dangerousEnabled: currentPreset.dangerousEnabled,
          dangerousMode: currentPreset.dangerousMode,
          customFlags: currentPreset.customFlags,
          inlineMode: currentPreset.inlineMode,
          color: currentPreset.color,
          fallbacks: undefined,
        });
        break;
      case "template":
        if (!selectedTemplate) return;
        onCreate({
          name: selectedTemplate.name,
          description: selectedTemplate.description,
          env: selectedTemplate.env ? { ...selectedTemplate.env } : {},
          args: selectedTemplate.args ? [...selectedTemplate.args] : undefined,
          dangerousEnabled: selectedTemplate.dangerousEnabled,
          dangerousMode: selectedTemplate.dangerousMode,
          customFlags: selectedTemplate.customFlags,
          inlineMode: selectedTemplate.inlineMode,
        });
        break;
    }
  };

  const canCreate =
    (choice !== "template" || !!selectedTemplate) && (choice !== "clone" || !!currentPreset);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="sm" data-testid="add-preset-dialog">
      <AppDialog.Header>
        <AppDialog.Title>Add preset</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {hasChoice ? (
          <RadioChoiceGroup legend="Start from">
            <RadioChoiceRow
              name="creation-choice"
              value="blank"
              checked={choice === "blank"}
              onChange={() => setChoice("blank")}
              label="Blank"
              description="An empty preset, with no runtime overrides"
            />

            {currentPreset && (
              <RadioChoiceRow
                name="creation-choice"
                value="clone"
                checked={choice === "clone"}
                onChange={() => setChoice("clone")}
                label="Clone current"
                description={`A copy of "${currentPreset.name}", ready to edit`}
              />
            )}

            {canUseTemplate && (
              <div
                className={cn(
                  CHOICE_SHELL,
                  choice === "template" ? CHOICE_SELECTED : CHOICE_UNSELECTED
                )}
                data-testid="template-choice-row"
              >
                <RadioChoiceRow
                  name="creation-choice"
                  value="template"
                  checked={choice === "template"}
                  onChange={() => setChoice("template")}
                  label="From template"
                  description="A provider's connection settings, filled in"
                  bare
                />

                {/* Inside the option it belongs to, and outside its <label> so
                    the select does not toggle the radio. The nesting is what
                    carries the dependency: fills and borders are stripped under
                    forced-colors, structure is not. */}
                {choice === "template" && (
                  <div className={cn(CHOICE_PAD, "pt-0 space-y-1.5", CHOICE_LABEL_INSET)}>
                    <label
                      htmlFor={providerId}
                      className="block text-xs font-medium text-text-secondary"
                    >
                      Provider
                    </label>
                    <select
                      id={providerId}
                      value={selectedTemplateId}
                      onChange={(e) => setSelectedTemplateId(e.target.value)}
                      className="w-full rounded-[var(--radius-md)] border border-border-strong bg-surface-input px-3 py-1.5 text-sm text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                      data-testid="template-select"
                    >
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    {selectedTemplate?.description && (
                      <p className="text-xs text-text-secondary select-text">
                        {/* Trimmed at render, not at the source: these strings
                            are agent-facing through the MCP preset schema and
                            pinned by the registry contract test, but as a
                            single-clause subtitle here the period is wrong. */}
                        {selectedTemplate.description.replace(/\.$/, "")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </RadioChoiceGroup>
        ) : (
          // One path left is not a decision. Say what will happen and why the
          // other two are absent, rather than rendering a single-option group.
          <p className="text-sm text-text-secondary select-text">
            The new preset starts empty — there's no preset selected to clone, and this agent has no
            provider templates.
          </p>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onClose }}
        primaryAction={{ label: "Create preset", onClick: handleCreate, disabled: !canCreate }}
      />
    </AppDialog>
  );
}
