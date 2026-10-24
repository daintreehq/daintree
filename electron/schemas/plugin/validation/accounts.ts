import { z } from "zod";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// A service is named under its provider's id, so no plugin can answer
// calls meant for another; importing one's own service is meaningless.
export function validateServiceNames(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  const ownServicePrefix = `${manifest.name}.`;
  manifest.contributes.services.provides.forEach((entry, index) => {
    if (entry.name.startsWith(ownServicePrefix)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "services", "provides", index, "name"],
      message: `a plugin provides services under its own id: "${entry.name}" must start with "${ownServicePrefix}"`,
      params: { errorCode: "service_name_foreign" },
    });
  });
  manifest.contributes.services.requires.forEach((entry, index) => {
    if (!entry.name.startsWith(ownServicePrefix)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "services", "requires", index, "name"],
      message: "services.requires names other plugins' services; a plugin can't import its own",
      params: { errorCode: "service_requires_self" },
    });
  });
}

// An account exists to reach an online service, and the consent dialog
// and plugin manager disclose that through `network:fetch`. Declaring
// the account without it would hide the plugin's network use.
export function validateAccountConnections(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { capabilities } = context;
  if (manifest.contributes.account !== undefined && manifest.contributes.connections) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "connections"],
      message:
        'Declare contributes.account or contributes.connections, not both — account is shorthand for one connection named "default".',
      params: { errorCode: "account_and_connections" },
    });
  }
  const connectionIds = new Set<string>();
  (manifest.contributes.connections ?? []).forEach((connection, index) => {
    if (connectionIds.has(connection.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "connections", index, "id"],
        message: `Duplicate connection id "${connection.id}".`,
        params: { errorCode: "connection_duplicate_id" },
      });
    }
    connectionIds.add(connection.id);
  });
  if (
    (manifest.contributes.account !== undefined ||
      (manifest.contributes.connections?.length ?? 0) > 0) &&
    !capabilities.has("network:fetch")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "account"],
      message:
        'contributes.account and contributes.connections require the "network:fetch" capability — an account is for an online service, and the capability is how the user is told the plugin reaches the network.',
      params: { errorCode: "account_requires_network_fetch" },
    });
  }
}
