import type { ScopeKind } from "./scopeUtils";

/**
 * Where the selected preset comes from, beside the preset row's label. The agent's own
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
    <span
      data-testid={testid}
      className="rounded-[var(--radius-sm)] bg-overlay-subtle px-1.5 py-0.5 text-2xs text-text-secondary"
    >
      {label}
    </span>
  );
}

/**
 * What choosing this preset means. Picking a preset here is not "open it for editing":
 * it is the preset the agent launches with, so the description says that first and
 * then says what the rows below it edit.
 */
export function describeScope(scopeKind: ScopeKind, agentName: string): string {
  switch (scopeKind) {
    case "default":
      return `New ${agentName} sessions launch with the agent's own settings, below. A worktree can still pick a preset of its own`;
    case "custom":
      return `New ${agentName} sessions launch with this preset. The settings below edit it; anything left on Default follows the agent's own settings`;
    case "project":
      return `New ${agentName} sessions launch with this preset, which this project shares with everyone who opens it`;
    case "ccr":
      return `New ${agentName} sessions launch through this Claude Code Router route`;
  }
}
