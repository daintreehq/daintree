import { FactRun } from "@/components/ui/FactSeparator";
import type { ComponentProps, KeyboardEvent } from "react";
import { useFieldControl } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sentenceCase } from "@/components/Hosts/cloud/cloudHostLabels";
import type { CloudProviderInfo, CloudProvisioningDimension } from "@shared/types/cloudHosts";
import { choicesFor } from "./cloudProvisioningChoices";
import type { CloudMachineForm } from "./useCloudMachineForm";

/**
 * Select values for a provisioning control: a provider's ids are opaque, so
 * each is prefixed and the provider's own call can't collide with one.
 */
const PROVIDER_DECIDES = "provider";
const choiceValue = (id: string) => `id:${id}`;

/** A Select trigger its Field's label and description name, as an Input is. */
function FieldSelectTrigger(props: ComponentProps<typeof SelectTrigger>) {
  const { controlProps } = useFieldControl(props);
  return <SelectTrigger {...props} {...controlProps} />;
}

/** The chosen choice's own description, for the field's hint; null when it has none. */
export function provisioningChoiceDescription(
  form: CloudMachineForm,
  dimension: CloudProvisioningDimension
): string | null {
  if (!form.currentCatalog) return null;
  const current = form.provisioning[dimension];
  const chosen = choicesFor(form.currentCatalog, dimension, form.provisioning.location).find(
    (choice) => choice.id === current
  );
  return chosen?.description ?? null;
}

interface CloudProvisioningSelectProps {
  form: CloudMachineForm;
  provider: CloudProviderInfo;
  dimension: CloudProvisioningDimension;
  disabled?: boolean;
  /** Inside a `Field`, whose label and description name the control. */
  inField?: boolean;
  id?: string;
  className?: string;
  "data-testid"?: string;
  onTriggerKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * One region, image or network control, in the provider's own word for it.
 * An optional dimension can be left to the provider; an image or network only
 * offers what the chosen region has.
 */
export function CloudProvisioningSelect({
  form,
  provider,
  dimension,
  disabled,
  inField,
  id,
  className,
  "data-testid": testId,
  onTriggerKeyDown,
}: CloudProvisioningSelectProps) {
  if (!form.currentCatalog) return null;
  const choices = choicesFor(form.currentCatalog, dimension, form.provisioning.location);
  const optional = provider.capabilities.provisioning[dimension] === "optional";
  const current = form.provisioning[dimension];
  const Trigger = inField ? FieldSelectTrigger : SelectTrigger;
  return (
    <Select
      value={current !== null ? choiceValue(current) : optional ? PROVIDER_DECIDES : ""}
      onValueChange={(value) =>
        form.pick(dimension, value.startsWith("id:") ? value.slice(3) : null)
      }
      disabled={disabled}
    >
      <Trigger id={id} className={className} data-testid={testId} onKeyDown={onTriggerKeyDown}>
        <SelectValue placeholder="Nothing to choose" />
      </Trigger>
      <SelectContent>
        {optional && <SelectItem value={PROVIDER_DECIDES}>Chosen by {provider.name}</SelectItem>}
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={choiceValue(choice.id)} disabled={!choice.available}>
            {choice.available || !choice.reason ? (
              choice.label
            ) : (
              <FactRun facts={[choice.label, sentenceCase(choice.reason)]} />
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
