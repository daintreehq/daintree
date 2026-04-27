import { useState, useEffect, useMemo } from "react";
import { getAgentConfig, type AgentPreset } from "@/config/agents";
import { AppDialog } from "@/components/ui/AppDialog";

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

  const templates = useMemo(() => getAgentConfig(agentId)?.providerTemplates ?? [], [agentId]);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  useEffect(() => {
    if (isOpen) {
      setChoice("blank");
      setSelectedTemplateId(templates[0]?.id ?? "");
    }
  }, [isOpen, templates]);

  const handleCreate = () => {
    const name =
      choice === "clone" && currentPreset ? `${currentPreset.name} (copy)` : "New Preset";

    switch (choice) {
      case "blank":
        onCreate({ name, env: {} });
        break;
      case "clone":
        if (currentPreset) {
          onCreate({
            name,
            env: currentPreset.env ? { ...currentPreset.env } : {},
            args: currentPreset.args ? [...currentPreset.args] : undefined,
            dangerousEnabled: currentPreset.dangerousEnabled,
            customFlags: currentPreset.customFlags,
            inlineMode: currentPreset.inlineMode,
            color: currentPreset.color,
            fallbacks: undefined,
          });
        } else {
          onCreate({ name, env: {} });
        }
        break;
      case "template":
        if (selectedTemplate) {
          onCreate({
            name: selectedTemplate.name,
            description: selectedTemplate.description,
            env: selectedTemplate.env ? { ...selectedTemplate.env } : {},
            args: selectedTemplate.args ? [...selectedTemplate.args] : undefined,
            dangerousEnabled: selectedTemplate.dangerousEnabled,
            customFlags: selectedTemplate.customFlags,
            inlineMode: selectedTemplate.inlineMode,
          });
        }
        break;
    }
  };

  const canCreate = choice !== "template" || !!selectedTemplate;

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="sm" data-testid="add-preset-dialog">
      <AppDialog.Header>
        <AppDialog.Title>Add Preset</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-4">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-daintree-text mb-2">Start from</legend>

          <RadioOption
            name="creation-choice"
            value="blank"
            checked={choice === "blank"}
            onChange={() => setChoice("blank")}
            label="Blank"
            description="Empty env, fill in from scratch"
          />

          <RadioOption
            name="creation-choice"
            value="clone"
            checked={choice === "clone"}
            onChange={() => setChoice("clone")}
            label="Clone current"
            description={
              currentPreset
                ? `Duplicate "${currentPreset.name}"`
                : "No preset selected — will create blank"
            }
          />

          {templates.length > 0 && (
            <RadioOption
              name="creation-choice"
              value="template"
              checked={choice === "template"}
              onChange={() => setChoice("template")}
              label="From template"
              description="Pre-fill provider settings, API key left blank"
            />
          )}
        </fieldset>

        {choice === "template" && templates.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-daintree-text block">Provider</label>
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-daintree-accent/50"
              data-testid="template-select"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {selectedTemplate?.description && (
              <p className="text-xs text-daintree-text/40 select-text">
                {selectedTemplate.description}
              </p>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: onClose }}
        primaryAction={{ label: "Create preset", onClick: handleCreate, disabled: !canCreate }}
      />
    </AppDialog>
  );
}

function RadioOption({
  name,
  value,
  checked,
  onChange,
  label,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 shrink-0 accent-daintree-accent"
      />
      <div>
        <span className="text-sm font-medium text-daintree-text group-hover:text-daintree-accent transition-colors">
          {label}
        </span>
        <p className="text-xs text-daintree-text/40 select-text">{description}</p>
      </div>
    </label>
  );
}
