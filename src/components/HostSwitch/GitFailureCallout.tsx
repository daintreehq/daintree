import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Callout } from "@/components/ui/Callout";
import { CopyButton } from "@/components/ui/CopyButton";
import { cn } from "@/lib/utils";
import { CalloutControl } from "./hostCloneForm";

/**
 * A step that failed on a host: what failed and where, then what to do about
 * it, then git's own words for anyone who wants them.
 */
export interface HostGitFailure {
  title: string;
  /** The next step, said first. */
  fix: string;
  /** A plain-language observation behind the failure, in the body's own type. */
  detail?: string | null;
  /** git's output, kept behind a disclosure: secondary, copyable, never the headline. */
  gitText: string | null;
}

export function GitFailureCallout({
  failure,
  action,
}: {
  failure: HostGitFailure;
  /** The control that goes back to the choice that fixes it. */
  action?: React.ReactNode;
}) {
  const [showGit, setShowGit] = useState(false);
  const outputId = useId();
  const outputRef = useRef<HTMLPreElement>(null);

  // git says why it stopped last: open on the end of its output, not the progress chatter.
  useEffect(() => {
    const output = outputRef.current;
    if (showGit && output) output.scrollTop = output.scrollHeight;
  }, [showGit]);

  return (
    <Callout severity="error" role="alert" title={failure.title}>
      <p className="text-text-primary [text-wrap:pretty]">{failure.fix}</p>
      {failure.detail && <p className="mt-1 [text-wrap:pretty]">{failure.detail}</p>}
      {action && <CalloutControl>{action}</CalloutControl>}
      {failure.gitText && (
        <div className="mt-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-expanded={showGit}
              aria-controls={outputId}
              onClick={() => setShowGit((open) => !open)}
              className="-ml-0.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] text-xs text-text-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              <ChevronRight
                aria-hidden="true"
                data-animated-chevron
                className={cn(
                  "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
                  showGit && "rotate-90"
                )}
              />
              Git output
            </button>
            {showGit && (
              <CopyButton text={failure.gitText} size="icon-xs" aria-label="Copy git output" />
            )}
          </div>
          <pre
            ref={outputRef}
            id={outputId}
            hidden={!showGit}
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-secondary select-text"
          >
            {failure.gitText}
          </pre>
        </div>
      )}
    </Callout>
  );
}
