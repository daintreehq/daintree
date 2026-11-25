import { FactRun } from "@/components/ui/FactSeparator";
import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CloudProvisioningSelect,
  provisioningChoiceDescription,
} from "@/components/Settings/Hosts/CloudProvisioningSelect";
import {
  LIFETIME_VALUES,
  useCloudMachineForm,
  type CloudMachineForm,
} from "@/components/Settings/Hosts/useCloudMachineForm";
import { FormRow } from "@/components/Worktree/views/WorktreeFormLayout";
import type { CloudHostCreateRequest } from "@shared/types/cloudHosts";
import {
  DELETE_ONLY_LOSS,
  formatHourly,
  isDeleteOnly,
  lifetimeLabel,
  lifetimeSentence,
  machineSpecLabel,
  providerStopSentence,
  sentenceCase,
  stoppedBillingSentence,
} from "../cloud/cloudHostLabels";
import type { CloudMachineAccount } from "../cloudWorktreePlacement";

export interface NewMachineChoice {
  form: CloudMachineForm;
  /** Why the machine can't be asked for as the form stands; null when it can. */
  blocked: string | null;
  /** The machine without its name, or null while blocked. */
  machine: () => Omit<CloudHostCreateRequest, "name"> | null;
}

/** The new machine's form for the chosen account, read only while that choice is made. */
export function useNewMachineChoice(
  choice: CloudMachineAccount | null,
  active: boolean
): NewMachineChoice {
  const form = useCloudMachineForm(
    choice?.account ?? null,
    choice?.provider ?? null,
    active && choice !== null
  );
  const blocked =
    choice === null
      ? null
      : (form.catalogError ??
        (form.currentCatalog === null
          ? "Reading the machine sizes…"
          : (form.provisioningProblem ?? form.sizeProblem)));
  const machine = () => {
    const request = form.request("");
    if (!request) return null;
    const { name: _name, ...rest } = request;
    return rest;
  };
  return { form, blocked, machine };
}

/** What the machine costs and when it stops, in a line: who pays, the hourly price, its lifetime. */
function reviewLine(choice: CloudMachineAccount, form: CloudMachineForm): string | null {
  const type = form.chosenType;
  if (!type?.available || !form.currentCatalog) return null;
  const { account, provider } = choice;
  const payer =
    account.billingScope.kind === "personal"
      ? `${account.identity ?? account.displayName}'s personal account`
      : account.billingScope.name;
  const price =
    type.hourlyDollars !== null
      ? `, about $${type.hourlyDollars.toFixed(3)} an hour while it runs`
      : "";
  const lifetimeModel = provider.capabilities.lifetime;
  const lifetime = form.lifetimeChosen
    ? lifetimeModel.kind === "renewable"
      ? form.lifetimeHours === null
        ? "It runs until you stop it."
        : `It stops by itself ${lifetimeLabel(form.lifetimeHours).toLowerCase()} after starting unless it's in use here.`
      : lifetimeSentence(
          lifetimeModel,
          form.lifetimeHours === null ? null : form.lifetimeHours * 3600,
          provider
        )
    : providerStopSentence(lifetimeModel, provider.name, provider.stopMode);
  return [
    `Billed to ${payer} on ${provider.name}${price}.`,
    lifetime,
    isDeleteOnly(provider) ? DELETE_ONLY_LOSS : stoppedBillingSentence(provider),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The dialog's create shortcut, not a way to open a list: Radix opens on any
 * Enter unless the event is already handled, as the Host select does.
 */
function keepCreateShortcut(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.preventDefault();
}

const hintClass = "text-xs leading-4 text-text-secondary";

/**
 * The new machine's size with its price, the provider's own choices (region,
 * image, network, in its words), and its lifetime where the provider takes
 * one: rows under the Host row, in the dialog's own grid.
 */
export function NewMachineRows({
  choice,
  form,
  disabled,
}: {
  choice: CloudMachineAccount;
  form: CloudMachineForm;
  disabled: boolean;
}) {
  const { provider } = choice;
  const catalog = form.currentCatalog;
  const review = reviewLine(choice, form);
  return (
    <>
      {catalog &&
        form.dimensions.map((dimension) => {
          const description = provisioningChoiceDescription(form, dimension);
          return (
            <FormRow
              key={dimension}
              label={catalog.provisioning[dimension]!.label}
              htmlFor={`worktree-machine-${dimension}`}
              hint={description && <p className={hintClass}>{description}</p>}
            >
              <CloudProvisioningSelect
                form={form}
                provider={provider}
                dimension={dimension}
                disabled={disabled}
                id={`worktree-machine-${dimension}`}
                className="h-8 min-w-0"
                data-testid={`worktree-machine-${dimension}`}
                onTriggerKeyDown={keepCreateShortcut}
              />
            </FormRow>
          );
        })}
      <FormRow
        label="Size"
        htmlFor="worktree-machine-size"
        hint={
          (form.provisioningProblem ?? form.sizeProblem) ? (
            <p className={hintClass} data-testid="worktree-machine-problem">
              {form.provisioningProblem ?? form.sizeProblem}
            </p>
          ) : (
            review && (
              <p className={hintClass} data-testid="worktree-machine-review">
                {review}
              </p>
            )
          )
        }
      >
        {form.catalogError ? (
          <Callout
            severity="error"
            size="compact"
            action={
              <Button variant="outline" size="xs" onClick={form.retryCatalog}>
                Retry
              </Button>
            }
          >
            {form.catalogError}
          </Callout>
        ) : catalog === null ? (
          <p className="flex h-8 items-center text-xs text-text-secondary">Reading sizes…</p>
        ) : (
          <Select
            value={form.machineType ?? ""}
            // Typeahead on the closed trigger can land on an unavailable size; it isn't taken.
            onValueChange={(id) => {
              if (form.machineTypes.some((type) => type.id === id && type.available)) {
                form.setMachineType(id);
              }
            }}
            disabled={disabled}
          >
            <SelectTrigger
              id="worktree-machine-size"
              className="h-8 min-w-0"
              data-testid="worktree-machine-size"
              onKeyDown={keepCreateShortcut}
            >
              <SelectValue placeholder="Choose a size" />
            </SelectTrigger>
            <SelectContent>
              {form.machineTypes.map((type) => (
                <SelectItem
                  key={type.id}
                  value={type.id}
                  unavailable={!type.available}
                  description={
                    type.available
                      ? formatHourly(type.hourlyDollars)
                      : sentenceCase(type.reason ?? "Not available on this account")
                  }
                >
                  <FactRun facts={[type.label, machineSpecLabel(type.vcpu, type.memoryGB)]} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormRow>
      {form.lifetimeChosen && (
        <FormRow label="Stops after" htmlFor="worktree-machine-lifetime">
          <Select value={form.lifetime} onValueChange={form.setLifetime} disabled={disabled}>
            <SelectTrigger
              id="worktree-machine-lifetime"
              className="h-8 min-w-0"
              data-testid="worktree-machine-lifetime"
              onKeyDown={keepCreateShortcut}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIFETIME_VALUES.map((value) => (
                <SelectItem key={value} value={value}>
                  {lifetimeLabel(value === "never" ? null : Number(value))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
      )}
    </>
  );
}
