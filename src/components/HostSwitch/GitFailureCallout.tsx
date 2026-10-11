import { Callout } from "@/components/ui/Callout";

/** A git step that failed on a host: what failed, git's own words, and the fix when one is known. */
export interface HostGitFailure {
  title: string;
  gitText: string;
  fix: string | null;
}

export function GitFailureCallout({ failure }: { failure: HostGitFailure }) {
  return (
    <Callout severity="error" role="alert" title={failure.title}>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-secondary select-text">
        {failure.gitText}
      </pre>
      {failure.fix && <p className="mt-2 text-sm text-text-primary">{failure.fix}</p>}
    </Callout>
  );
}
