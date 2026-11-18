/**
 * Permission intent for a scope. `"on"` (Skip all) and `"off"` (the CLI's
 * default) are explicit choices; `"auto"` asks for the agent's own automatic
 * approval mode (#17435), where its registry declares one; `"inherit"` defers
 * to the next level up (preset → agent → global). Modeled after VS Code
 * workspace-vs-user override and IAM explicit-deny precedence: a more-specific
 * `"off"` or `"auto"` always beats a broader `"on"` (principle of least
 * privilege).
 *
 * Dependency-free so the registry, the action schemas and the config-bundle
 * validator can read it without the settings module's registry imports.
 */
export const DANGEROUS_MODES = ["inherit", "on", "off", "auto"] as const;

export type DangerousMode = (typeof DANGEROUS_MODES)[number];

export function isDangerousMode(value: unknown): value is DangerousMode {
  return typeof value === "string" && (DANGEROUS_MODES as readonly string[]).includes(value);
}
