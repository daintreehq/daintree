import type { ProjectMatchCandidate } from "@shared/types/ipc/projectMatch";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { candidateRelation } from "./hostSwitchModel";

function describeCandidate(
  candidate: ProjectMatchCandidate,
  sourceRemotes: Array<{ name: string; url: string }>
): string {
  const parts: string[] = [candidate.path];
  const relation = candidateRelation(candidate, sourceRemotes);
  if (relation) parts.push(relation);
  if (candidate.source === "on-disk") parts.push("Not a project yet");
  if (candidate.matchedBy === "committed-id") parts.push("Same project id, different remotes");
  const remotes = candidate.remotes.map((r) => `${r.name}: ${r.url}`).join(", ");
  if (remotes) parts.push(remotes);
  if (candidate.lastOpenedAt) {
    parts.push(
      candidate.source === "on-disk"
        ? `Changed ${formatRelativeTime(candidate.lastOpenedAt)}`
        : `Last opened ${formatRelativeTime(candidate.lastOpenedAt)}`
    );
  }
  return parts.join(" · ");
}

/**
 * The copies of the repository a host already has, most recently used
 * first. With one there's nothing to choose, so it is simply named.
 */
export function ProjectMatchChooser({
  candidates,
  sourceRemotes,
  selected,
  onSelect,
  disabled,
}: {
  candidates: ProjectMatchCandidate[];
  sourceRemotes: Array<{ name: string; url: string }>;
  selected: number;
  onSelect: (index: number) => void;
  disabled?: boolean;
}) {
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return (
      <div className="space-y-1">
        <p className="text-sm text-text-primary">
          {only.source === "on-disk"
            ? `A clone of this repository is on the host, not yet added as a project.`
            : `The host already has ${only.name}.`}
        </p>
        <p className="text-xs text-text-secondary break-all">
          {describeCandidate(only, sourceRemotes)}
        </p>
      </div>
    );
  }
  return (
    <RadioChoiceGroup legend="Which copy to open">
      {candidates.map((candidate, index) => (
        <RadioChoiceRow
          key={`${candidate.source}:${candidate.path}`}
          name="host-switch-candidate"
          value={candidate.path}
          checked={selected === index}
          onChange={() => onSelect(index)}
          label={candidate.name}
          description={describeCandidate(candidate, sourceRemotes)}
          disabled={disabled}
        />
      ))}
    </RadioChoiceGroup>
  );
}
