import {
  CLOUD_PROVISIONING_DIMENSIONS,
  cloudChoiceFitsLocation,
  cloudProvisioningNoun,
  type CloudCatalog,
  type CloudProviderInfo,
  type CloudProvisioningChoice,
  type CloudProvisioningDimension,
  type CloudProvisioningSelection,
} from "@shared/types/cloudHosts";

export const NO_PROVISIONING: CloudProvisioningSelection = {
  location: null,
  image: null,
  network: null,
};

/** The dimensions a create shows a control for: what the provider takes and its catalog lists. */
export function shownDimensions(
  provider: CloudProviderInfo,
  catalog: CloudCatalog
): CloudProvisioningDimension[] {
  return CLOUD_PROVISIONING_DIMENSIONS.filter(
    (dimension) =>
      provider.capabilities.provisioning[dimension] !== "none" &&
      catalog.provisioning[dimension] !== null
  );
}

/** What a dimension offers with the location chosen so far. */
export function choicesFor(
  catalog: CloudCatalog,
  dimension: CloudProvisioningDimension,
  location: string | null
): CloudProvisioningChoice[] {
  const options = catalog.provisioning[dimension];
  if (!options) return [];
  return dimension === "location"
    ? options.choices
    : options.choices.filter((choice) => cloudChoiceFitsLocation(choice, location));
}

/**
 * What the controls show, a dimension at a time so an image or network
 * follows the location: the first of `preferred` (the person's picks in this
 * dialog, then the account's last choice) that still holds, then the
 * provider's suggestion, then for a required dimension the first choice that
 * can be used. An optional one otherwise starts as the provider's call.
 * Every value lands in a visible control before Create; nothing is filled
 * in on submit.
 */
export function startingSelection(
  provider: CloudProviderInfo,
  catalog: CloudCatalog,
  preferred: (CloudProvisioningSelection | null)[]
): CloudProvisioningSelection {
  const selection = { ...NO_PROVISIONING };
  for (const dimension of shownDimensions(provider, catalog)) {
    const required = provider.capabilities.provisioning[dimension] === "required";
    const choices = choicesFor(catalog, dimension, selection.location);
    const usable = (id: string | null) =>
      id === null ? !required : choices.some((choice) => choice.id === id && choice.available);
    const wanted = preferred.find((source) => source !== null && usable(source[dimension]));
    if (wanted) {
      selection[dimension] = wanted[dimension];
      continue;
    }
    const suggested = catalog.provisioning[dimension]!.defaultId;
    if (suggested !== null && usable(suggested)) selection[dimension] = suggested;
    else if (required)
      selection[dimension] = choices.find((choice) => choice.available)?.id ?? null;
  }
  return selection;
}

/** Why Create can't go ahead with this selection; null when it can. */
export function selectionProblem(
  provider: CloudProviderInfo,
  catalog: CloudCatalog,
  selection: CloudProvisioningSelection
): string | null {
  for (const dimension of shownDimensions(provider, catalog)) {
    if (provider.capabilities.provisioning[dimension] !== "required") continue;
    if (selection[dimension] !== null) continue;
    const noun = cloudProvisioningNoun(catalog.provisioning[dimension]!.label);
    const location = catalog.provisioning.location?.choices.find(
      (choice) => choice.id === selection.location
    );
    return dimension !== "location" && location
      ? `${provider.name} offers this account no ${noun} in ${location.label}. Choose another ${cloudProvisioningNoun(catalog.provisioning.location!.label)}.`
      : `${provider.name} offers this account no ${noun} to create a machine with.`;
  }
  return null;
}
