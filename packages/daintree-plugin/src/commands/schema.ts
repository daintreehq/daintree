import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getPluginManifestSchema } from "../../../../electron/schemas/plugin.js";

export interface SchemaOptions {
  /** Emit the project-plugin schema rather than the installed-plugin one. */
  project?: boolean;
  /** Write to this file instead of stdout. */
  out?: string;
}

/**
 * Emit the JSON Schema for `plugin.json`, derived from the same Zod schema the
 * host loads with, so an author points an editor at the contract instead of at
 * the prose describing it.
 *
 * Structural only: `z.toJSONSchema` drops refinement closures, so every
 * cross-field rule the manifest schema enforces at load — a view's id matching
 * a panel's, the contribution types a project plugin may not use — is absent
 * here by construction. The description says so, because a manifest that passes
 * an editor's check and is still refused otherwise reads as a host bug.
 *
 * Returns the path written, or null when the schema went to stdout.
 */
export async function runSchema(opts: SchemaOptions = {}): Promise<string | null> {
  const schema = z.toJSONSchema(getPluginManifestSchema(opts.project ? "project" : "user"), {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  }) as Record<string, unknown>;

  const { $schema, ...body } = schema;
  const document = {
    $schema: $schema ?? "https://json-schema.org/draft/2020-12/schema",
    title: opts.project ? "Daintree project plugin manifest" : "Daintree plugin manifest",
    description:
      "Structural rules only — the cross-field rules the host enforces at load (a view's id matching a declared panel's, the contribution types refused under project scope, the reserved daintree.* namespace) cannot be expressed in JSON Schema and are not encoded here.",
    ...body,
  };

  const serialized = JSON.stringify(document, null, 2) + "\n";
  if (!opts.out) {
    process.stdout.write(serialized);
    return null;
  }
  const target = path.resolve(opts.out);
  await fs.writeFile(target, serialized, "utf8");
  return target;
}
