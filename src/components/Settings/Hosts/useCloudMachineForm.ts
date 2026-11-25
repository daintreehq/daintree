import { useEffect, useState } from "react";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import {
  CLOUD_LIFETIME_CHOICES,
  DEFAULT_CLOUD_LIFETIME_HOURS,
  cloudLifetimeIsChosen,
  cloudMachineTypeLocationReason,
  type CloudAccountSummary,
  type CloudCatalog,
  type CloudHostCreateRequest,
  type CloudMachineType,
  type CloudProviderInfo,
  type CloudProvisioningDimension,
  type CloudProvisioningSelection,
} from "@shared/types/cloudHosts";
import {
  NO_PROVISIONING,
  selectionProblem,
  shownDimensions,
  startingSelection,
} from "./cloudProvisioningChoices";

/** The lifetime selector's values: hours as text, or "never". */
export const LIFETIME_VALUES = CLOUD_LIFETIME_CHOICES.map((hours) =>
  hours === null ? "never" : String(hours)
);

/** Where a new machine's lifetime selector starts for this provider. */
function defaultLifetime(provider: CloudProviderInfo | null): string {
  const hours =
    provider?.defaultLifetimeHours !== undefined
      ? provider.defaultLifetimeHours
      : DEFAULT_CLOUD_LIFETIME_HOURS;
  return hours === null ? "never" : String(hours);
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

export interface CloudMachineForm {
  /** The catalog last read; null while it loads. */
  catalog: CloudCatalog | null;
  /** The catalog only when it is the chosen account's: what a create is checked against. */
  currentCatalog: CloudCatalog | null;
  catalogError: string | null;
  retryCatalog: () => void;
  /**
   * The current catalog's sizes, each unavailable with the reason when it
   * can't be created in the location chosen; empty while no current catalog.
   */
  machineTypes: CloudMachineType[];
  machineType: string | null;
  setMachineType: (id: string) => void;
  chosenType: CloudMachineType | null;
  /** Why the size can't be created as it stands; null when it can or the catalog is still loading. */
  sizeProblem: string | null;
  /** The lifetime selector's value: hours as a string, or "never". */
  lifetime: string;
  setLifetime: (value: string) => void;
  /** Whether the provider takes a lifetime with a create at all. */
  lifetimeChosen: boolean;
  lifetimeHours: number | null;
  /** The provisioning controls shown, in order. */
  dimensions: CloudProvisioningDimension[];
  provisioning: CloudProvisioningSelection;
  /** Why the provisioning can't be created as it stands; null when it can. */
  provisioningProblem: string | null;
  pick: (dimension: CloudProvisioningDimension, id: string | null) => void;
  /** The create as the form stands, or null while it can't be sent. */
  request: (name: string) => CloudHostCreateRequest | null;
}

/**
 * A new machine's size, lifetime and provisioning for one account, read from
 * that account's catalog: the part of a cloud create every surface shares.
 * Reading the catalog never creates or starts anything. `enabled` false stops
 * reading (the machine was already asked for, or nothing shows the form).
 */
export function useCloudMachineForm(
  account: CloudAccountSummary | null,
  provider: CloudProviderInfo | null,
  enabled = true
): CloudMachineForm {
  /**
   * The size each account has, once the person picked one or changed what it
   * runs on: until then it follows where the account starts.
   */
  const [pickedTypes, setPickedTypes] = useState<Readonly<Record<string, string>>>({});
  /** What the person picked, for the provider they picked it for: another provider starts at its own default. */
  const [pickedLifetime, setPickedLifetime] = useState<{
    providerId: string;
    value: string;
  } | null>(null);
  /** What the person picked here, for the account they picked it for. */
  const [picked, setPicked] = useState<{
    accountId: string;
    selection: CloudProvisioningSelection;
  } | null>(null);
  const [catalog, setCatalog] = useState<CloudCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // Bumped by Retry: reads again without touching what's been filled in.
  const [catalogTry, setCatalogTry] = useState(0);
  const accountKey = account?.id ?? null;

  useEffect(() => {
    if (!accountKey || !enabled) return;
    let current = true;
    setCatalog(null);
    setCatalogError(null);
    cloudHostsClient.getCatalog(accountKey).then(
      (next) => {
        if (current) setCatalog(next);
      },
      (err: unknown) => {
        if (current) setCatalogError(errorText(err, "Couldn't read the machine sizes"));
      }
    );
    return () => {
      current = false;
    };
  }, [accountKey, enabled, catalogTry]);

  // A catalog still on screen from the account picked before isn't this account's.
  const currentCatalog = catalog && account && catalog.accountId === account.id ? catalog : null;
  const dimensions = currentCatalog && provider ? shownDimensions(provider, currentCatalog) : [];
  const provisioning =
    currentCatalog && provider
      ? startingSelection(provider, currentCatalog, [
          picked?.accountId === currentCatalog.accountId ? picked.selection : null,
          currentCatalog.lastChoice,
        ])
      : NO_PROVISIONING;
  const provisioningProblem =
    currentCatalog && provider ? selectionProblem(provider, currentCatalog, provisioning) : null;
  const locationOptions = currentCatalog?.provisioning.location ?? null;
  const machineTypes = (currentCatalog?.machineTypes ?? []).map((type) => {
    // The account's own reason comes first: it holds wherever the machine runs.
    if (!type.available) return type;
    const reason = cloudMachineTypeLocationReason(type, locationOptions, provisioning.location);
    return reason === null ? type : { ...type, available: false, reason };
  });
  // A size is kept when the location changes under it, shown unavailable rather than swapped
  // for another at another price; until then, the first size the starting location can take.
  const pickedId = currentCatalog ? pickedTypes[currentCatalog.accountId] : undefined;
  const pickedSize =
    pickedId === undefined ? undefined : machineTypes.find((type) => type.id === pickedId);
  const chosenType =
    pickedSize ??
    machineTypes.find((type) => type.id === "default" && type.available) ??
    machineTypes.find((type) => type.available) ??
    null;
  const machineType = chosenType?.id ?? null;
  const sizeProblem = !currentCatalog
    ? null
    : chosenType === null
      ? "Choose a machine size."
      : chosenType.available
        ? null
        : `${chosenType.label} isn't available: ${chosenType.reason ?? "not on this account"}.`;
  const setMachineType = (id: string) => {
    if (!currentCatalog) return;
    const accountId = currentCatalog.accountId;
    setPickedTypes((current) => ({ ...current, [accountId]: id }));
  };
  // Only a provider that holds a machine to a deadline takes one; the rest are sent none,
  // whatever the selector held for the last account.
  const lifetime =
    pickedLifetime && provider && pickedLifetime.providerId === provider.id
      ? pickedLifetime.value
      : defaultLifetime(provider);
  const setLifetime = (value: string) => {
    if (provider) setPickedLifetime({ providerId: provider.id, value });
  };
  const lifetimeChosen = provider !== null && cloudLifetimeIsChosen(provider.capabilities.lifetime);
  const lifetimeHours = lifetimeChosen && lifetime !== "never" ? Number(lifetime) : null;

  const pick = (dimension: CloudProvisioningDimension, id: string | null) => {
    if (!currentCatalog) return;
    const accountId = currentCatalog.accountId;
    setPicked({ accountId, selection: { ...provisioning, [dimension]: id } });
    // The size on screen stays put: choosing it again picked nothing a control could see.
    if (pickedId === undefined && machineType !== null) {
      const shown = machineType;
      setPickedTypes((current) => ({ ...current, [accountId]: shown }));
    }
  };

  const request = (name: string): CloudHostCreateRequest | null => {
    if (!account || !machineType || !currentCatalog || provisioningProblem) return null;
    if (!chosenType?.available) return null;
    return {
      accountId: account.id,
      name,
      machineType,
      lifetimeHours,
      // Only for a provider that takes any, so Boat's request is what it always was.
      ...(dimensions.length > 0 ? { provisioning } : {}),
    };
  };

  return {
    catalog,
    currentCatalog,
    catalogError,
    retryCatalog: () => setCatalogTry((n) => n + 1),
    machineTypes,
    machineType,
    setMachineType,
    chosenType,
    sizeProblem,
    lifetime,
    setLifetime,
    lifetimeChosen,
    lifetimeHours,
    dimensions,
    provisioning,
    provisioningProblem,
    pick,
    request,
  };
}
