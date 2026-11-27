import type { ScopeKind } from "./scopeUtils";
import { Badge } from "@/components/ui/badge";

/**
 * Where the preset being edited comes from, beside the edit row's label. The agent's own
 * default has no chip: it is the baseline, not a source. One word per source, and the
 * same word the picker's trigger uses.
 */
export function ScopeBadge({ scopeKind }: { scopeKind: ScopeKind }) {
  if (scopeKind === "default") return null;
  const { label, testid } =
    scopeKind === "custom"
      ? { label: "Custom", testid: "preset-badge-custom" }
      : scopeKind === "project"
        ? { label: "Project · read-only", testid: "preset-badge-project" }
        : { label: "CCR · read-only", testid: "preset-badge-auto" };
  return (
    <Badge size="xs" data-testid={testid}>
      {label}
    </Badge>
  );
}

/**
 * What the rows under the edit picker are editing, and whether it is also what new
 * sessions launch with. Looking at a preset never changes the launch preset; the
 * Launch preset row does.
 */
export function describeScope(
  scopeKind: ScopeKind,
  agentName: string,
  isLaunchPreset: boolean
): string {
  const launch = isLaunchPreset
    ? `New ${agentName} sessions launch with it.`
    : "It isn't the launch preset; choose that above.";
  switch (scopeKind) {
    case "default":
      return `The agent's own settings, below. ${launch}`;
    case "custom":
      return `The settings below edit this preset; anything left on Default follows the agent's own settings. ${launch}`;
    case "project":
      return `Shared by everyone who opens this project, so read-only here. ${launch}`;
    case "ccr":
      return `A Claude Code Router route, read-only here. ${launch}`;
  }
}
