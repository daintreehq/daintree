import type { AgentPreset } from "@/config/agents";

export type ScopeKind = "default" | "custom" | "project" | "ccr";

export function stripCcrPrefix(name: string): string {
  return name.replace(/^CCR:\s*/, "");
}

export function isBoolModified(v: boolean | undefined): boolean {
  return typeof v === "boolean";
}

export function isStringModified(v: string | undefined): boolean {
  return v !== undefined;
}

export function getEffectiveBool(override: boolean | undefined, agentDefault: boolean): boolean {
  return override ?? agentDefault;
}

export function resolveScopeKind(
  selectedPreset: AgentPreset | undefined,
  customPresets: AgentPreset[] | undefined,
  projectPresets: AgentPreset[] | undefined
): {
  scopeKind: ScopeKind;
  selectedIsCustom: boolean;
  selectedIsProject: boolean;
  selectedIsCcr: boolean;
} {
  // A custom preset with the same ID overrides CCR/project in
  // getMergedPresets, so membership in customPresets is the
  // canonical signal for "selected is custom" — prefix-based
  // checks would mis-classify a project preset that happened to
  // start with "user-".
  // Source precedence for display classification (custom > project > CCR):
  // membership checks must beat the ccr- prefix heuristic so that a
  // project preset whose id happens to start with "ccr-" is still
  // surfaced under its true source in the detail view.
  const selectedIsCustom =
    !!selectedPreset && (customPresets ?? []).some((f) => f.id === selectedPreset.id);
  const selectedIsProject =
    !!selectedPreset &&
    !selectedIsCustom &&
    (projectPresets ?? []).some((f) => f.id === selectedPreset.id);
  const selectedIsCcr =
    !!selectedPreset &&
    !selectedIsCustom &&
    !selectedIsProject &&
    selectedPreset.id.startsWith("ccr-");

  const scopeKind: ScopeKind = !selectedPreset
    ? "default"
    : selectedIsCustom
      ? "custom"
      : selectedIsProject
        ? "project"
        : selectedIsCcr
          ? "ccr"
          : "default";

  return { scopeKind, selectedIsCustom, selectedIsProject, selectedIsCcr };
}
