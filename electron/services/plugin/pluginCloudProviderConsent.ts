import crypto from "node:crypto";
import type { CloudProviderContribution } from "../../../shared/types/pluginCloudProvider.js";

/** The origin an account is tied to: a manifest that adds or drops a trailing slash names the same one. */
export function canonicalCloudOrigin(apiUrl: string): string {
  try {
    return new URL(apiUrl).origin;
  } catch {
    return apiUrl;
  }
}

/** Object keys in one order and absent values left out, so equal declarations hash equally. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(record[key])])
    );
  }
  return value;
}

/**
 * What a person agrees to when a plugin's cloud provider first gets an account
 * (#17352): every provider the plugin declares, as far as each decides what
 * happens to the credentials and the machines. That is the credentials asked
 * for, the capabilities (how a machine's identity is vouched for, the tunnel,
 * what a stop keeps, deletion), the origin credentials are tied to, and
 * whether a lost create may be sent again. Names, descriptions and links are
 * left out, so an update that only rewords asks nothing again; one that
 * adds, drops or changes a provider does.
 */
export function pluginCloudConsentFingerprint(
  entries: ReadonlyArray<{ providerId: string; contribution: CloudProviderContribution }>
): string {
  const subject = [...entries]
    .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))
    .map(({ providerId, contribution }) => ({
      providerId,
      apiOrigin: canonicalCloudOrigin(contribution.apiUrl),
      credentialFields: contribution.credentialFields,
      capabilities: contribution.capabilities,
      createReplay: contribution.createReplay ?? "same-key",
    }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical({ version: 1, providers: subject })))
    .digest("hex");
}
