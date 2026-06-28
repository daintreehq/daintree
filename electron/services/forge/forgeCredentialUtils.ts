// eager-import-allow: reads the forgeCredentials store key via store.get inside buildStoredCredentials, invoked from forge provider registration (not at boot)
import { store } from "../../store.js";
import { getRegisteredForgeProviders } from "../forgeProviderRegistry.js";
import { makeForgeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import type { CredentialField, Credentials } from "../../../shared/types/forge.js";

/**
 * Look up a registered provider's declared credential fields by canonical id.
 * Returns `[]` when the provider declares none (or is not registered) — the
 * caller treats that as a single-value credential. Shared with the
 * `forge:set-credential` save path in `forgeSettings.ts` so save-time and
 * replay-time reconstruct credentials from one source of truth.
 */
export function credentialFieldsFor(providerId: string): CredentialField[] {
  const entry = getRegisteredForgeProviders().find(
    (p) => makeForgeProviderId(p.pluginId, p.contribution.id) === providerId
  );
  return entry?.contribution.credentialFields ?? [];
}

/**
 * Pick the primary credential value from a stored record. A provider may
 * declare multiple {@link CredentialField}s for the settings form, but the
 * contract passes exactly one value — the primary — to
 * {@link ForgeProviderImpl.validateToken} and `setCredentials`. The primary is
 * the first `"password"`-typed declared field, else the first declared field;
 * with no declared fields, the first record value. Shared with the
 * `forge:set-credential` save path in `forgeSettings.ts` so save-time and
 * replay-time agree on the value.
 */
export function pickPrimaryValue(
  fields: CredentialField[],
  credentials: Record<string, string>
): string {
  if (fields.length > 0) {
    const primary = fields.find((f) => f.type === "password") ?? fields[0];
    return credentials[primary.id] ?? "";
  }
  const first = Object.values(credentials)[0];
  return typeof first === "string" ? first : "";
}

/**
 * Reconstruct the {@link Credentials} object persisted for a provider so the
 * host can replay it into a freshly bound impl via `setCredentials`. Reads the
 * durable `forgeCredentials` store entry (a `JSON.stringify`'d
 * `Record<string,string>`), extracts the primary value, and wraps it as a
 * bearer credential — the same shape `syncWorkspaceCredential` constructs at
 * save time. Returns `null` when no credential is stored, the record is
 * malformed, or the primary value is empty.
 */
export function buildStoredCredentials(providerId: string): Credentials | null {
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  const map = store.get("forgeCredentials") ?? {};
  const raw = map[providerId];
  if (!raw) return null;

  let record: Record<string, string>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    record = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") record[k] = v;
    }
  } catch {
    return null;
  }

  const value = pickPrimaryValue(credentialFieldsFor(providerId), record).trim();
  if (value.length === 0) return null;
  return { kind: "bearer", value };
}
