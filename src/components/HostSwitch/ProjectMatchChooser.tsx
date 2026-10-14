import type { ProjectMatchCandidate } from "@shared/types/ipc/projectMatch";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { Callout } from "@/components/ui/Callout";
import { PathSegments } from "@/components/ui/PathSegments";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { candidateRelation } from "./hostSwitchModel";

type Remote = { name: string; url: string };

const WarningGlyph = SEVERITY_GLYPH.warning;

/**
 * The folders every copy's path starts with, ending at a separator, so the
 * part that tells copies apart can be drawn stronger than the part they share.
 * Whole folders only: `daintree` and `daintree-worktrees` share no folder.
 */
function sharedFolderPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  const split = paths.map((p) => p.split(/(?<=[/\\])/));
  let count = 0;
  while (
    split.every((segments) => count < segments.length - 1 && segments[count] === split[0]![count])
  ) {
    count++;
  }
  return split[0]!.slice(0, count).join("");
}

/**
 * The folder is what tells same-named copies apart, so it gets its own line in
 * full, with the folders all the copies share stepped down a tone. `PathSegments`
 * breaks only between folders; Chromium would read those segments with spaces
 * between them, so the description gets the path as one plain string and the
 * drawn one is hidden from it.
 */
function CandidatePath({ path, sharedPrefix = "" }: { path: string; sharedPrefix?: string }) {
  const shared = sharedPrefix && path.startsWith(sharedPrefix) ? sharedPrefix : "";
  return (
    <span className="block font-mono text-text-primary">
      <span className="sr-only select-none">{path}</span>
      <span aria-hidden="true">
        {shared && (
          <span className="text-text-secondary">
            <PathSegments path={shared} />
          </span>
        )}
        <PathSegments path={path.slice(shared.length)} />
      </span>
    </span>
  );
}

/**
 * What sets this copy apart from a routine match: a shared project id with no
 * shared remote (it may not be this repository), or a folder that would be
 * added as a project. Shape and words carry the warning; colour only repeats it.
 */
function CandidateNotice({
  candidate,
  sentenceSaysIt,
}: {
  candidate: ProjectMatchCandidate;
  /** The single-copy sentence already states it, so only the consequence is left. */
  sentenceSaysIt?: boolean;
}) {
  if (candidate.matchedBy === "committed-id" && !sentenceSaysIt) {
    return (
      <span className="mt-1 flex items-start gap-1.5 text-text-primary">
        <WarningGlyph
          className="mt-0.5 h-3 w-3 shrink-0 text-status-warning"
          aria-hidden="true"
          data-severity-glyph=""
        />
        <span>Same project id, different remotes. It may be a different repository.</span>
      </span>
    );
  }
  if (candidate.source === "on-disk") {
    return (
      <span className="mt-1 block text-text-primary">
        {sentenceSaysIt
          ? "Using it adds it as a project."
          : "Not a project yet. Using this folder adds it as a project."}
      </span>
    );
  }
  return null;
}

/** Supporting detail: which of your remotes it shares, when it was used, and its remotes. */
function CandidateDetails({
  candidate,
  sourceRemotes,
}: {
  candidate: ProjectMatchCandidate;
  sourceRemotes: Remote[];
}) {
  const relation = candidateRelation(candidate, sourceRemotes);
  const age = candidate.lastOpenedAt;
  return (
    <>
      {(relation || age !== null) && (
        <span className="mt-1 block">
          {relation}
          {relation && age !== null && " · "}
          {age !== null && (
            <TimeAgo
              timestamp={age}
              verbose
              prefix={candidate.source === "on-disk" ? "Changed " : "Last opened "}
            />
          )}
        </span>
      )}
      {candidate.remotes.length > 0 && (
        // Name beside URL while there's room; stacked once the URL column would
        // be too narrow to read, so supporting detail never outgrows the path.
        <span className="@container mt-1 block">
          <span className="grid grid-cols-1 @sm:grid-cols-[auto_minmax(0,1fr)] @sm:gap-x-2">
            {candidate.remotes.map((remote) => (
              <span key={remote.name} className="contents">
                <span className="[overflow-wrap:anywhere] @sm:max-w-32">{remote.name}</span>
                <span className="mb-0.5 font-mono [overflow-wrap:anywhere] @sm:mb-0">
                  {remote.url}
                </span>
              </span>
            ))}
          </span>
        </span>
      )}
    </>
  );
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
  hostName,
}: {
  /** The host the copies are on, as the dialog names it. */
  hostName: string;
  candidates: ProjectMatchCandidate[];
  sourceRemotes: Remote[];
  selected: number;
  onSelect: (index: number) => void;
  disabled?: boolean;
}) {
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return (
      <div className="space-y-3">
        {only.matchedBy === "committed-id" && only.source !== "on-disk" ? (
          <Callout severity="warning" className="text-sm">
            {hostName} has a project with the same project id but none of the same remotes. It may
            be a different repository.
          </Callout>
        ) : (
          <p className="text-sm text-text-primary">
            {only.source === "on-disk"
              ? `${hostName} has a clone of this repository that isn't added as a project yet.`
              : `${hostName} already has this project.`}
          </p>
        )}
        <div className="text-xs text-text-secondary">
          <p className="text-sm font-medium text-text-primary">{only.name}</p>
          <CandidatePath path={only.path} />
          <CandidateNotice candidate={only} sentenceSaysIt />
          <CandidateDetails candidate={only} sourceRemotes={sourceRemotes} />
        </div>
      </div>
    );
  }
  const sharedPrefix = sharedFolderPrefix(candidates.map((c) => c.path));
  return (
    <RadioChoiceGroup legend={`Which copy on ${hostName} to open`}>
      {candidates.map((candidate, index) => (
        <RadioChoiceRow
          key={`${candidate.source}:${candidate.path}`}
          name="host-switch-candidate"
          value={candidate.path}
          checked={selected === index}
          onChange={() => onSelect(index)}
          label={candidate.name}
          description={
            <>
              <CandidatePath path={candidate.path} sharedPrefix={sharedPrefix} />
              <CandidateNotice candidate={candidate} />
            </>
          }
          details={<CandidateDetails candidate={candidate} sourceRemotes={sourceRemotes} />}
          disabled={disabled}
        />
      ))}
    </RadioChoiceGroup>
  );
}
