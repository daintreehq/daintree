import { useEffect, useState } from "react";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import {
  CLOUD_LIFETIME_CHOICES,
  DEFAULT_CLOUD_LIFETIME_HOURS,
  cloudLifetimeIsChosen,
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
  machineType: string | null;
  setMachineType: (id: string) => void;
  chosenType: CloudMachineType | null;
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
  const [machineType, setMachineType] = useState<string | null>(null);
  const [lifetime, setLifetime] = useState(String(DEFAULT_CLOUD_LIFETIME_HOURS));
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
        if (!current) return;
        setCatalog(next);
        const preferred =
          next.machineTypes.find((type) => type.id === "default" && type.available) ??
          next.machineTypes.find((type) => type.available) ??
          null;
        setMachineType((chosen) =>
          chosen && next.machineTypes.some((type) => type.id === chosen && type.available)
            ? chosen
            : (preferred?.id ?? null)
        );
      },
      (err: unknown) => {
        if (current) setCatalogError(errorText(err, "Couldn't read the machine sizes"));
      }
    );
    return () => {
      current = false;
    };
  }, [accountKey, enabled, catalogTry]);

  const chosenType = catalog?.machineTypes.find((type) => type.id === machineType) ?? null;
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
  // Only a provider that holds a machine to a deadline takes one; the rest are sent none,
  // whatever the selector held for the last account.
  const lifetimeChosen = provider !== null && cloudLifetimeIsChosen(provider.capabilities.lifetime);
  const lifetimeHours = lifetimeChosen && lifetime !== "never" ? Number(lifetime) : null;

  const pick = (dimension: CloudProvisioningDimension, id: string | null) => {
    if (!currentCatalog) return;
    setPicked({
      accountId: currentCatalog.accountId,
      selection: { ...provisioning, [dimension]: id },
    });
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
    machineType,
    setMachineType,
    chosenType,
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
