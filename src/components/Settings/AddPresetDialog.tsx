import { useState, useEffect, useMemo, useId } from "react";
import { getAgentConfig, type AgentPreset } from "@/config/agents";
import { AppDialog } from "@/components/ui/AppDialog";
import { cn } from "@/lib/utils";

type CreationChoice = "blank" | "clone" | "template";

/**
 * Full-row choice surfaces, so the click target matches the visual target and
 * the three starting points read as one decision set.
 *
 * Selection is carried by the neutral border + fill pair the rest of the app
 * uses for a chosen option, never by accent: the dialog's single accent spend
 * is the focus ring. Under forced-colors both the fill and the border colour
 * are overridden, which is why the native radio stays — the UA paints its
 * checked state itself and remains the indicator of last resort.
 */
// No display utility here: the shell is composed onto a `flex` label, and
// tailwind-merge resolves same-property utilities by order, so a `block` in
// this string silently wins and drops the radio onto its own line.
const ROW_SHELL = "rounded-[var(--radius-md)] border transition-colors duration-150";
const ROW_PAD = "px-3 py-2.5";
/**
 * The transparent outline is not decoration. Under `forced-colors: active` the
 * UA overrides `outline-color` — including `transparent` — to a system colour,
 * so this is what keeps the chosen card distinguishable when the fill and the
 * border have both been repainted to the same value. It costs nothing in normal
 * rendering. (MDN/Microsoft forced-colors guidance; the same reason the app
 * prefers `outline` over `ring` for focus.)
 */
const ROW_SELECTED =
  "border-border-strong bg-overlay-selected outline outline-2 outline-transparent";
const ROW_UNSELECTED = "border-daintree-border hover:bg-overlay-soft hover:border-daintree-text/30";
/** Radio (~13px) + `gap-3`, so a nested control lines up with the label column. */
const LABEL_COLUMN_INSET = "ml-[25px]";

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
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-daintree-text mb-2">Start from</legend>

            <RadioOption
              name="creation-choice"
              value="blank"
              checked={choice === "blank"}
              onChange={() => setChoice("blank")}
              label="Blank"
              description="An empty preset, with no runtime overrides"
            />

            {currentPreset && (
              <RadioOption
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
                className={cn(ROW_SHELL, choice === "template" ? ROW_SELECTED : ROW_UNSELECTED)}
                data-testid="template-choice-row"
              >
                <RadioOption
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
                  <div className={cn(ROW_PAD, "pt-0 space-y-1.5", LABEL_COLUMN_INSET)}>
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
          </fieldset>
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

function RadioOption({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  bare,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
  /** Rendered inside a row that already paints the choice surface. */
  bare?: boolean;
}) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <label
      className={cn(
        "flex items-start gap-3 cursor-pointer",
        ROW_PAD,
        // A bare option is padded by the same rule but leaves the border and
        // fill to the row that wraps it, so the whole card stays one target.
        !bare && [ROW_SHELL, checked ? ROW_SELECTED : ROW_UNSELECTED]
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        // Wrapping the whole card in the <label> is what makes the row one
        // click target, but it also folds the description into the accessible
        // name, so every option announces as one long run-on string. Naming the
        // title explicitly wins over the label subtree (AccName precedence),
        // and the consequence line comes back as a description instead.
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        // The theme accent tint comes from the global `accent-color` base rule;
        // the outline is here because the global `*:focus-visible` rule only
        // wires the transition, so a bare radio would fall through to
        // Chromium's cobalt — the one hue the app otherwise never renders.
        // mt-1 centres the ~13px control in the label's 20px line box; at
        // mt-0.5 it rode level with the top of the capital letter.
        className="mt-1 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
      />
      <span className="min-w-0">
        <span id={labelId} className="block text-sm font-medium text-daintree-text">
          {label}
        </span>
        <span id={descriptionId} className="block text-xs text-text-secondary select-text">
          {description}
        </span>
      </span>
    </label>
  );
}
